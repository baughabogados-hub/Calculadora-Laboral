'use strict';

/**
 * Estadísticas de uso propias.
 *
 * Solo guarda CONTEOS por día: visitas, cálculos y PDFs descargados, separados por
 * calculadora (donceles / baugh). En Baugh, además, el nombre del usuario de El Castillo
 * que hizo la acción. Nunca recibe ni guarda lo que se captura en la calculadora
 * (nombres de trabajadores, salarios, fechas): el cálculo ocurre en el navegador.
 *
 * Los datos viven en DATA_DIR/estadisticas.json. En Railway, DATA_DIR debe apuntar a un
 * volumen (p. ej. /data); sin volumen se borran en cada despliegue.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'estadisticas.json');
const APPS = ['donceles', 'baugh'];
const TIPOS = ['visita', 'calculo', 'pdf'];

let datos = { dias: {}, usuarios: {}, desde: null };
let sucio = false;

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) datos = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.warn('Estadísticas: no se pudo leer el archivo, se empieza de cero:', e.message);
}
datos.dias = datos.dias || {};
datos.usuarios = datos.usuarios || {};
datos.desde = datos.desde || hoy();

function hoy() {
  // Fecha en hora de Guadalajara.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
}

function guardar() {
  if (!sucio) return;
  sucio = false;
  const tmp = `${FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(datos));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.warn('Estadísticas: no se pudo guardar:', e.message);
  }
}
setInterval(guardar, 5000).unref();
process.on('SIGTERM', () => { guardar(); process.exit(0); });

function registrar(app, tipo, usuario) {
  if (!APPS.includes(app) || !TIPOS.includes(tipo)) return false;
  const d = hoy();
  const dia = (datos.dias[d] = datos.dias[d] || {});
  const a = (dia[app] = dia[app] || { visita: 0, calculo: 0, pdf: 0 });
  a[tipo] += 1;
  if (app === 'baugh' && usuario) {
    const nombre = String(usuario).slice(0, 80);
    const u = (datos.usuarios[nombre] = datos.usuarios[nombre] || { visita: 0, calculo: 0, pdf: 0, ultimo: null });
    u[tipo] += 1;
    u.ultimo = d;
  }
  sucio = true;
  return true;
}

function resumen() {
  const fechas = Object.keys(datos.dias).sort();
  const vacio = () => ({ visita: 0, calculo: 0, pdf: 0 });
  const total = { donceles: vacio(), baugh: vacio() };
  const ultimos30 = { donceles: vacio(), baugh: vacio() };
  const limite = new Date(Date.now() - 29 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  for (const f of fechas) {
    for (const app of APPS) {
      const v = (datos.dias[f] || {})[app];
      if (!v) continue;
      for (const t of TIPOS) {
        total[app][t] += v[t] || 0;
        if (f >= limite) ultimos30[app][t] += v[t] || 0;
      }
    }
  }
  const porDia = fechas.slice(-30).reverse().map((f) => ({ fecha: f, ...APPS.reduce((o, a) => ({ ...o, [a]: { ...vacio(), ...(datos.dias[f][a] || {}) } }), {}) }));
  const usuarios = Object.entries(datos.usuarios)
    .map(([nombre, v]) => ({ nombre, ...v }))
    .sort((a, b) => b.calculo - a.calculo || b.visita - a.visita);
  return { desde: datos.desde, hoy: hoy(), total, ultimos30, porDia, usuarios };
}

module.exports = { registrar, resumen, DATA_DIR };
