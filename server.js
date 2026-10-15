'use strict';

/**
 * Calculadora Laboral — despliegue único
 *
 *   /        → Calculadora de Finiquito (Consultores Donceles) — pública
 *   /baugh/  → Calculadora de Finiquito Baugh (Baugh Abogados) — solo equipo
 *
 * Acceso a /baugh/ por dos vías:
 *   1. Usuario de El Castillo: la persona elige su nombre, escribe su PIN y El Castillo
 *      confirma que tiene permiso para la app "calculadora" (mismo esquema que las demás
 *      apps del despacho: /api/usuarios-selector, /api/pin/*, /api/permiso con x-api-key).
 *   2. Contraseña del equipo (BAUGH_PASSWORD), como respaldo.
 *
 * Variables de entorno (Railway):
 *   PORT               lo asigna Railway
 *   SESSION_SECRET     obligatorio — cadena aleatoria de 32+ caracteres para firmar la cookie
 *   CASTILLO_URL       URL de El Castillo, p. ej. https://el-castillo-production.up.railway.app
 *   CASTILLO_API_KEY   la misma CASTILLO_API_KEY configurada en El Castillo
 *   CASTILLO_APP_KEY   clave de la app en El Castillo (por defecto "calculadora")
 *   BAUGH_PASSWORD     contraseña del equipo (si falta, solo se entra con El Castillo)
 *   SESSION_HOURS      duración de la sesión en horas (por defecto 12)
 *   DATA_DIR           carpeta de las estadísticas; en Railway, la ruta del volumen (p. ej. /data)
 *   GA_ID              ID de medición de Google Analytics (G-XXXXXXX); vacío = sin Google Analytics
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const estadisticas = require('./estadisticas');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const BAUGH_PASSWORD = process.env.BAUGH_PASSWORD || '';
// Acepta la dirección de El Castillo aunque venga sin https://, con /admin u otra ruta,
// con / al final, con espacios o entre comillas: se queda solo con el origen.
function normalizarUrl(raw) {
  let s = String(raw || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try { return new URL(s).origin; } catch (e) { return ''; }
}
const CASTILLO_URL = normalizarUrl(process.env.CASTILLO_URL);
const CASTILLO_API_KEY = String(process.env.CASTILLO_API_KEY || '').trim().replace(/^["']+|["']+$/g, '');
const CASTILLO_APP_KEY = process.env.CASTILLO_APP_KEY || 'calculadora';
const CASTILLO_ACTIVO = !!(CASTILLO_URL && CASTILLO_API_KEY);
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 12;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const COOKIE_NAME = 'baugh_sesion';

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  if (IS_PROD) console.error('Falta SESSION_SECRET (mínimo 32 caracteres). La ruta /baugh/ queda cerrada.');
  else console.warn('SESSION_SECRET no configurado: usando uno temporal solo para desarrollo.');
}
const SECRET = SESSION_SECRET.length >= 32 ? SESSION_SECRET : (IS_PROD ? null : crypto.randomBytes(32).toString('hex'));
if (!CASTILLO_ACTIVO) console.warn('CASTILLO_URL / CASTILLO_API_KEY no configurados: la entrada con usuario de El Castillo queda desactivada.');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------- utilidades ----------
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (str) => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// ---------- sesión (cookie firmada, sin base de datos) ----------
function crearSesion(res, datos) {
  const payload = { ...datos, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(body).digest());
  res.setHeader('Set-Cookie', [
    `${COOKIE_NAME}=${body}.${sig}; Path=/baugh; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${IS_PROD ? '; Secure' : ''}`,
  ]);
}

function leerSesion(req) {
  if (!SECRET) return null;
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw || !raw.includes('.')) return null;
  const [body, sig] = raw.split('.');
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(body).digest());
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function borrarSesion(res) {
  res.setHeader('Set-Cookie', [`${COOKIE_NAME}=; Path=/baugh; HttpOnly; SameSite=Lax; Max-Age=0${IS_PROD ? '; Secure' : ''}`]);
}

// ---------- cliente de El Castillo ----------
async function castillo(pathname, { method = 'GET', body, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${CASTILLO_URL}/api${pathname}`, {
      method,
      headers: { 'x-api-key': CASTILLO_API_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function nivelPermiso(usuarioId) {
  const r = await castillo(`/permiso?usuario_id=${encodeURIComponent(usuarioId)}&app=${encodeURIComponent(CASTILLO_APP_KEY)}`);
  if (!r.ok) throw new Error(`El Castillo respondió ${r.status} al consultar permiso`);
  return r.data.nivel || 'ninguno';
}

// Revalida el permiso como máximo una vez cada 5 minutos por usuario, para que
// quitar el permiso en El Castillo saque a la persona sin esperar a que venza su sesión.
const permisoCache = new Map(); // usuario_id -> { nivel, hasta }
async function sigueAutorizado(usuarioId) {
  const c = permisoCache.get(usuarioId);
  if (c && c.hasta > Date.now()) return c.nivel !== 'ninguno';
  try {
    const nivel = await nivelPermiso(usuarioId);
    permisoCache.set(usuarioId, { nivel, hasta: Date.now() + 5 * 60 * 1000 });
    return nivel !== 'ninguno';
  } catch (e) {
    // Si El Castillo no responde, se respeta la sesión vigente en vez de dejar fuera al equipo.
    console.warn('No se pudo revalidar el permiso en El Castillo:', e.message);
    return true;
  }
}

// ---------- límite de intentos (por IP y por usuario) ----------
const intentos = new Map(); // clave -> { n, hasta }
const MAX_INTENTOS = 5;
const VENTANA_MS = 15 * 60 * 1000;
function bloqueado(...claves) {
  return claves.some((k) => {
    const r = intentos.get(k);
    return r && r.n >= MAX_INTENTOS && r.hasta > Date.now();
  });
}
function registrarFallo(...claves) {
  claves.forEach((k) => {
    const r = intentos.get(k);
    if (!r || r.hasta < Date.now()) intentos.set(k, { n: 1, hasta: Date.now() + VENTANA_MS });
    else r.n += 1;
  });
}
function limpiarFallos(...claves) { claves.forEach((k) => intentos.delete(k)); }

// ---------- cabeceras de seguridad ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ---------- configuración pública para el navegador (Google Analytics) ----------
const GA_ID = /^G-[A-Z0-9]{4,20}$/.test(String(process.env.GA_ID || '').trim()) ? String(process.env.GA_ID).trim() : '';
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-cache').json({ ga_id: GA_ID || null });
});

// ---------- registro de eventos de uso (solo conteos, sin datos capturados) ----------
const eventosPorIp = new Map(); // ip -> { n, hasta }
app.post(['/api/evento', '/baugh/api/evento'], express.json({ limit: '1kb', type: () => true }), (req, res) => {
  const ip = req.ip;
  const r = eventosPorIp.get(ip);
  if (!r || r.hasta < Date.now()) eventosPorIp.set(ip, { n: 1, hasta: Date.now() + 60 * 60 * 1000 });
  else if (++r.n > 300) return res.status(429).end();

  const { app: cual, tipo } = req.body || {};
  let usuario = null;
  if (cual === 'baugh') {
    const s = leerSesion(req);
    if (!s) return res.status(204).end();
    usuario = s.via === 'password' ? 'Contraseña del equipo' : (s.name || `Usuario ${s.sub}`);
  }
  estadisticas.registrar(cual, tipo, usuario);
  res.status(204).end();
});

// ---------- página de acceso ----------
const loginTpl = fs.readFileSync(path.join(__dirname, 'views', 'login.html'), 'utf8');
function renderLogin(res, { error = '', status = 200 } = {}) {
  const html = loginTpl
    .replace('{{ERROR}}', error ? `<p class="error" role="alert">${error}</p>` : '')
    .replace('{{CASTILLO}}', CASTILLO_ACTIVO ? '' : 'hidden')
    .replace('{{PASSWORD_FORM}}', BAUGH_PASSWORD ? '' : 'hidden');
  res.status(status).set('Cache-Control', 'no-store').type('html').send(html);
}

app.get('/baugh/login', (req, res) => {
  if (leerSesion(req)) return res.redirect('/baugh/');
  const avisos = {
    salida: 'Cerraste sesión.',
    permiso: 'Tu usuario ya no tiene permiso para esta calculadora. Pídelo en El Castillo.',
  };
  renderLogin(res, { error: avisos[req.query.e] || '' });
});

// Contraseña del equipo
app.post('/baugh/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const ip = req.ip;
  if (!SECRET) return renderLogin(res, { error: 'El acceso no está configurado en el servidor.', status: 503 });
  if (!BAUGH_PASSWORD) return renderLogin(res, { error: 'La entrada con contraseña está desactivada. Entra con tu usuario de El Castillo.', status: 403 });
  if (bloqueado(`ip:${ip}`)) return renderLogin(res, { error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.', status: 429 });
  const pass = (req.body && req.body.password) || '';
  if (!safeEqual(pass, BAUGH_PASSWORD)) {
    registrarFallo(`ip:${ip}`);
    return renderLogin(res, { error: 'Contraseña incorrecta.', status: 401 });
  }
  limpiarFallos(`ip:${ip}`);
  crearSesion(res, { sub: 'equipo', via: 'password' });
  res.redirect(303, '/baugh/');
});

// Diagnóstico de la conexión con El Castillo. No muestra la API key ni datos de usuarios:
// solo a qué servidor apunta y si responde, para ubicar errores de configuración.
app.get('/baugh/api/diagnostico', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const motivo = (e) => (e && e.cause && (e.cause.code || e.cause.message)) || (e && (e.name === 'AbortError' ? 'TIMEOUT' : e.message)) || 'desconocido';
  const out = {
    castillo_url_configurada: !!process.env.CASTILLO_URL,
    castillo_servidor: CASTILLO_URL ? new URL(CASTILLO_URL).host : null,
    api_key_configurada: !!CASTILLO_API_KEY,
    session_secret_ok: !!SECRET,
    password_respaldo: !!BAUGH_PASSWORD,
    app_key: CASTILLO_APP_KEY,
  };
  if (!CASTILLO_URL) return res.json({ ...out, resultado: 'CASTILLO_URL vacía o inválida' });
  try {
    const r = await fetch(`${CASTILLO_URL}/health`, { signal: AbortSignal.timeout(5000) });
    out.castillo_health = r.status;
  } catch (e) { out.castillo_health = `error: ${motivo(e)}`; }
  try {
    const r = await castillo('/usuarios-selector');
    out.usuarios = r.ok && Array.isArray(r.data) ? `ok (${r.data.length})` : `HTTP ${r.status}`;
  } catch (e) { out.usuarios = `error: ${motivo(e)}`; }
  try {
    const r = await castillo(`/permiso?usuario_id=diagnostico&app=${encodeURIComponent(CASTILLO_APP_KEY)}`);
    out.api_key = r.status === 401 ? 'rechazada (no coincide con la de El Castillo)' : r.status === 400 ? `app "${CASTILLO_APP_KEY}" no registrada en El Castillo` : r.ok ? 'aceptada' : `HTTP ${r.status}`;
  } catch (e) { out.api_key = `error: ${motivo(e)}`; }
  res.json(out);
});

// Usuarios de El Castillo (solo nombre, iniciales, color y si ya tiene PIN)
app.get('/baugh/api/usuarios', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!CASTILLO_ACTIVO) return res.status(503).json({ error: 'El Castillo no está configurado.' });
  try {
    const r = await castillo('/usuarios-selector');
    if (!r.ok || !Array.isArray(r.data)) throw new Error(`respondió ${r.status}`);
    res.json(r.data.map((u) => ({
      id: u.id, nombre_completo: u.nombre_completo, iniciales: u.iniciales, color: u.color, tiene_pin: !!u.tiene_pin,
    })));
  } catch (e) {
    console.warn('No se pudo leer usuarios de El Castillo:', e.message, e.cause ? (e.cause.code || e.cause.message) : '');
    res.status(503).json({ error: 'No se pudo conectar con El Castillo.' });
  }
});

// Entrada con usuario de El Castillo + PIN
app.post('/baugh/api/entrar', express.json({ limit: '2kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ip = req.ip;
  const { usuario_id, pin, crear } = req.body || {};
  if (!SECRET || !CASTILLO_ACTIVO) return res.status(503).json({ error: 'El acceso con El Castillo no está configurado.' });
  if (!usuario_id || typeof usuario_id !== 'string' || !/^\d{2,4}$/.test(String(pin || ''))) {
    return res.status(400).json({ error: 'Elige tu nombre y escribe un PIN de 2 a 4 dígitos.' });
  }
  const claves = [`ip:${ip}`, `u:${usuario_id}`];
  if (bloqueado(...claves)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.' });

  try {
    // 1. Permiso primero: quien no tiene acceso a la calculadora no llega ni a crear PIN.
    const nivel = await nivelPermiso(usuario_id);
    if (nivel === 'ninguno') {
      registrarFallo(...claves);
      return res.status(403).json({ error: 'Tu usuario no tiene permiso para esta calculadora. Pídelo en El Castillo.' });
    }

    // 2. PIN: se crea la primera vez (como en las demás apps) o se verifica.
    if (crear) {
      const c = await castillo('/pin/crear', { method: 'POST', body: { usuario_id, pin: String(pin) } });
      if (c.status === 409) return res.status(409).json({ error: 'Este usuario ya tiene PIN. Escríbelo para entrar.' });
      if (!c.ok) throw new Error(`pin/crear respondió ${c.status}`);
    } else {
      const v = await castillo('/pin/verificar', { method: 'POST', body: { usuario_id, pin: String(pin) } });
      if (!v.ok) throw new Error(`pin/verificar respondió ${v.status}`);
      if (!v.data.valido) {
        registrarFallo(...claves);
        return res.status(401).json({ error: 'PIN incorrecto.' });
      }
    }

    limpiarFallos(...claves);
    permisoCache.set(usuario_id, { nivel, hasta: Date.now() + 5 * 60 * 1000 });
    const nombre = typeof req.body.nombre === 'string' ? req.body.nombre.slice(0, 80) : '';
    crearSesion(res, { sub: usuario_id, name: nombre, via: 'castillo' });
    res.json({ ok: true });
  } catch (e) {
    console.warn('Error al validar con El Castillo:', e.message);
    res.status(503).json({ error: 'No se pudo conectar con El Castillo. Intenta de nuevo o usa la contraseña del equipo.' });
  }
});

app.get('/baugh/logout', (req, res) => {
  borrarSesion(res);
  res.set('Clear-Site-Data', '"cache", "storage"');
  res.redirect('/baugh/login?e=salida');
});

app.get('/baugh/session', (req, res) => {
  const s = leerSesion(req);
  res.set('Cache-Control', 'no-store').json(s ? { ok: true, name: s.name || '', via: s.via } : { ok: false });
});

// Archivos de instalación de la app: públicos (el navegador los pide sin cookie).
const baughDir = path.join(__dirname, 'private', 'baugh');
app.get(['/baugh/manifest.webmanifest', '/baugh/sw.js'], (req, res) => {
  const file = path.basename(req.path);
  res.set('Cache-Control', 'no-cache');
  if (file === 'sw.js') res.set('Service-Worker-Allowed', '/baugh/');
  res.sendFile(path.join(baughDir, file));
});
app.use('/baugh/icons', express.static(path.join(baughDir, 'icons'), { maxAge: '7d' }));

// Todo lo demás de /baugh/ exige sesión.
app.get('/baugh', (req, res, next) => {
  if (req.originalUrl.split('?')[0] !== '/baugh') return next();
  res.redirect(301, '/baugh/');
});
app.use('/baugh', async (req, res, next) => {
  const s = leerSesion(req);
  const quiereHtml = (req.headers.accept || '').includes('text/html');
  // Las páginas redirigen al acceso aunque el cliente no pida text/html (p. ej. WhatsApp al
  // generar la vista previa de la liga); solo las rutas de datos responden 401.
  const esDatos = req.path.startsWith('/api/') || /\.(json|js|css|png|svg|ico|webmanifest)$/.test(req.path);
  if (!s) return esDatos ? res.status(401).json({ ok: false }) : res.redirect('/baugh/login');
  if (s.via === 'castillo' && CASTILLO_ACTIVO && quiereHtml && !(await sigueAutorizado(s.sub))) {
    borrarSesion(res);
    return res.redirect('/baugh/login?e=permiso');
  }
  next();
});
app.get('/baugh/api/estadisticas', (req, res) => {
  res.set('Cache-Control', 'no-store').json(estadisticas.resumen());
});
app.get('/baugh/estadisticas', (req, res) => {
  res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'views', 'estadisticas.html'));
});
app.use('/baugh', express.static(baughDir, {
  index: 'index.html',
  setHeaders: (res) => res.set('Cache-Control', 'private, no-cache'),
}));

// ---------- calculadora pública (Donceles) ----------
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) res.set('Cache-Control', 'no-cache');
  },
}));

app.use((req, res) => res.status(404).type('text').send('No encontrado'));

app.listen(PORT, () => console.log(`Calculadora Laboral escuchando en el puerto ${PORT}`));
