/*
 * Guarda el mapa en el navegador para que abra rápido y funcione sin señal.
 *
 * - Datos (data/*.js): se sirven desde lo guardado al instante. En segundo plano se pregunta al
 *   servidor si cambiaron (petición condicional: si no cambiaron no se descarga nada). Si cambiaron
 *   se guardan y la página muestra "Hay datos nuevos · Actualizar".
 * - Páginas, código y estilos: primero la red (para tener siempre la última versión); si no hay
 *   señal o tarda más de 4 s, lo guardado.
 * - Fondos del mapa (satélite / calles): se guardan los últimos ~3.000 cuadros vistos.
 *
 * Si cambia la lógica de este archivo, suba VERSION para que los celulares lo renueven.
 */
var VERSION = 'v1';
var CACHE_APP = 'microrutas-app-' + VERSION;
var CACHE_DATOS = 'microrutas-datos';      // no lleva versión: los datos se revalidan solos
var CACHE_FONDOS = 'microrutas-fondos';
var MAX_FONDOS = 3000;
var PRECARGA = [
  './rapido.html',
  './css/leaflet.css',
  './js/leaflet.js',
  './data/lotes_rapido.js',
  './data/lotes_rapido_textos.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(Promise.all([
    caches.open(CACHE_APP).then(function (c) { return c.addAll(PRECARGA.filter(function (u) { return u.indexOf('/data/') === -1; })); }),
    caches.open(CACHE_DATOS).then(function (c) {
      return Promise.all(PRECARGA.filter(function (u) { return u.indexOf('/data/') !== -1; }).map(function (u) {
        return c.match(u).then(function (r) { return r || c.add(u); });
      }));
    })
  ]).catch(function () {}).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (claves) {
    return Promise.all(claves.filter(function (k) { return /^microrutas-app-/.test(k) && k !== CACHE_APP; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function sinParametros(url) { var u = new URL(url); u.search = ''; return u.href; }

// ------------------------------------------------------------------ datos: guardado + revalidación
var revisados = {};   // una revisión por archivo cada 5 min, aunque se recargue la página
function revalidar(url, guardada) {
  var ahora = Date.now();
  if (revisados[url] && ahora - revisados[url] < 300000) return Promise.resolve(false);
  revisados[url] = ahora;
  var cab = {};
  if (guardada) {
    var etag = guardada.headers.get('ETag'), mod = guardada.headers.get('Last-Modified');
    if (etag) cab['If-None-Match'] = etag;
    else if (mod) cab['If-Modified-Since'] = mod;
  }
  return fetch(url, { cache: 'no-store', headers: cab }).then(function (r) {
    if (r.status === 304 || !r.ok) return false;
    // Sin ETag ni fecha no hay cómo preguntar: se compara el tamaño
    if (guardada && !cab['If-None-Match'] && !cab['If-Modified-Since'] &&
        r.headers.get('Content-Length') && r.headers.get('Content-Length') === guardada.headers.get('Content-Length')) return false;
    return caches.open(CACHE_DATOS).then(function (c) { return c.put(url, r.clone()); }).then(function () { return !!guardada; });
  }).catch(function () { return false; });
}
function avisar(url) {
  self.clients.matchAll({ type: 'window' }).then(function (lista) {
    lista.forEach(function (cl) { cl.postMessage({ tipo: 'datos-nuevos', url: url }); });
  });
}
function datos(e) {
  var url = sinParametros(e.request.url);
  return caches.open(CACHE_DATOS).then(function (c) {
    return c.match(url).then(function (guardada) {
      if (guardada) {
        e.waitUntil(revalidar(url, guardada).then(function (cambio) { if (cambio) avisar(url); }));
        return guardada;
      }
      return fetch(e.request).then(function (r) {
        if (r.ok) { var copia = r.clone(); c.put(url, copia); revisados[url] = Date.now(); }
        return r;
      });
    });
  });
}

// ------------------------------------------------------------------ código: red primero
function redPrimero(e) {
  var red = fetch(e.request).then(function (r) {
    if (r.ok && r.type === 'basic') { var copia = r.clone(); caches.open(CACHE_APP).then(function (c) { c.put(e.request, copia); }); }
    return r;
  });
  var guardado = new Promise(function (ok) {
    setTimeout(function () { caches.match(e.request, { ignoreSearch: true }).then(ok); }, 4000);
  });
  return Promise.race([red.catch(function () { return caches.match(e.request, { ignoreSearch: true }); }), guardado.then(function (r) { return r || red; })])
    .then(function (r) { return r || red; });
}

// ------------------------------------------------------------------ fondos del mapa
var podando = false;
function fondo(e) {
  return caches.open(CACHE_FONDOS).then(function (c) {
    return c.match(e.request).then(function (r) {
      if (r) return r;
      return fetch(e.request).then(function (resp) {
        // Solo respuestas CORS: las opacas ocupan ~7 MB cada una en la cuota del navegador
        if (resp.ok) {
          c.put(e.request, resp.clone());
          if (!podando && Math.random() < 0.02) {
            podando = true;
            c.keys().then(function (k) {
              return Promise.all(k.slice(0, Math.max(0, k.length - MAX_FONDOS)).map(function (x) { return c.delete(x); }));
            }).then(function () { podando = false; }, function () { podando = false; });
          }
        }
        return resp;
      });
    });
  });
}

// Si el almacenamiento del navegador falla (lleno, modo privado…) se va directo a la red
function conRespaldo(fn, e) {
  return fn(e).catch(function () { return fetch(e.request); });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (/(^|\.)mt\d\.google\.com$|tile\.openstreetmap\.org$|basemaps\.cartocdn\.com$/.test(url.hostname)) { e.respondWith(conRespaldo(fondo, e)); return; }
  if (url.origin !== self.location.origin) return;
  if (/\/data\/[^/]+\.js$/.test(url.pathname)) { e.respondWith(conRespaldo(datos, e)); return; }
  e.respondWith(redPrimero(e));
});
