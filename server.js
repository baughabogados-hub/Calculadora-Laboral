'use strict';

/**
 * Calculadora Laboral — despliegue único
 *
 *   /        → Calculadora de Finiquito (Consultores Donceles) — pública
 *   /baugh/  → Calculadora de Finiquito Baugh (Baugh Abogados) — solo equipo
 *
 * Acceso a /baugh/ por dos vías:
 *   1. Contraseña del equipo (variable BAUGH_PASSWORD).
 *   2. Inicio de sesión único desde El Castillo: El Castillo firma un token
 *      HS256 con CASTILLO_SSO_SECRET y redirige a /baugh/sso?token=...
 *
 * Variables de entorno (Railway):
 *   PORT                 lo asigna Railway
 *   SESSION_SECRET       obligatorio — cadena larga aleatoria para firmar la cookie de sesión
 *   BAUGH_PASSWORD       contraseña del equipo (si falta, se desactiva la entrada por contraseña)
 *   CASTILLO_SSO_SECRET  secreto compartido con El Castillo (si falta, se desactiva el SSO)
 *   SESSION_HOURS        duración de la sesión en horas (por defecto 12)
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const BAUGH_PASSWORD = process.env.BAUGH_PASSWORD || '';
const CASTILLO_SSO_SECRET = process.env.CASTILLO_SSO_SECRET || '';
const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 12;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const COOKIE_NAME = 'baugh_sesion';
const SSO_AUDIENCE = 'calculadora-baugh';
const SSO_ISSUER = 'el-castillo';
const SSO_MAX_AGE_S = 300; // un token de El Castillo vale máximo 5 minutos

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  if (IS_PROD) {
    console.error('Falta SESSION_SECRET (mínimo 32 caracteres). La ruta /baugh/ queda cerrada.');
  } else {
    console.warn('SESSION_SECRET no configurado: usando uno temporal solo para desarrollo.');
  }
}
const SECRET = SESSION_SECRET.length >= 32 ? SESSION_SECRET : (IS_PROD ? null : crypto.randomBytes(32).toString('hex'));

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

// ---------- verificación del token de El Castillo (JWT HS256) ----------
function verificarTokenCastillo(token) {
  if (!CASTILLO_SSO_SECRET || !token) return { ok: false, motivo: 'sso_desactivado' };
  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false, motivo: 'formato' };
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = JSON.parse(fromB64url(h).toString('utf8'));
    payload = JSON.parse(fromB64url(p).toString('utf8'));
  } catch (e) {
    return { ok: false, motivo: 'formato' };
  }
  if (header.alg !== 'HS256') return { ok: false, motivo: 'algoritmo' };
  const expected = b64url(crypto.createHmac('sha256', CASTILLO_SSO_SECRET).update(`${h}.${p}`).digest());
  if (!safeEqual(s, expected)) return { ok: false, motivo: 'firma' };
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return { ok: false, motivo: 'vencido' };
  if (payload.iat && payload.exp - payload.iat > SSO_MAX_AGE_S) return { ok: false, motivo: 'vigencia' };
  if (payload.iss !== SSO_ISSUER) return { ok: false, motivo: 'emisor' };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(SSO_AUDIENCE)) return { ok: false, motivo: 'audiencia' };
  if (!payload.sub) return { ok: false, motivo: 'usuario' };
  return { ok: true, payload };
}

// Evita reutilizar un mismo token (jti) durante su vigencia.
const tokensUsados = new Map();
function marcarTokenUsado(jti, exp) {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, v] of tokensUsados) if (v < now) tokensUsados.delete(k);
  if (!jti) return true;
  if (tokensUsados.has(jti)) return false;
  tokensUsados.set(jti, exp);
  return true;
}

// ---------- límite de intentos de contraseña ----------
const intentos = new Map(); // ip -> { n, hasta }
const MAX_INTENTOS = 5;
const VENTANA_MS = 15 * 60 * 1000;
function bloqueado(ip) {
  const r = intentos.get(ip);
  return r && r.n >= MAX_INTENTOS && r.hasta > Date.now();
}
function registrarFallo(ip) {
  const r = intentos.get(ip);
  if (!r || r.hasta < Date.now()) intentos.set(ip, { n: 1, hasta: Date.now() + VENTANA_MS });
  else r.n += 1;
}

// ---------- cabeceras de seguridad ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ---------- página de acceso ----------
const loginTpl = fs.readFileSync(path.join(__dirname, 'views', 'login.html'), 'utf8');
function renderLogin(res, { error = '', status = 200 } = {}) {
  const html = loginTpl
    .replace('{{ERROR}}', error ? `<p class="error" role="alert">${error}</p>` : '')
    .replace('{{PASSWORD_FORM}}', BAUGH_PASSWORD ? '' : 'hidden')
    .replace('{{SIN_PASSWORD}}', BAUGH_PASSWORD ? 'hidden' : '');
  res.status(status).set('Cache-Control', 'no-store').type('html').send(html);
}

app.get('/baugh/login', (req, res) => {
  if (leerSesion(req)) return res.redirect('/baugh/');
  const errores = {
    sso: 'El enlace de El Castillo no es válido o ya venció. Vuelve a abrir la calculadora desde El Castillo.',
    salida: 'Cerraste sesión.',
  };
  renderLogin(res, { error: errores[req.query.e] || '' });
});

app.post('/baugh/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const ip = req.ip;
  if (!SECRET) return renderLogin(res, { error: 'El acceso no está configurado en el servidor.', status: 503 });
  if (!BAUGH_PASSWORD) return renderLogin(res, { error: 'La entrada con contraseña está desactivada. Entra desde El Castillo.', status: 403 });
  if (bloqueado(ip)) return renderLogin(res, { error: 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.', status: 429 });
  const pass = (req.body && req.body.password) || '';
  if (!safeEqual(pass, BAUGH_PASSWORD)) {
    registrarFallo(ip);
    return renderLogin(res, { error: 'Contraseña incorrecta.', status: 401 });
  }
  intentos.delete(ip);
  crearSesion(res, { sub: 'equipo', via: 'password' });
  res.redirect(303, '/baugh/');
});

app.get('/baugh/sso', (req, res) => {
  if (!SECRET) return res.redirect('/baugh/login?e=sso');
  const r = verificarTokenCastillo(req.query.token);
  if (!r.ok || !marcarTokenUsado(r.payload.jti, r.payload.exp)) {
    console.warn('SSO rechazado:', r.ok ? 'token_reutilizado' : r.motivo);
    return res.redirect('/baugh/login?e=sso');
  }
  crearSesion(res, { sub: String(r.payload.sub), name: r.payload.name || '', via: 'castillo' });
  res.redirect(303, '/baugh/');
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
app.use('/baugh', (req, res, next) => {
  if (leerSesion(req)) return next();
  const quiereHtml = (req.headers.accept || '').includes('text/html');
  if (quiereHtml) return res.redirect('/baugh/login');
  res.status(401).json({ ok: false });
});
app.use('/baugh', express.static(baughDir, {
  index: 'index.html',
  setHeaders: (res) => res.set('Cache-Control', 'private, no-cache'),
}));

// ---------- calculadora pública (Donceles) ----------
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) res.set('Cache-Control', 'no-cache');
  },
}));

app.use((req, res) => res.status(404).type('text').send('No encontrado'));

app.listen(PORT, () => console.log(`Calculadora Laboral escuchando en el puerto ${PORT}`));
