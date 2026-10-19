/*
 * Genera data/lotes_rapido.js y data/lotes_rapido_textos.js para el mapa rápido (rapido.html).
 *
 * Toma los polígonos de data/originales/zonasverdes__areas_zonas_verdes_2.js (15 MB) y los deja en ~1-2 MB:
 *   - quita la coordenada Z y simplifica los bordes (tolerancia ~0,3 m, no se nota en el mapa)
 *   - guarda las coordenadas como enteros en millonésimas de grado, en diferencias (más corto)
 *   - deja solo los datos que muestra la ficha del lote (con las direcciones y tildes ya arregladas)
 *
 * Uso (desde la carpeta del proyecto):   node scripts/generar_mapa_rapido.js
 * Vuelva a ejecutarlo cada vez que cambien los polígonos o las direcciones.
 */
var fs = require('fs');
var path = require('path');
var raiz = path.join(__dirname, '..');

function cargar(archivo, variable) {
  var txt = fs.readFileSync(path.join(raiz, archivo), 'utf8').replace(/^﻿/, '');
  var sandbox = {};
  new Function('ventana', txt.replace(new RegExp('var\\s+' + variable + '\\s*='), 'ventana.' + variable + ' ='))(sandbox);
  return sandbox[variable];
}
// Usa el original de qgis2web si está (data/originales/); data/ tiene la versión aligerada del mapa completo
var datos = cargar(fs.existsSync(path.join(raiz, 'data/originales/zonasverdes__areas_zonas_verdes_2.js')) ? 'data/originales/zonasverdes__areas_zonas_verdes_2.js' : 'data/zonasverdes__areas_zonas_verdes_2.js', 'json_zonasverdes__areas_zonas_verdes_2');
var direcciones = cargar('data/direcciones_lotes.js', 'direccionesLotes') || {};
var extras = cargar('data/direcciones_fid.js', 'extrasLotes') || {};

var TOLERANCIA = 3e-6;   // grados (~0,3 m)
var ESCALA = 1e6;

function arreglarTildes(s) {
  s = String(s == null ? '' : s);
  try { return /Ã|Â/.test(s) ? decodeURIComponent(escape(s)) : s; } catch (e) { return s; }
}
// Douglas-Peucker sobre un anillo cerrado
function simplificar(puntos, tol) {
  if (puntos.length <= 4) return puntos;
  var marcar = new Uint8Array(puntos.length), pila = [[0, puntos.length - 1]], tol2 = tol * tol;
  marcar[0] = marcar[puntos.length - 1] = 1;
  while (pila.length) {
    var tramo = pila.pop(), a = tramo[0], b = tramo[1], max = 0, idx = -1;
    var ax = puntos[a][0], ay = puntos[a][1], dx = puntos[b][0] - ax, dy = puntos[b][1] - ay, l2 = dx * dx + dy * dy;
    for (var i = a + 1; i < b; i++) {
      var px = puntos[i][0] - ax, py = puntos[i][1] - ay, d2;
      if (l2 === 0) d2 = px * px + py * py;
      else {
        var t = Math.max(0, Math.min(1, (px * dx + py * dy) / l2));
        var ex = px - t * dx, ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > max) { max = d2; idx = i; }
    }
    if (max > tol2 && idx > 0) { marcar[idx] = 1; pila.push([a, idx], [idx, b]); }
  }
  var out = puntos.filter(function (p, i) { return marcar[i]; });
  return out.length >= 4 ? out : puntos;   // un anillo necesita al menos 3 puntos + cierre
}
function codificarAnillo(anillo) {
  var plano = [], px = 0, py = 0;
  simplificar(anillo, TOLERANCIA).forEach(function (c, i, arr) {
    if (i === arr.length - 1 && arr.length > 1) return;   // el cierre se repone al leer
    var x = Math.round(c[0] * ESCALA), y = Math.round(c[1] * ESCALA);
    if (i > 0 && x === px && y === py) return;
    plano.push(x - px, y - py);
    px = x; py = y;
  });
  return plano;
}

var lotes = [], puntosAntes = 0, puntosDespues = 0;
datos.features.forEach(function (f) {
  var p = f.properties || {}, g = f.geometry;
  if (!g || !g.coordinates) return;
  var polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  var geom = polys.map(function (pol) {
    return pol.map(function (anillo) { puntosAntes += anillo.length; var c = codificarAnillo(anillo); puntosDespues += c.length / 2; return c; })
      .filter(function (c) { return c.length >= 6; });
  }).filter(function (pol) { return pol.length; });
  if (!geom.length) return;

  var mr = p.Microruta ? String(p.Microruta).trim() : '';
  var prog = mr ? direcciones[mr] : null;
  var ex = extras[p.fid] || {};
  var zona = /^Z(\d+)/i.test(mr) ? 'Z' + mr.match(/^Z(\d+)/i)[1] : '';
  var dañada = /ï¿½|�/.test(String(p.Descripcio || ''));
  var desc = (dañada && prog && prog.desc) ? prog.desc : arreglarTildes(p.Descripcio || (prog && prog.desc) || '').replace(/ï¿½|�/g, '?');
  var area = parseFloat(p.Area_campo) > 0 ? parseFloat(p.Area_campo) : Math.round(parseFloat(p.Area_m2) || 0);
  var lote = { i: p.fid, g: geom };
  function poner(clave, valor) { if (valor !== null && valor !== undefined && String(valor).trim() !== '') lote[clave] = valor; }
  poner('m', mr);
  poner('l', p.No_Lote != null ? String(p.No_Lote).trim() : '');
  poner('q', p.CUADRILLA != null ? String(p.CUADRILLA).trim() : '');
  poner('a', area);
  poner('z', zona);
  poner('c', ex.c || '');
  poner('f', prog && prog.frec);
  poner('d', arreglarTildes(p.DIRECCION || (prog && prog.d) || ex.d || ''));
  poner('s', desc);
  lotes.push(lote);
});

// Los textos largos (dirección y descripción) van en un archivo aparte que se carga después de pintar el mapa
var textos = {};
lotes.forEach(function (l) {
  if (l.d || l.s) textos[l.i] = [l.d || '', l.s || ''];
  delete l.d; delete l.s;
});
var version = new Date().toISOString();
var cabecera = '// Generado por scripts/generar_mapa_rapido.js el ' + version.slice(0, 10) + '. No editar a mano.\n';
var geometria = cabecera + 'window.LOTES_RAPIDO = ' + JSON.stringify({ version: version, escala: ESCALA, lotes: lotes }) + ';\n';
var detalle = cabecera + 'window.TEXTOS_RAPIDO = ' + JSON.stringify(textos) + ';\n';
fs.writeFileSync(path.join(raiz, 'data/lotes_rapido.js'), geometria, 'utf8');
fs.writeFileSync(path.join(raiz, 'data/lotes_rapido_textos.js'), detalle, 'utf8');
console.log(lotes.length + ' lotes · puntos ' + puntosAntes + ' → ' + puntosDespues + ' · lotes_rapido.js ' +
  (geometria.length / 1048576).toFixed(2) + ' MB · lotes_rapido_textos.js ' + (detalle.length / 1048576).toFixed(2) + ' MB');
