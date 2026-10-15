/*
 * Búsqueda por dirección, coordenadas o link de Google Maps.
 * Dice en qué lote / microrruta cae el punto (o el más cercano).
 *
 * Acepta:
 *   - Link de Google Maps (.../@6.2844,-75.5980,... o ...!3d6.2844!4d-75.5980)
 *   - Coordenadas: "6.2844, -75.5980"  ó  "6.2529N 75.6182W"
 *   - Dirección de Medellín: "Carrera 91D #72-159", "Cr 65 con Cl 84", "Cl 91A 71B-15"
 *     (se geocodifica con OpenStreetMap / Nominatim: es aproximada; para un punto
 *      exacto lo mejor es pegar el link de Google Maps)
 */
(function () {
  var MEDELLIN_VIEWBOX = '-75.72,6.40,-75.45,6.10'; // oeste,norte,este,sur
  var marcadorDireccion = null;

  // ---------- 1. Interpretar lo que escribe el usuario ----------
  function extraerCoordenadas(texto) {
    var t = texto.trim();
    var m = t.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);          // link largo de Google
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
    m = t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);                            // link con @lat,lon
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
    m = t.match(/[?&](?:q|query|ll)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);   // ?q=lat,lon
    if (m) return [parseFloat(m[1]), parseFloat(m[2])];
    m = t.match(/^(\d+(?:\.\d+)?)\s*°?\s*([NS])[\s,]+(\d+(?:\.\d+)?)\s*°?\s*([EWO])$/i); // 6.25N 75.61W
    if (m) {
      var la = parseFloat(m[1]) * (/S/i.test(m[2]) ? -1 : 1);
      var lo = parseFloat(m[3]) * (/[WO]/i.test(m[4]) ? -1 : 1);
      return [la, lo];
    }
    m = t.match(/^(-?\d+\.\d+)\s*[,;\s]\s*(-?\d+\.\d+)$/);                // 6.28, -75.59
    if (m) {
      var a = parseFloat(m[1]), b = parseFloat(m[2]);
      if (Math.abs(a) > Math.abs(b)) { var x = a; a = b; b = x; }        // si vienen al revés
      if (b > 0) b = -b;                                                   // Medellín es longitud oeste
      return [a, b];
    }
    return null;
  }

  function normalizarDireccion(texto) {
    var t = ' ' + texto.trim() + ' ';
    var reemplazos = [
      [/\b(cra|kra|kr|cr|crr|carr|cra\.)\.?\s*/gi, 'Carrera '],
      [/\b(cll|cl|calle)\.?\s*/gi, 'Calle '],
      [/\b(tv|tr|trans|transv)\.?\s*/gi, 'Transversal '],
      [/\b(dg|diag)\.?\s*/gi, 'Diagonal '],
      [/\b(cq|circ)\.?\s*/gi, 'Circular '],
      [/\b(av|avda)\.?\s*/gi, 'Avenida '],
      [/\s*(#|no\.?|n°|nº)\s*/gi, ' # ']
    ];
    reemplazos.forEach(function (r) { t = t.replace(r[0], r[1]); });
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  // "Carrera 91D # 72-159" -> también probamos "Carrera 91D con Calle 72"
  function variantesDireccion(dir) {
    var v = [dir];
    var m = dir.match(/^(Carrera|Calle|Transversal|Diagonal|Circular|Avenida)\s+([\w]+)\s*#\s*([\d]+[A-Za-z]?)/i);
    if (m) {
      var cruce = /carrera|transversal/i.test(m[1]) ? 'Calle' : 'Carrera';
      v.push(m[1] + ' ' + m[2] + ' ' + m[3]);
      v.push(m[1] + ' ' + m[2] + ' & ' + cruce + ' ' + m[3]);
      v.push(m[1] + ' ' + m[2]);
    }
    var c = dir.match(/^(\w+ \w+)\s+(?:con|x|y|&)\s+(\w+ \w+)/i);
    if (c) { v.push(c[1] + ' & ' + c[2]); v.push(c[1]); }
    return v;
  }

  function geocodificar(dir) {
    var intentos = variantesDireccion(dir);
    function intentar(i) {
      if (i >= intentos.length) return Promise.resolve(null);
      var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=co&bounded=1' +
        '&viewbox=' + MEDELLIN_VIEWBOX + '&q=' + encodeURIComponent(intentos[i] + ', Medellín, Antioquia');
      return fetch(url, { headers: { 'Accept-Language': 'es' } })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res && res.length) {
            return { lat: parseFloat(res[0].lat), lon: parseFloat(res[0].lon),
                     etiqueta: res[0].display_name, exacta: i === 0 };
          }
          return intentar(i + 1);
        });
    }
    return intentar(0);
  }

  // ---------- 2. ¿En qué lote cae? ----------
  function dentroAnillo(lat, lon, anillo) {
    var dentro = false;
    for (var i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
      var xi = anillo[i][0], yi = anillo[i][1], xj = anillo[j][0], yj = anillo[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
  }
  function poligonos(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
  }
  function distanciaM(lat1, lon1, lat2, lon2) {
    var dy = (lat2 - lat1) * 110574;
    var dx = (lon2 - lon1) * 111320 * Math.cos(lat1 * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
  }
  function buscarLote(lat, lon) {
    var feats = (window.json_zonasverdes__areas_zonas_verdes_2 || {}).features || [];
    var cercanos = [];
    feats.forEach(function (f) {
      var polys = poligonos(f.geometry), dentro = false, mejor = Infinity;
      polys.forEach(function (p) {
        if (!dentro && dentroAnillo(lat, lon, p[0])) {
          var enHueco = false;
          for (var h = 1; h < p.length; h++) if (dentroAnillo(lat, lon, p[h])) enHueco = true;
          if (!enHueco) dentro = true;
        }
        p[0].forEach(function (c) { var d = distanciaM(lat, lon, c[1], c[0]); if (d < mejor) mejor = d; });
      });
      cercanos.push({ feature: f, dist: dentro ? 0 : mejor, dentro: dentro });
    });
    cercanos.sort(function (a, b) { return a.dist - b.dist; });
    var vistos = {}, unicos = [];
    cercanos.forEach(function (c) {
      var k = (c.feature.properties.Microruta || '') + '|' + (c.feature.properties.No_Lote || '');
      if (!vistos[k] && unicos.length < 3) { vistos[k] = 1; unicos.push(c); }
    });
    return unicos;
  }

  function resaltar(feature) {
    var capa = window.layer_zonasverdes__areas_zonas_verdes_2;
    if (!capa) return;
    capa.eachLayer(function (l) {
      if (l.feature === feature) l.setStyle({ color: '#d92d20', weight: 3, fillColor: '#facc15', fillOpacity: 0.6 });
    });
  }

  function arreglarTexto(s) {           // corrige tildes mal codificadas (GÃ³mez -> Gómez)
    s = String(s == null ? '' : s);
    try { return /Ã|Â/.test(s) ? decodeURIComponent(escape(s)) : s; } catch (e) { return s; }
  }
  function textoLote(r) {
    var p = r.feature.properties;
    return '<b>' + (p.Microruta || 'Sin microrruta') + '</b> · lote ' + (p.No_Lote || 'NA') +
      ' · cuadrilla ' + (p.CUADRILLA || '-') +
      (r.dentro ? '' : ' <span style="color:#b45309">(a ' + Math.round(r.dist) + ' m)</span>') +
      '<br><small>' + arreglarTexto(p.Descripcio) + '</small>';
  }

  // ---------- 3. Mostrar el resultado ----------
  function mostrar(lat, lon, titulo, aviso) {
    var res = buscarLote(lat, lon);
    var html = '<div style="max-width:280px"><b>' + titulo + '</b><br><small>' +
      lat.toFixed(6) + ', ' + lon.toFixed(6) + '</small>';
    if (aviso) html += '<br><small style="color:#b45309">' + aviso + '</small>';
    if (res.length && res[0].dentro) {
      html += '<hr style="margin:6px 0">Está dentro de:<br>' + textoLote(res[0]);
      resaltar(res[0].feature);
    } else if (res.length) {
      html += '<hr style="margin:6px 0">No cae dentro de ningún lote. Los más cercanos:<br>' +
        res.map(textoLote).join('<br>');
      resaltar(res[0].feature);
    }
    html += '<br><a href="https://www.google.com/maps?q=' + lat + ',' + lon + '" target="_blank">Abrir en Google Maps</a></div>';
    if (marcadorDireccion) map.removeLayer(marcadorDireccion);
    marcadorDireccion = L.marker([lat, lon]).addTo(map).bindPopup(html, { maxWidth: 300 }).openPopup();
    map.setView([lat, lon], 18);
  }

  window.buscarDireccion = function (texto) {
    if (!texto || !texto.trim()) { alert('Escriba una dirección, unas coordenadas o pegue un link de Google Maps.'); return; }
    var c = extraerCoordenadas(texto);
    if (c) { mostrar(c[0], c[1], 'Punto buscado'); return; }
    var dir = normalizarDireccion(texto);
    var boton = document.getElementById('search-submit');
    if (boton) { boton.disabled = true; boton.textContent = 'Buscando…'; }
    geocodificar(dir).then(function (r) {
      if (!r) {
        alert('No encontré esa dirección en OpenStreetMap. Pruebe con el cruce (ej.: "Carrera 65 con Calle 84") o pegue el link de Google Maps.');
        return;
      }
      mostrar(r.lat, r.lon, dir, r.exacta ? 'Ubicación aproximada (OpenStreetMap)' :
        'No encontré la placa exacta; se muestra la vía o el cruce más cercano.');
    }).catch(function () {
      alert('No se pudo consultar el servicio de direcciones. Revise la conexión o pegue el link de Google Maps.');
    }).then(function () {
      if (boton) { boton.disabled = false; boton.textContent = 'Buscar'; }
    });
  };

  // Clic derecho / pulsación larga en el mapa: ¿qué lote es este punto?
  if (window.map) map.on('contextmenu', function (e) { mostrar(e.latlng.lat, e.latlng.lng, 'Punto seleccionado'); });
})();
