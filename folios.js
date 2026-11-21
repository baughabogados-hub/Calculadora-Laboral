'use strict';

/**
 * Folios de la calculadora Baugh.
 *
 * Un folio se crea solo cuando el usuario presiona «Guardar folio». Número = iniciales del
 * usuario de El Castillo + su consecutivo (RB-001). Guarda lo necesario para el control del
 * despacho y para regenerar el PDF: fecha, usuario, patrón, trabajador, tipo de separación,
 * montos del cálculo y los datos capturados. Después, en la pantalla de folios, se captura
 * el pago real: ahorro = base − pago; honorarios = % del ahorro (15% por defecto).
 *
 * Vive en DATA_DIR/folios.json (en Railway, el volumen). Se escribe en cada cambio.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./estadisticas');

const FILE = path.join(DATA_DIR, 'folios.json');
const MONTOS = ['salariosPendientes', 'aguinaldo', 'vacaciones', 'primaVacacional', 'gratificacion', 'adeudos',
  'primaAntiguedad', 'indemConstitucional', 'indem20', 'vencidos', 'total', 'isr', 'neto'];
const INCLUIR = ['indem20', 'vencidos', 'gratificacion'];

let datos = { folios: [], consecutivos: {} };
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) datos = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error('Folios: no se pudo leer el archivo:', e.message);
  // No se arranca de cero sobre un archivo dañado: se respalda para no perder folios.
  try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, `${FILE}.danado-${Date.now()}`); } catch (e2) {}
}
datos.folios = Array.isArray(datos.folios) ? datos.folios : [];
datos.consecutivos = datos.consecutivos || {};

function guardar() {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(datos));
  fs.renameSync(tmp, FILE);
}

const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

function inicialesDe(ini, nombre) {
  let s = String(ini || '').toUpperCase().normalize('NFD').replace(/[^A-Z]/g, '');
  if (!s) s = String(nombre || '').normalize('NFD').replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (s || 'EQ').slice(0, 4);
}

// Lo que se guarda de los datos capturados: solo pares id → valor (texto, número o casilla).
function limpiarCaptura(c) {
  const out = {};
  if (!c || typeof c !== 'object') return out;
  for (const [k, v] of Object.entries(c).slice(0, 300)) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' || typeof v === 'number') out[k] = String(v).slice(0, 200);
  }
  return out;
}

function crear(body, usuario) {
  const ini = inicialesDe(usuario.iniciales, usuario.nombre);
  const n = (datos.consecutivos[ini] || 0) + 1;
  const montos = {};
  MONTOS.forEach((k) => { montos[k] = numero(body.montos && body.montos[k]); });
  const folio = {
    folio: `${ini}-${String(n).padStart(3, '0')}`,
    fecha: new Date().toISOString(),
    usuario: texto(usuario.nombre, 80) || 'Equipo',
    usuarioId: String(usuario.id || ''),
    patron: texto(body.patron, 120),
    trabajador: texto(body.trabajador, 120),
    tipo: texto(body.tipo, 40),
    tipoLabel: texto(body.tipoLabel, 80),
    montos,
    captura: limpiarCaptura(body.captura),
    incluir: { indem20: false, vencidos: false, gratificacion: false },
    pago: null,
    honorariosPct: 15,
  };
  datos.consecutivos[ini] = n;
  datos.folios.push(folio);
  guardar();
  return folio;
}

function buscar(id) { return datos.folios.find((f) => f.folio === id) || null; }

function actualizar(id, body) {
  const f = buscar(id);
  if (!f) return null;
  if ('pago' in body) f.pago = body.pago === null || body.pago === '' ? null : Math.max(0, numero(Number(body.pago)));
  if ('honorariosPct' in body) f.honorariosPct = Math.min(100, Math.max(0, numero(Number(body.honorariosPct))));
  if (body.incluir && typeof body.incluir === 'object') INCLUIR.forEach((k) => { if (k in body.incluir) f.incluir[k] = !!body.incluir[k]; });
  if ('patron' in body) f.patron = texto(body.patron, 120);
  f.actualizado = new Date().toISOString();
  guardar();
  return f;
}

// Lista sin los datos capturados (pesan y no hacen falta en la tabla).
function lista() {
  return datos.folios.map(({ captura, ...f }) => f).reverse();
}

module.exports = { crear, buscar, actualizar, lista, inicialesDe };
