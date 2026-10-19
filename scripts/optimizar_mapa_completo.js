/*
 * Aligera los archivos de polígonos del mapa completo (index.html) sin cambiar sus datos.
 *
 * Lee los originales exportados por qgis2web desde data/originales/ y escribe en data/ una versión
 * con las mismas variables, los mismos lotes y las mismas propiedades, pero con coordenadas más cortas:
 *   - sin la altura Z (siempre 0)
 *   - 6 decimales (~11 cm) en vez de 15
 *   - sin vértices redundantes (los que se apartan menos de la tolerancia de la línea; ver TOLERANCIAS)
 *
 * Uso (desde la carpeta del proyecto):   node scripts/optimizar_mapa_completo.js
 * Si QGIS exporta datos nuevos: copie los archivos nuevos a data/originales/ y vuelva a ejecutarlo.
 */
var fs = require('fs');
var path = require('path');
var raiz = path.join(__dirname, '..');
var origen = path.join(raiz, 'data', 'originales');

// archivo -> tolerancia en grados (1e-6 ≈ 0,11 m)
var TOLERANCIAS = {
  'zonasverdes__areas_zonas_verdes_2.js': 2e-6,
  'Operativos_4.js': 1e-6,
  'Rutas_SIF_3.js': 1e-6,
  'Espartillos_6.js': 1e-6,
  'Comunas_1.js': 1e-5          // límites de comuna: ~1 m no se nota
};
var DECIMALES = 1e6;   // 6 decimales ≈ 11 cm

function redondear(v) { return Math.round(v * DECIMALES) / DECIMALES; }
// Douglas-Peucker; conserva el primer y el último punto
function simplificar(puntos, tol, minimo) {
  if (tol <= 0 || puntos.length <= minimo) return puntos;
  var marcar = new Uint8Array(puntos.length), pila = [[0, puntos.length - 1]], tol2 = tol * tol;
  marcar[0] = marcar[puntos.length - 1] = 1;
  while (pila.length) {
    var t = pila.pop(), a = t[0], b = t[1], max = 0, idx = -1;
    var ax = puntos[a][0], ay = puntos[a][1], dx = puntos[b][0] - ax, dy = puntos[b][1] - ay, l2 = dx * dx + dy * dy;
    for (var i = a + 1; i < b; i++) {
      var px = puntos[i][0] - ax, py = puntos[i][1] - ay, d2;
      if (l2 === 0) d2 = px * px + py * py;
      else {
        var k = Math.max(0, Math.min(1, (px * dx + py * dy) / l2)), ex = px - k * dx, ey = py - k * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > max) { max = d2; idx = i; }
    }
    if (max > tol2 && idx > 0) { marcar[idx] = 1; pila.push([a, idx], [idx, b]); }
  }
  var out = puntos.filter(function (p, i) { return marcar[i]; });
  return out.length >= minimo ? out : puntos;
}
function linea(coords, tol, minimo) {
  var limpia = [];
  coords.forEach(function (c) {
    var p = [redondear(c[0]), redondear(c[1])], u = limpia[limpia.length - 1];
    if (!u || u[0] !== p[0] || u[1] !== p[1]) limpia.push(p);
  });
  if (limpia.length < minimo) limpia = coords.map(function (c) { return [redondear(c[0]), redondear(c[1])]; });
  return simplificar(limpia, tol, minimo);
}
function geometria(g, tol) {
  if (!g) return g;
  var anillo = function (r) { return linea(r, tol, 4); };
  switch (g.type) {
    case 'Point': return { type: g.type, coordinates: [redondear(g.coordinates[0]), redondear(g.coordinates[1])] };
    case 'MultiPoint': return { type: g.type, coordinates: g.coordinates.map(function (c) { return [redondear(c[0]), redondear(c[1])]; }) };
    case 'LineString': return { type: g.type, coordinates: linea(g.coordinates, tol, 2) };
    case 'MultiLineString': return { type: g.type, coordinates: g.coordinates.map(function (l) { return linea(l, tol, 2); }) };
    case 'Polygon': return { type: g.type, coordinates: g.coordinates.map(anillo) };
    case 'MultiPolygon': return { type: g.type, coordinates: g.coordinates.map(function (p) { return p.map(anillo); }) };
    default: return g;
  }
}
function contar(g) { return JSON.stringify(g ? g.coordinates : []).split('],[').length; }

if (!fs.existsSync(origen)) { console.error('No existe data/originales/. Copie allí los archivos originales de qgis2web.'); process.exit(1); }
Object.keys(TOLERANCIAS).forEach(function (archivo) {
  var ruta = path.join(origen, archivo);
  if (!fs.existsSync(ruta)) { console.log('(se omite ' + archivo + ': no está en data/originales/)'); return; }
  var texto = fs.readFileSync(ruta, 'utf8');
  var bom = texto.charCodeAt(0) === 0xFEFF ? '﻿' : '';
  var m = texto.replace(/^﻿/, '').match(/^\s*var\s+([\w$]+)\s*=\s*/);
  var cuerpo = texto.replace(/^﻿/, '').slice(m[0].length).replace(/;\s*$/, '');
  var datos = JSON.parse(cuerpo);
  var antes = 0, despues = 0;
  datos.features.forEach(function (f) {
    antes += contar(f.geometry);
    f.geometry = geometria(f.geometry, TOLERANCIAS[archivo]);
    despues += contar(f.geometry);
  });
  var salida = bom + 'var ' + m[1] + ' = ' + JSON.stringify(datos) + ';';
  fs.writeFileSync(path.join(raiz, 'data', archivo), salida, 'utf8');
  console.log(archivo + ': ' + (texto.length / 1048576).toFixed(2) + ' MB → ' + (salida.length / 1048576).toFixed(2) + ' MB · vértices ' + antes + ' → ' + despues);
});
