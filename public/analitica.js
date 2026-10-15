/*
 * Analítica de las calculadoras.
 *
 * 1. Estadísticas propias: avisa al servidor de cada visita, cálculo y PDF (solo el tipo
 *    de acción; nunca lo capturado). No usa cookies.
 * 2. Google Analytics: solo se carga si el servidor tiene GA_ID configurado Y la persona
 *    acepta en el aviso de cookies. Su decisión se recuerda en este dispositivo.
 *
 * Uso desde la página: window.registrarEvento('calculo') o window.registrarEvento('pdf').
 */
(function () {
  'use strict';
  var APP = location.pathname.indexOf('/baugh') === 0 ? 'baugh' : 'donceles';
  var CLAVE = 'consentimiento_analitica';
  // La cookie de sesión de Baugh solo viaja a rutas /baugh, por eso su evento va ahí.
  var URL_EVENTO = APP === 'baugh' ? '/baugh/api/evento' : '/api/evento';
  var gaListo = false;

  function leer() { try { return localStorage.getItem(CLAVE); } catch (e) { return null; } }
  function escribir(v) { try { localStorage.setItem(CLAVE, v); } catch (e) {} }

  function enviar(tipo) {
    var body = JSON.stringify({ app: APP, tipo: tipo });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(URL_EVENTO, new Blob([body], { type: 'application/json' }))) return;
    } catch (e) {}
    try { fetch(URL_EVENTO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, credentials: 'same-origin' }); } catch (e) {}
  }

  function cargarGA(id) {
    if (gaListo) return;
    gaListo = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id, { calculadora: APP });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
  }

  function banner(id) {
    var oscuro = APP === 'baugh' ? '#111111' : '#002040';
    var acento = APP === 'baugh' ? '#ffffff' : '#c09868';
    var el = document.createElement('div');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Aviso de cookies');
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:1000;max-width:640px;margin:0 auto;' +
      'background:' + oscuro + ';color:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,.3);' +
      'font:14px/1.45 Lora,Georgia,serif;display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center';
    el.innerHTML =
      '<p style="margin:0;flex:1 1 260px">Usamos cookies de Google Analytics para saber cuántas personas usan la calculadora y mejorarla. ' +
      'Lo que capturas en la calculadora nunca se envía. <a href="/privacidad" style="color:' + acento + '">Aviso de privacidad</a></p>' +
      '<span style="display:flex;gap:8px">' +
      '<button type="button" data-v="no" style="font:inherit;font-weight:700;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.6);border-radius:6px;padding:8px 14px;cursor:pointer">Rechazar</button>' +
      '<button type="button" data-v="si" style="font:inherit;font-weight:700;background:' + acento + ';color:' + oscuro + ';border:0;border-radius:6px;padding:8px 14px;cursor:pointer">Aceptar</button>' +
      '</span>';
    el.addEventListener('click', function (e) {
      var v = e.target && e.target.getAttribute && e.target.getAttribute('data-v');
      if (!v) return;
      escribir(v);
      el.remove();
      if (v === 'si') cargarGA(id);
    });
    document.body.appendChild(el);
  }

  window.registrarEvento = function (tipo) {
    enviar(tipo);
    if (gaListo && window.gtag) window.gtag('event', tipo === 'pdf' ? 'descarga_pdf' : tipo, { calculadora: APP });
  };

  function iniciar() {
    enviar('visita');
    fetch('/api/config', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (c) {
        if (!c || !c.ga_id) return;
        var d = leer();
        if (d === 'si') cargarGA(c.ga_id);
        else if (d !== 'no') banner(c.ga_id);
      })
      .catch(function () {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
