/*
 * Herramientas de operación del mapa de microrrutas:
 *   1. Filtros por microrruta y frecuencia + resumen (lotes, m², cuadrillas)
 *   2. Colorear por cuadrilla, frecuencia o estado, con leyenda
 *   3. "¿Qué lote es aquí?" con el GPS del celular (y el más cercano de la cuadrilla filtrada)
 *   4. Cómo llegar (Google Maps / Waze) desde cada lote
 *   5. Descargar Excel (CSV) de lo que se ve en el mapa
 *   6. Resumen por comuna al hacer clic en una comuna
 *   7. Seleccionar un área arrastrando un recuadro
 *   8. Marcar lotes como intervenidos (nota y foto), local o compartido por Google Sheets
 *   9. Calendario: qué microrrutas están vencidas o tocan esta semana
 * Depende de index.html (layer_zonasverdes__areas_zonas_verdes_2, filterFunc, popupLote...)
 * y de js/buscar_direccion.js y js/configuracion.js.
 */
(function () {
  var CONFIG = window.CONFIG_MICRORUTAS || {};
  var capa = window.layer_zonasverdes__areas_zonas_verdes_2;
  var datos = window.json_zonasverdes__areas_zonas_verdes_2;
  if (!capa || !datos) return;
  var features = datos.features;
  var porFid = {};

  // ---------------------------------------------------------------- utilidades
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function sinTildes(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
  function mr(f) { return String(f.properties.Microruta == null ? '' : f.properties.Microruta).trim(); }
  function prog(f) { var m = mr(f); return (window.direccionesLotes && m) ? window.direccionesLotes[m] : null; }
  function extra(f) { return (window.extrasLotes && f.properties.fid != null) ? window.extrasLotes[f.properties.fid] : null; }
  function area(f) {
    var a = parseFloat(f.properties.Area_campo);
    return a > 0 ? a : (parseFloat(f.properties.Area_m2) || 0);
  }
  function fmt(n) { return Math.round(n).toLocaleString('es-CO'); }
  function hoyISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function fechaDe(iso) { var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function sumarDias(iso, n) { var d = fechaDe(iso); d.setDate(d.getDate() + n); return hoyISO(d); }
  function diasEntre(a, b) { return Math.round((fechaDe(b) - fechaDe(a)) / 86400000); }
  function fechaCorta(iso) {
    if (!iso) return '';
    var d = fechaDe(iso);
    return d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function leer(clave, porDefecto) {
    try { var v = localStorage.getItem(clave); return v ? JSON.parse(v) : porDefecto; } catch (e) { return porDefecto; }
  }
  function guardar(clave, valor) {
    try { localStorage.setItem(clave, JSON.stringify(valor)); return true; } catch (e) { return false; }
  }
  function aviso(texto, ms) {
    var el = document.getElementById('mr-aviso');
    if (!el) { el = document.createElement('div'); el.id = 'mr-aviso'; document.body.appendChild(el); }
    el.textContent = texto;
    el.className = 'is-visible';
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = ''; }, ms || 3500);
  }
  function descargar(nombre, contenido, tipo) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([contenido], { type: tipo }));
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // Punto representativo del lote (centroide del polígono más grande; si cae fuera, un vértice)
  function anilloMayor(geom) {
    var polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    var mejor = null, mayor = -1;
    polys.forEach(function (p) {
      var a = Math.abs(areaAnillo(p[0]));
      if (a > mayor) { mayor = a; mejor = p[0]; }
    });
    return mejor;
  }
  function areaAnillo(r) {
    var s = 0;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] * r[i][1] - r[i][0] * r[j][1]);
    return s / 2;
  }
  function dentro(lon, lat, r) {
    var d = false;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
      if (((r[i][1] > lat) !== (r[j][1] > lat)) && (lon < (r[j][0] - r[i][0]) * (lat - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) d = !d;
    }
    return d;
  }
  function centro(f) {
    if (f._centro !== undefined) return f._centro;
    var r = f.geometry && anilloMayor(f.geometry);
    if (!r || !r.length) return (f._centro = null);
    var a = areaAnillo(r), cx = 0, cy = 0;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
      var k = r[j][0] * r[i][1] - r[i][0] * r[j][1];
      cx += (r[j][0] + r[i][0]) * k; cy += (r[j][1] + r[i][1]) * k;
    }
    var lon = a ? cx / (6 * a) : r[0][0], lat = a ? cy / (6 * a) : r[0][1];
    if (!dentro(lon, lat, r)) { lon = r[0][0]; lat = r[0][1]; }
    return (f._centro = [lat, lon]);
  }

  // ---------------------------------------------------------------- 0. Completar datos de cada lote
  // Zona (de la microrruta), Comuna y Frecuencia: así funcionan los filtros Zona y Comuna del panel.
  features.forEach(function (f) {
    var p = f.properties, m = mr(f), pr = prog(f), ex = extra(f);
    porFid[p.fid] = f;
    var z = m.match(/^Z(\d+)/i);
    p.Zona = z ? 'Z' + z[1] : '';
    var c = ex && ex.c ? String(ex.c) : '';
    p.NOMBRE = c.indexOf('–') !== -1 ? c.split('–').pop().trim() : '';
    p.Frecuencia = pr && pr.frec ? pr.frec : 'Sin programación';
  });

  // ---------------------------------------------------------------- 8. Registros (lotes intervenidos)
  var CLAVE_REG = 'microrutas_registros_v1', CLAVE_PEND = 'microrutas_pendientes_v1', CLAVE_AJUSTES = 'microrutas_ajustes_v1';
  var registros = leer(CLAVE_REG, {});     // fid -> {fecha, hora, nota, quien, foto}
  var pendientes = leer(CLAVE_PEND, []);   // envíos a Google Sheets que no han salido (sin internet)
  var ajustes = leer(CLAVE_AJUSTES, {});   // {quien, registroUrl, clave}
  function urlRegistro() { return (ajustes.registroUrl || CONFIG.registroUrl || '').trim(); }
  function claveRegistro() { return (ajustes.clave || CONFIG.clave || '').trim(); }

  function periodo(f) {
    var pr = prog(f), tabla = CONFIG.frecuenciaDias || {};
    return (pr && tabla[pr.frec]) || CONFIG.frecuenciaPorDefecto || 30;
  }
  function finDeSemana() { var d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); return hoyISO(d); } // domingo
  // Estado de un lote: 'sin' (sin registro), 'vencido', 'semana' (toca esta semana), 'aldia'
  function estado(f) {
    var r = registros[f.properties.fid];
    if (!r || !r.fecha) return { clave: 'sin', texto: 'Sin registro' };
    var prox = sumarDias(r.fecha, periodo(f)), hoy = hoyISO();
    if (prox < hoy) return { clave: 'vencido', texto: 'Vencido desde ' + fechaCorta(prox), prox: prox };
    if (prox <= finDeSemana()) return { clave: 'semana', texto: 'Toca ' + (prox === hoy ? 'hoy' : fechaCorta(prox)), prox: prox };
    return { clave: 'aldia', texto: 'Al día · próxima ' + fechaCorta(prox), prox: prox };
  }

  function registrar(lista, nota, fotoDataUrl) {
    var hora = new Date().toISOString(), fecha = hoyISO(), quien = ajustes.quien || '';
    var filas = lista.map(function (f) {
      var p = f.properties;
      var r = { fid: p.fid, microruta: mr(f), lote: p.No_Lote || '', cuadrilla: p.CUADRILLA || '', fecha: fecha, hora: hora, nota: nota || '', quien: quien, foto: fotoDataUrl ? 'pendiente' : '' };
      registros[p.fid] = { fecha: fecha, hora: hora, nota: r.nota, quien: quien, foto: fotoDataUrl ? 'local:' + hora : '' };
      return r;
    });
    if (fotoDataUrl) guardarFoto('local:' + hora, fotoDataUrl);
    if (!guardar(CLAVE_REG, registros)) aviso('El celular no tiene espacio para guardar más registros.');
    if (urlRegistro()) {
      pendientes.push({ registros: filas, foto: fotoDataUrl || null, hora: hora });
      guardar(CLAVE_PEND, pendientes);
      enviarPendientes();
    }
    refrescarTodo();
    aviso(lista.length === 1 ? 'Lote marcado como intervenido hoy.' : lista.length + ' lotes marcados como intervenidos hoy.');
  }
  function deshacer(f) {
    delete registros[f.properties.fid];
    guardar(CLAVE_REG, registros);
    if (urlRegistro()) {
      pendientes.push({ registros: [{ fid: f.properties.fid, microruta: mr(f), lote: f.properties.No_Lote || '', cuadrilla: f.properties.CUADRILLA || '', fecha: '', hora: new Date().toISOString(), nota: 'BORRADO', quien: ajustes.quien || '', foto: '' }], foto: null });
      guardar(CLAVE_PEND, pendientes);
      enviarPendientes();
    }
    refrescarTodo();
  }

  // Fotos locales en IndexedDB (no caben muchas en localStorage)
  var bdFotos = null;
  function abrirBD() {
    if (bdFotos) return bdFotos;
    bdFotos = new Promise(function (ok, mal) {
      try {
        var req = indexedDB.open('microrutas_fotos', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('fotos'); };
        req.onsuccess = function () { ok(req.result); };
        req.onerror = function () { mal(req.error); };
      } catch (e) { mal(e); }
    });
    return bdFotos;
  }
  function guardarFoto(clave, dataUrl) {
    return abrirBD().then(function (bd) {
      return new Promise(function (ok) { var tx = bd.transaction('fotos', 'readwrite'); tx.objectStore('fotos').put(dataUrl, clave); tx.oncomplete = ok; tx.onerror = ok; });
    }).catch(function () {});
  }
  function leerFoto(clave) {
    return abrirBD().then(function (bd) {
      return new Promise(function (ok) { var q = bd.transaction('fotos').objectStore('fotos').get(clave); q.onsuccess = function () { ok(q.result); }; q.onerror = function () { ok(null); }; });
    }).catch(function () { return null; });
  }
  function reducirFoto(archivo) {
    return new Promise(function (ok, mal) {
      var lector = new FileReader();
      lector.onerror = mal;
      lector.onload = function () {
        var img = new Image();
        img.onerror = mal;
        img.onload = function () {
          var max = 900, w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
          var c = document.createElement('canvas');
          c.width = Math.round(w * k); c.height = Math.round(h * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          ok(c.toDataURL('image/jpeg', 0.72));
        };
        img.src = lector.result;
      };
      lector.readAsDataURL(archivo);
    });
  }

  // Sincronización con Google Sheets (Apps Script). Ver integraciones/registro_apps_script.gs
  var enviando = false;
  function enviarPendientes() {
    var url = urlRegistro();
    if (!url || enviando || !pendientes.length || !navigator.onLine) { actualizarEstadoSync(); return; }
    enviando = true;
    actualizarEstadoSync();
    var lote = pendientes[0];
    fetch(url, { method: 'POST', body: JSON.stringify({ accion: 'registrar', clave: claveRegistro(), registros: lote.registros, foto: lote.foto }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok) throw new Error(res && res.error || 'respuesta inválida');
        pendientes.shift();
        guardar(CLAVE_PEND, pendientes);
        if (res.foto) lote.registros.forEach(function (r) {
          var reg = registros[r.fid];
          if (reg && reg.hora === r.hora) reg.foto = res.foto;
        });
        guardar(CLAVE_REG, registros);
        enviando = false;
        if (pendientes.length) enviarPendientes(); else actualizarEstadoSync('Guardado en la hoja compartida');
      })
      .catch(function (e) {
        enviando = false;
        actualizarEstadoSync('No se pudo enviar (' + e.message + '). Se reintenta solo.');
      });
  }
  function traerRegistros() {
    var url = urlRegistro();
    if (!url || !navigator.onLine || document.hidden) return;
    fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 'accion=listar&clave=' + encodeURIComponent(claveRegistro()))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok) throw new Error(res && res.error || 'respuesta inválida');
        var cambio = false;
        (res.registros || []).forEach(function (r) {
          var fid = r.fid, actual = registros[fid];
          if (actual && actual.hora >= r.hora) return;
          if (r.nota === 'BORRADO' || !r.fecha) { if (actual) { delete registros[fid]; cambio = true; } return; }
          registros[fid] = { fecha: String(r.fecha).slice(0, 10), hora: r.hora, nota: r.nota || '', quien: r.quien || '', foto: r.foto || '' };
          cambio = true;
        });
        if (cambio) { guardar(CLAVE_REG, registros); refrescarTodo(); }
        actualizarEstadoSync('Hoja compartida al día · ' + new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }));
      })
      .catch(function (e) { actualizarEstadoSync('No se pudo leer la hoja compartida (' + e.message + ')'); });
  }
  var textoSync = '';
  function actualizarEstadoSync(texto) {
    if (texto) textoSync = texto;
    var el = document.getElementById('mr-sync');
    if (!el) return;
    if (!urlRegistro()) { el.textContent = 'Registros guardados solo en este dispositivo.'; return; }
    el.textContent = (enviando ? 'Enviando… ' : '') + (pendientes.length ? pendientes.length + ' envío(s) pendiente(s). ' : '') + textoSync;
  }
  window.addEventListener('online', enviarPendientes);
  setInterval(function () { enviarPendientes(); traerRegistros(); }, (CONFIG.revisarCadaSegundos || 60) * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) traerRegistros(); });

  // ---------------------------------------------------------------- 2. Colores
  var PALETA_CUADRILLA = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#db2777', '#65a30d', '#ca8a04', '#0f766e', '#7c3aed', '#b45309'];
  var COLOR_ESTADO = { aldia: '#16a34a', semana: '#f59e0b', vencido: '#dc2626', sin: '#94a3b8' };
  var NOMBRE_ESTADO = { vencido: 'Vencido', semana: 'Toca esta semana', aldia: 'Al día', sin: 'Sin registro' };
  var COLOR_FRECUENCIA = { Quincenal: '#7c3aed', Mensual: '#0891b2', 'Sin programación': '#94a3b8' };
  var modoColor = leer('microrutas_color', 'cuadrilla');
  function colorCuadrilla(v) {
    var n = parseInt(v, 10);
    return isFinite(n) ? PALETA_CUADRILLA[(n - 1 + PALETA_CUADRILLA.length) % PALETA_CUADRILLA.length] : '#64748b';
  }
  function colorLote(f) {
    if (modoColor === 'estado') return COLOR_ESTADO[estado(f).clave];
    if (modoColor === 'frecuencia') return COLOR_FRECUENCIA[f.properties.Frecuencia] || '#94a3b8';
    return colorCuadrilla(f.properties.CUADRILLA);
  }
  function estiloLote(f) {
    var c = colorLote(f), hecho = registros[f.properties.fid] && registros[f.properties.fid].fecha === hoyISO();
    return {
      pane: 'pane_zonasverdes__areas_zonas_verdes_2', opacity: 0.95, color: hecho ? '#065f46' : c,
      dashArray: '', lineCap: 'butt', lineJoin: 'miter', weight: hecho ? 2.5 : 1, fill: true,
      fillOpacity: 0.62, fillColor: c, interactive: true
    };
  }
  // el index.html usa este nombre para devolver el color al quitar una selección
  window.style_zonasverdes__areas_zonas_verdes_2_0 = estiloLote;
  capa.options.style = estiloLote;
  function recolorear() {
    capa.eachLayer(function (l) {
      var sel = window.lotesSeleccionados && window.lotesSeleccionados.indexOf(l.feature) !== -1;
      l.setStyle(sel ? { color: '#111827', weight: 3, fillColor: '#facc15', fillOpacity: 0.82 } : estiloLote(l.feature));
    });
  }
  function leyendaHTML() {
    var items = [];
    if (modoColor === 'estado') items = ['vencido', 'semana', 'aldia', 'sin'].map(function (k) { return [COLOR_ESTADO[k], NOMBRE_ESTADO[k]]; });
    else if (modoColor === 'frecuencia') items = Object.keys(COLOR_FRECUENCIA).map(function (k) { return [COLOR_FRECUENCIA[k], k]; });
    else {
      var cs = {};
      features.forEach(function (f) { cs[f.properties.CUADRILLA == null ? '' : f.properties.CUADRILLA] = 1; });
      items = Object.keys(cs).sort(function (a, b) { return (parseInt(a, 10) || 99) - (parseInt(b, 10) || 99); })
        .map(function (k) { return [colorCuadrilla(k), k ? 'Cuadrilla ' + k : 'Sin cuadrilla']; });
    }
    return items.map(function (i) { return '<span class="mr-chip"><i style="background:' + i[0] + '"></i>' + esc(i[1]) + '</span>'; }).join('');
  }

  // ---------------------------------------------------------------- 4. Cómo llegar + popup del lote
  window.enlacesComoLlegar = function (f, corto) {
    var c = centro(f);
    if (!c) return '';
    var ll = c[0].toFixed(6) + ',' + c[1].toFixed(6);
    return '<a href="https://www.google.com/maps/dir/?api=1&destination=' + ll + '" target="_blank" rel="noopener">' + (corto ? 'Ir' : 'Cómo llegar (Google Maps)') + '</a>' +
      (corto ? '' : ' · <a href="https://waze.com/ul?ll=' + ll + '&navigate=yes" target="_blank" rel="noopener">Waze</a>');
  };
  function lotesMicroruta(f) {
    var m = mr(f);
    return m ? features.filter(function (x) { return mr(x) === m; }) : [f];
  }
  function popupLoteCompleto(layer) {
    var f = layer.feature, p = f.properties;
    var html = window.popupLote(f);
    html += '<p class="mr-llegar">🧭 ' + window.enlacesComoLlegar(f) + '</p>';
    var r = registros[p.fid], e = estado(f);
    html += '<div class="mr-registro" data-fid="' + esc(p.fid) + '">';
    html += '<div class="mr-estado"><i style="background:' + COLOR_ESTADO[e.clave] + '"></i><b>' + esc(e.texto) + '</b></div>';
    if (r) {
      html += '<small>Última intervención: ' + esc(fechaCorta(r.fecha)) + (r.quien ? ' · ' + esc(r.quien) : '') + '</small>' +
        (r.nota ? '<small>Nota: ' + esc(r.nota) + '</small>' : '') +
        (r.foto ? '<img class="mr-foto" alt="Foto de la intervención" data-foto="' + esc(r.foto) + '">' : '');
    }
    var n = lotesMicroruta(f).length;
    html += '<textarea class="mr-nota" rows="2" placeholder="Nota (opcional)"></textarea>' +
      '<label class="mr-archivo">📷 Foto (opcional)<input type="file" accept="image/*" capture="environment" class="mr-foto-input"></label>' +
      '<button type="button" data-accion="lote">✔ Lote intervenido hoy</button>' +
      (n > 1 ? '<button type="button" data-accion="microruta" class="mr-sec">✔ Toda la microrruta (' + n + ' lotes)</button>' : '') +
      (r ? '<button type="button" data-accion="deshacer" class="mr-link">Quitar registro</button>' : '') +
      '</div>';
    return html;
  }
  function onEachLote(feature, layer) {
    layer.bindPopup(popupLoteCompleto, { maxHeight: 440, maxWidth: 320 });
    layer.on('click', function (e) { window.seleccionarLote(e); });
  }
  capa.options.onEachFeature = onEachLote;
  capa.eachLayer(function (l) { l.bindPopup(popupLoteCompleto, { maxHeight: 440, maxWidth: 320 }); });

  map.on('popupopen', function (e) {
    var el = e.popup.getElement(), caja = el && el.querySelector('.mr-registro');
    if (!caja) return;
    var f = porFid[caja.getAttribute('data-fid')];
    var img = caja.querySelector('.mr-foto');
    if (img) {
      var src = img.getAttribute('data-foto');
      if (/^local:/.test(src)) leerFoto(src).then(function (d) { if (d) img.src = d; else img.remove(); });
      else if (/^https?:/.test(src)) img.src = src;
      else img.remove();
      img.onload = function () { e.popup.update(); };
    }
    caja.querySelectorAll('button[data-accion]').forEach(function (b) {
      b.onclick = function () {
        var accion = b.getAttribute('data-accion');
        if (accion === 'deshacer') { deshacer(f); map.closePopup(); return; }
        if (!ajustes.quien) {
          var nombre = window.prompt('¿Quién registra? (su nombre o cuadrilla; se pregunta una sola vez)', '');
          if (nombre === null) return;
          ajustes.quien = nombre.trim();
          guardar(CLAVE_AJUSTES, ajustes);
        }
        var nota = caja.querySelector('.mr-nota').value.trim();
        var archivo = caja.querySelector('.mr-foto-input').files[0];
        var lista = accion === 'microruta' ? lotesMicroruta(f) : [f];
        b.disabled = true; b.textContent = 'Guardando…';
        (archivo ? reducirFoto(archivo) : Promise.resolve(null))
          .then(function (foto) { registrar(lista, nota, foto); map.closePopup(); })
          .catch(function () { aviso('No se pudo leer la foto.'); b.disabled = false; });
      };
    });
  });

  // ---------------------------------------------------------------- 1. Lotes visibles + resumen
  function lotesVisibles() {
    var out = [];
    capa.eachLayer(function (l) { if (l.feature) out.push(l.feature); });
    return out;
  }
  function porCuadrilla(lista) {
    var g = {};
    lista.forEach(function (f) {
      var k = f.properties.CUADRILLA == null || f.properties.CUADRILLA === '' ? 'Sin' : f.properties.CUADRILLA;
      g[k] = g[k] || { lotes: 0, m2: 0, mr: {} };
      g[k].lotes++; g[k].m2 += area(f); if (mr(f)) g[k].mr[mr(f)] = 1;
    });
    return Object.keys(g).sort(function (a, b) { return (parseInt(a, 10) || 99) - (parseInt(b, 10) || 99); })
      .map(function (k) { return { cuadrilla: k, lotes: g[k].lotes, m2: g[k].m2, microrrutas: Object.keys(g[k].mr).length }; });
  }
  function tablaCuadrillas(lista) {
    return '<table class="mr-tabla"><tr><th>Cuadrilla</th><th>Microrr.</th><th>Lotes</th><th>m²</th></tr>' +
      porCuadrilla(lista).map(function (r) {
        return '<tr><td><i class="mr-punto" style="background:' + colorCuadrilla(r.cuadrilla) + '"></i>' + esc(r.cuadrilla) + '</td><td>' + r.microrrutas + '</td><td>' + fmt(r.lotes) + '</td><td>' + fmt(r.m2) + '</td></tr>';
      }).join('') + '</table>';
  }
  function resumenHTML(lista) {
    var m2 = 0, mrs = {}, est = { vencido: 0, semana: 0, aldia: 0, sin: 0 };
    lista.forEach(function (f) { m2 += area(f); if (mr(f)) mrs[mr(f)] = 1; est[estado(f).clave]++; });
    return '<div class="mr-cifras"><div><b>' + fmt(lista.length) + '</b><span>lotes</span></div><div><b>' + fmt(Object.keys(mrs).length) + '</b><span>microrrutas</span></div><div><b>' + fmt(m2) + '</b><span>m²</span></div></div>' +
      '<div class="mr-estados">' + ['vencido', 'semana', 'aldia', 'sin'].map(function (k) {
        return '<span><i style="background:' + COLOR_ESTADO[k] + '"></i>' + NOMBRE_ESTADO[k] + ': <b>' + fmt(est[k]) + '</b></span>';
      }).join('') + '</div>' +
      '<details><summary>Por cuadrilla</summary>' + tablaCuadrillas(lista) + '</details>';
  }
  function refrescarResumen() {
    var el = document.getElementById('mr-resumen');
    if (el) el.innerHTML = resumenHTML(lotesVisibles());
  }
  function refrescarTodo() {
    recolorear();
    refrescarResumen();
    actualizarEstadoSync();
    if (hojaAbierta === 'semana') abrirSemana();
  }

  // ---------------------------------------------------------------- 5. Excel (CSV)
  function filaCSV(f) {
    var p = f.properties, pr = prog(f), ex = extra(f), r = registros[p.fid] || {}, e = estado(f), c = centro(f) || ['', ''];
    var dir = p.DIRECCION || (pr && pr.d) || (ex && ex.d) || '';
    return [mr(f), p.No_Lote, p.CUADRILLA, p.Zona, p.NOMBRE, Math.round(area(f)), p.Frecuencia, dir, p.Descripcio || (pr && pr.desc) || '',
      c[0] === '' ? '' : c[0].toFixed(6), c[1] === '' ? '' : c[1].toFixed(6), r.fecha || '', e.prox || '', NOMBRE_ESTADO[e.clave], r.nota || '', r.quien || ''];
  }
  function descargarCSV(lista, nombre) {
    if (!lista.length) { aviso('No hay lotes para descargar.'); return; }
    var cab = ['Microrruta', 'Lote', 'Cuadrilla', 'Zona', 'Comuna', 'Area_m2', 'Frecuencia', 'Direccion', 'Descripcion', 'Latitud', 'Longitud', 'Ultima_intervencion', 'Proxima', 'Estado', 'Nota', 'Registrado_por'];
    var celda = function (v) { v = String(v == null ? '' : v).replace(/\r?\n/g, ' '); return /[;"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var txt = '﻿' + [cab].concat(lista.map(filaCSV)).map(function (fila) { return fila.map(celda).join(';'); }).join('\r\n');
    descargar((nombre || 'lotes') + '_' + hoyISO() + '.csv', txt, 'text/csv;charset=utf-8');
  }
  window.descargarLotesCSV = descargarCSV;

  // ---------------------------------------------------------------- hojas (paneles flotantes)
  var hojaAbierta = null;
  function abrirHoja(id, titulo, html) {
    var h = document.getElementById('mr-hoja');
    if (!h) {
      h = document.createElement('section');
      h.id = 'mr-hoja';
      h.setAttribute('role', 'dialog');
      document.body.appendChild(h);
      L.DomEvent.disableClickPropagation(h);
      L.DomEvent.disableScrollPropagation(h);
    }
    hojaAbierta = id;
    h.innerHTML = '<header><h2>' + titulo + '</h2><button type="button" class="mr-cerrar" title="Cerrar">✕</button></header><div class="mr-cuerpo">' + html + '</div>';
    h.className = 'is-open';
    h.querySelector('.mr-cerrar').onclick = cerrarHoja;
    return h;
  }
  function cerrarHoja() {
    var h = document.getElementById('mr-hoja');
    if (h) h.className = '';
    hojaAbierta = null;
  }

  // ---------------------------------------------------------------- 9. Calendario: qué toca esta semana
  function grupoMicrorrutas(lista) {
    var g = {};
    lista.forEach(function (f) {
      var k = mr(f) || 'Sin microrrutas';
      g[k] = g[k] || { mr: k, lotes: [], m2: 0, cuad: f.properties.CUADRILLA, frec: f.properties.Frecuencia, ultima: '', prox: '', peor: 'aldia' };
      var x = g[k], e = estado(f), r = registros[f.properties.fid];
      x.lotes.push(f); x.m2 += area(f);
      if (r && (!x.ultima || r.fecha < x.ultima)) x.ultima = r.fecha;
      if (e.prox && (!x.prox || e.prox < x.prox)) x.prox = e.prox;
      var orden = { vencido: 0, sin: 1, semana: 2, aldia: 3 };
      if (orden[e.clave] < orden[x.peor]) x.peor = e.clave;
    });
    return Object.keys(g).map(function (k) { return g[k]; });
  }
  var gruposSemana = {};
  function abrirSemana() {
    var lista = lotesVisibles(), grupos = grupoMicrorrutas(lista);
    var sec = { vencido: [], semana: [], sin: [] };
    grupos.forEach(function (g) { if (sec[g.peor]) sec[g.peor].push(g); });
    sec.vencido.sort(function (a, b) { return a.prox < b.prox ? -1 : 1; });
    sec.semana.sort(function (a, b) { return a.prox < b.prox ? -1 : 1; });
    sec.sin.sort(function (a, b) { return a.mr < b.mr ? -1 : 1; });
    gruposSemana = {};
    function tabla(arr, conFecha) {
      if (!arr.length) return '<p class="mr-vacio">Ninguna.</p>';
      return '<table class="mr-tabla"><tr><th>Microrruta</th><th>Cuad.</th><th>Lotes</th><th>m²</th>' + (conFecha ? '<th>Toca</th>' : '') + '<th></th></tr>' +
        arr.map(function (g) {
          gruposSemana[g.mr] = g;
          return '<tr><td>' + esc(g.mr) + '<br><small>' + esc(g.frec) + '</small></td><td>' + esc(g.cuad == null ? '' : g.cuad) + '</td><td>' + g.lotes.length + '</td><td>' + fmt(g.m2) + '</td>' +
            (conFecha ? '<td>' + esc(fechaCorta(g.prox)) + '</td>' : '') + '<td><button type="button" class="mr-mini" data-ver="' + esc(g.mr) + '">Ver</button></td></tr>';
        }).join('') + '</table>';
    }
    var filtrado = lista.length !== features.length;
    var h = abrirHoja('semana', '📅 Qué toca esta semana',
      '<p class="mr-nota-pie">Hasta el domingo ' + esc(fechaCorta(finDeSemana())) + '. Se calcula con la última intervención registrada y la frecuencia (Quincenal = ' +
      ((CONFIG.frecuenciaDias || {}).Quincenal || 15) + ' días, Mensual = ' + ((CONFIG.frecuenciaDias || {}).Mensual || 30) + ' días). ' +
      (filtrado ? 'Solo incluye los lotes del filtro actual.' : 'Use los filtros (p. ej. cuadrilla) para ver solo los suyos.') + '</p>' +
      '<h3><i style="background:' + COLOR_ESTADO.vencido + '"></i>Vencidas (' + sec.vencido.length + ')</h3>' + tabla(sec.vencido, true) +
      '<h3><i style="background:' + COLOR_ESTADO.semana + '"></i>Tocan esta semana (' + sec.semana.length + ')</h3>' + tabla(sec.semana, true) +
      '<details><summary><i style="background:' + COLOR_ESTADO.sin + '"></i>Sin ningún registro (' + sec.sin.length + ')</summary>' + tabla(sec.sin, false) + '</details>' +
      '<button type="button" class="mr-boton" id="mr-semana-csv">Descargar Excel de lo pendiente</button>');
    h.querySelectorAll('[data-ver]').forEach(function (b) {
      b.onclick = function () { verLotes(gruposSemana[b.getAttribute('data-ver')].lotes); };
    });
    h.querySelector('#mr-semana-csv').onclick = function () {
      var pend = [];
      sec.vencido.concat(sec.semana, sec.sin).forEach(function (g) { pend = pend.concat(g.lotes); });
      descargarCSV(pend, 'pendientes_semana');
    };
  }
  function verLotes(lista) {
    var capas = [];
    capa.eachLayer(function (l) { if (lista.indexOf(l.feature) !== -1) capas.push(l); });
    if (!capas.length) return;
    var b = L.featureGroup(capas).getBounds();
    map.fitBounds(b, { padding: [30, 30], maxZoom: 18 });
    capas.forEach(function (l) { l.setStyle({ color: '#d92d20', weight: 3, fillColor: '#facc15', fillOpacity: 0.75 }); });
    setTimeout(recolorear, 4000);
    if (window.innerWidth < 760) cerrarHoja();
  }

  // ---------------------------------------------------------------- ajustes del registro compartido
  function abrirAjustes() {
    var h = abrirHoja('ajustes', '⚙ Registros',
      '<label class="mr-campo">Quién registra (nombre o cuadrilla)<input id="mr-quien" value="' + esc(ajustes.quien || '') + '"></label>' +
      '<p class="mr-nota-pie" id="mr-sync"></p>' +
      '<label class="mr-campo">Dirección de la hoja compartida (Apps Script)<input id="mr-url" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(ajustes.registroUrl || '') + '"></label>' +
      '<label class="mr-campo">Clave<input id="mr-clave" value="' + esc(ajustes.clave || '') + '"></label>' +
      '<p class="mr-nota-pie">Déjelas vacías para usar las de js/configuracion.js' + (CONFIG.registroUrl ? ' (ya hay una configurada)' : ' (no hay ninguna: los registros quedan solo en este dispositivo)') + '.</p>' +
      '<button type="button" class="mr-boton" id="mr-guardar-ajustes">Guardar</button>' +
      '<hr><p class="mr-nota-pie">Copia de seguridad de los registros de este dispositivo (' + Object.keys(registros).length + ' lotes):</p>' +
      '<div class="mr-fila"><button type="button" class="mr-boton mr-sec" id="mr-exportar">Descargar copia</button>' +
      '<label class="mr-boton mr-sec">Cargar copia<input type="file" accept=".json,application/json" id="mr-importar" hidden></label></div>');
    actualizarEstadoSync();
    h.querySelector('#mr-guardar-ajustes').onclick = function () {
      ajustes.quien = h.querySelector('#mr-quien').value.trim();
      ajustes.registroUrl = h.querySelector('#mr-url').value.trim();
      ajustes.clave = h.querySelector('#mr-clave').value.trim();
      guardar(CLAVE_AJUSTES, ajustes);
      aviso('Ajustes guardados.');
      enviarPendientes(); traerRegistros();
    };
    h.querySelector('#mr-exportar').onclick = function () {
      descargar('registros_microrrutas_' + hoyISO() + '.json', JSON.stringify(registros), 'application/json');
    };
    h.querySelector('#mr-importar').onchange = function (ev) {
      var archivo = ev.target.files[0];
      if (!archivo) return;
      archivo.text().then(function (t) {
        var otros = JSON.parse(t), n = 0;
        Object.keys(otros).forEach(function (fid) {
          if (!registros[fid] || (otros[fid].hora || '') > (registros[fid].hora || '')) { registros[fid] = otros[fid]; n++; }
        });
        guardar(CLAVE_REG, registros);
        refrescarTodo();
        aviso(n + ' registros cargados.');
      }).catch(function () { aviso('Ese archivo no es una copia válida.'); });
    };
  }

  // ---------------------------------------------------------------- panel de filtros: nuevas secciones
  var menu = document.getElementById('menu');
  var css = document.createElement('style');
  css.textContent =
    '.mr-seccion{margin:0 0 16px;padding:12px;border:1px solid var(--line);border-radius:10px;background:#f8fbfa}' +
    '.mr-seccion h3{margin:0 0 8px;font-size:13px;color:#475569}' +
    '.mr-cifras{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;text-align:center}' +
    '.mr-cifras b{display:block;font-size:17px;color:var(--ink);font-variant-numeric:tabular-nums}.mr-cifras span{font-size:11px;color:#64748b}' +
    '.mr-estados{display:flex;flex-wrap:wrap;gap:4px 10px;margin:8px 0 4px;font-size:11px;color:#475569}' +
    '.mr-estados i,.mr-chip i,.mr-estado i,#mr-hoja h3 i,#mr-hoja summary i,.mr-punto{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}' +
    '.mr-seccion details,#mr-hoja details{margin-top:6px;font-size:12px}.mr-seccion summary,#mr-hoja summary{cursor:pointer;color:var(--brand);font-weight:600}' +
    '.mr-tabla{width:100%;border-collapse:collapse;font-size:12px;margin:6px 0;font-variant-numeric:tabular-nums}' +
    '.mr-tabla th{text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid var(--line);padding:3px 4px}' +
    '.mr-tabla td{border-bottom:1px solid #eef2f4;padding:4px;vertical-align:top}.mr-tabla td:nth-child(n+2){text-align:right}' +
    '.mr-tabla small{color:#64748b}' +
    '.mr-seccion select,.mr-campo input{width:100%;min-height:36px;box-sizing:border-box;border:1px solid var(--line);border-radius:8px;padding:6px;font:inherit;background:#fff;color:var(--ink)}' +
    '.mr-leyenda{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:8px;font-size:11px;color:#475569}' +
    '.mr-boton{display:block;width:100%;margin:6px 0 0;padding:9px 12px;border:0;border-radius:8px;color:#fff;background:var(--brand);font:inherit;font-size:13px;font-weight:650;cursor:pointer;text-align:center;box-sizing:border-box}' +
    '.mr-boton.mr-sec,.mr-registro .mr-sec{color:var(--brand);background:#e3f3ec}' +
    '.mr-fila{display:flex;gap:8px}.mr-fila>*{flex:1}' +
    '.mr-llegar{margin:6px 0 0}' +
    '.mr-registro{margin-top:8px;padding-top:8px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:5px}' +
    '.mr-registro small{color:#475569}.mr-estado{font-size:13px}' +
    '.mr-registro textarea{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:8px;padding:6px;font:inherit;font-size:12px;resize:vertical}' +
    '.mr-archivo{font-size:12px;color:var(--brand);cursor:pointer}.mr-archivo input{display:block;font-size:11px;margin-top:3px;max-width:100%}' +
    '.mr-registro button{border:0;border-radius:8px;padding:8px;font:inherit;font-size:12px;font-weight:650;color:#fff;background:var(--brand);cursor:pointer}' +
    '.mr-registro button:disabled{opacity:.6}.mr-registro .mr-link{background:none;color:#b91c1c;font-weight:500;padding:2px}' +
    '.mr-foto{max-width:100%;border-radius:8px;margin-top:4px}' +
    '#mr-hoja{display:none;position:fixed;z-index:2500;top:12px;right:12px;width:380px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 16px 40px rgba(15,45,35,.25);font-size:13px}' +
    '#mr-hoja.is-open{display:block}#mr-hoja header{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--surface);border-bottom:1px solid var(--line)}' +
    '#mr-hoja h2{margin:0;font-size:15px}#mr-hoja h3{margin:14px 0 4px;font-size:13px}.mr-cuerpo{padding:4px 14px 14px}' +
    '.mr-cerrar{border:0;background:none;font-size:18px;cursor:pointer;color:#64748b;min-width:36px;min-height:36px}' +
    '.mr-mini{border:0;border-radius:6px;padding:4px 8px;background:#e3f3ec;color:var(--brand);font:inherit;font-size:12px;font-weight:650;cursor:pointer}' +
    '.mr-vacio,.mr-nota-pie{color:#64748b;font-size:12px;margin:4px 0}' +
    '.mr-campo{display:block;font-size:12px;font-weight:600;color:#475569;margin:8px 0}.mr-campo input{margin-top:4px;font-weight:400}' +
    '.mr-control a{font-size:17px;line-height:30px;text-align:center;cursor:pointer}.mr-control a.is-activo{background:#facc15}' +
    '#mr-aviso{position:fixed;left:50%;bottom:20px;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;z-index:3000;background:#1f2937;color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;transition:.2s;max-width:calc(100vw - 32px)}' +
    '#mr-aviso.is-visible{opacity:1;transform:translateX(-50%)}' +
    '.mr-modo-area .leaflet-container,.mr-modo-area #map{cursor:crosshair!important;touch-action:none}' +
    '@media (max-width:760px){#mr-hoja{top:auto;bottom:8px;left:8px;right:8px;width:auto;max-height:70dvh}}';
  document.head.appendChild(css);

  var seccion = document.createElement('div');
  seccion.innerHTML =
    '<div class="mr-seccion"><h3>Resumen de lo visible</h3><div id="mr-resumen"></div></div>' +
    '<div class="mr-seccion"><h3>Colorear por</h3><select id="mr-color">' +
    '<option value="cuadrilla">Cuadrilla</option><option value="frecuencia">Frecuencia</option><option value="estado">Estado (vencido / esta semana / al día)</option>' +
    '</select><div class="mr-leyenda" id="mr-leyenda"></div></div>' +
    '<div class="mr-seccion"><h3>Operación</h3>' +
    '<button type="button" class="mr-boton" id="mr-btn-semana">📅 Qué toca esta semana</button>' +
    '<button type="button" class="mr-boton mr-sec" id="mr-btn-csv">Descargar Excel (CSV) de lo visible</button>' +
    '<button type="button" class="mr-boton mr-sec" id="mr-btn-ajustes">⚙ Registros y hoja compartida</button></div>';
  var kml = document.getElementById('download-kml');
  while (seccion.firstChild) kml.parentNode.insertBefore(seccion.firstChild, kml.nextSibling ? kml.nextSibling : null), kml = kml.nextSibling;
  var selColor = document.getElementById('mr-color');
  selColor.value = modoColor;
  document.getElementById('mr-leyenda').innerHTML = leyendaHTML();
  selColor.onchange = function () {
    modoColor = selColor.value;
    guardar('microrutas_color', modoColor);
    document.getElementById('mr-leyenda').innerHTML = leyendaHTML();
    recolorear();
  };
  document.getElementById('mr-btn-semana').onclick = abrirSemana;
  document.getElementById('mr-btn-csv').onclick = function () { descargarCSV(lotesVisibles(), 'lotes_visibles'); };
  document.getElementById('mr-btn-ajustes').onclick = abrirAjustes;

  // Filtros nuevos: microrruta (texto) y frecuencia (lista); nombres claros para los existentes
  window.Filters.Microruta = 'str';
  window.Filters.Frecuencia = 'str';
  function nuevoFiltro(id, etiqueta, control) {
    var div = document.createElement('div');
    div.className = 'filterselect';
    div.id = 'div_' + id;
    div.appendChild(control);
    var lab = document.createElement('div'); lab.className = 'filterlabel'; lab.textContent = etiqueta; div.appendChild(lab);
    var limpiar = document.createElement('div'); limpiar.className = 'filterlabel'; limpiar.textContent = 'Quitar filtro'; div.appendChild(limpiar);
    limpiar.onclick = function () {
      if (control.tagName === 'SELECT') for (var i = 0; i < control.options.length; i++) control.options[i].selected = false;
      else control.value = '';
      window.filterFunc();
    };
    return div;
  }
  var inMr = document.createElement('input');
  inMr.type = 'search'; inMr.id = 'search_Microruta'; inMr.placeholder = 'Microrrutas separadas por coma (Z2CC0229, …)';
  inMr.onchange = function () { inMr.value = inMr.value.toUpperCase(); window.filterFunc(); };
  var selFrec = document.createElement('select');
  selFrec.multiple = true; selFrec.size = 3; selFrec.id = 'sel_Frecuencia';
  selFrec.innerHTML = '<option value="Quincenal">Quincenal</option><option value="Mensual">Mensual</option><option value="Sin programación">Sin programación</option>';
  selFrec.onchange = function () { window.filterFunc(); };
  var divCuad = document.getElementById('div_CUADRILLA');
  var divMr = nuevoFiltro('Microruta', 'Microrruta', inMr), divFrec = nuevoFiltro('Frecuencia', 'Frecuencia', selFrec);
  divCuad.parentNode.insertBefore(divFrec, divCuad.nextSibling);
  divCuad.parentNode.insertBefore(divMr, divCuad.nextSibling);
  [['div_CUADRILLA', 'Cuadrilla'], ['div_No_Lote', 'Lote'], ['div_Zona', 'Zona'], ['div_NOMBRE', 'Comuna / corregimiento']].forEach(function (x) {
    var d = document.getElementById(x[0]);
    if (!d) return;
    var labs = d.querySelectorAll('.filterlabel');
    if (labs[0]) labs[0].textContent = x[1];
    if (labs[1]) labs[1].textContent = 'Quitar filtro';
  });
  // La lista de Zona traía una opción vacía que no filtraba nada
  var selZona = document.getElementById('sel_Zona');
  if (selZona) Array.prototype.slice.call(selZona.options).forEach(function (o) { if (!o.value) o.remove(); });
  var selNombre = document.getElementById('sel_NOMBRE');
  if (selNombre) Array.prototype.slice.call(selNombre.options).forEach(function (o) { if (!o.value.trim()) o.remove(); });

  // Después de cada filtro: resumen, colores y leyenda
  var filtroOriginal = window.filterFunc;
  window.filterFunc = function () {
    filtroOriginal.apply(this, arguments);
    refrescarTodo();
  };
  var buscarLotes = document.getElementById('search_No_Lote');
  if (buscarLotes) buscarLotes.onchange = window.filterFunc;

  // ---------------------------------------------------------------- 6. Resumen por comuna
  function resumenComuna(feature) {
    var nombre = feature.properties.NOMBRE, clave = sinTildes(nombre);
    var lista = features.filter(function (f) { return sinTildes(f.properties.NOMBRE) === clave; });
    var html = '<div style="min-width:240px"><b style="font-size:14px">' + esc(feature.properties.IDENTIFICA || '') + ' – ' + esc(nombre) + '</b>';
    if (!lista.length) return html + '<p>No hay lotes registrados en esta comuna.</p></div>';
    html += resumenHTML(lista).replace('<details>', '<details open>');
    var frec = {};
    lista.forEach(function (f) { frec[f.properties.Frecuencia] = (frec[f.properties.Frecuencia] || 0) + 1; });
    html += '<small>' + Object.keys(frec).map(function (k) { return esc(k) + ': ' + frec[k] + ' lotes'; }).join(' · ') + '</small>';
    html += '<div class="mr-fila" style="margin-top:6px"><button type="button" class="mr-mini" data-comuna-filtrar="' + esc(nombre) + '">Filtrar esta comuna</button>' +
      '<button type="button" class="mr-mini" data-comuna-csv="' + esc(nombre) + '">Descargar Excel</button></div></div>';
    return html;
  }
  window.pop_Comunas_1 = function (feature, layer) {
    layer.bindPopup(function () { return resumenComuna(feature); }, { maxHeight: 440, maxWidth: 340 });
  };
  map.on('popupopen', function (e) {
    var el = e.popup.getElement();
    if (!el) return;
    var bf = el.querySelector('[data-comuna-filtrar]'), bc = el.querySelector('[data-comuna-csv]');
    if (bf) bf.onclick = function () {
      var n = sinTildes(bf.getAttribute('data-comuna-filtrar'));
      if (selNombre) Array.prototype.slice.call(selNombre.options).forEach(function (o) { o.selected = sinTildes(o.value) === n; });
      map.closePopup();
      window.filterFunc();
    };
    if (bc) bc.onclick = function () {
      var n = sinTildes(bc.getAttribute('data-comuna-csv'));
      descargarCSV(features.filter(function (f) { return sinTildes(f.properties.NOMBRE) === n; }), 'comuna_' + n.replace(/\W+/g, '_'));
    };
  });

  // ---------------------------------------------------------------- 3. ¿Qué lote es aquí? (GPS) + 7. Seleccionar área
  window.extraPuntoLote = function (lat, lon) {
    var sel = document.getElementById('sel_CUADRILLA');
    var cuads = sel ? Array.prototype.slice.call(sel.selectedOptions).map(function (o) { return o.value; }).filter(Boolean) : [];
    if (!cuads.length) return '';
    var mejor = null, mejorPend = null;
    features.forEach(function (f) {
      if (cuads.indexOf(String(f.properties.CUADRILLA)) === -1) return;
      var g = f.geometry, polys = !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      if (!polys.length) return;
      var d = Infinity;   // distancia al borde, como en la lista de arriba
      polys.forEach(function (p) {
        var r = p[0];
        if (dentro(lon, lat, r)) d = 0;
        for (var i = 0; i < r.length && d > 0; i++) d = Math.min(d, window.distanciaM(lat, lon, r[i][1], r[i][0]));
      });
      if (!mejor || d < mejor.d) mejor = { f: f, d: d };
      if (estado(f).clave !== 'aldia' && (!mejorPend || d < mejorPend.d)) mejorPend = { f: f, d: d };
    });
    function linea(x, titulo) {
      if (!x) return '';
      var p = x.f.properties;
      return '<br><b>' + titulo + ':</b> ' + esc(mr(x.f)) + ' · lote ' + esc(p.No_Lote || 'NA') + ' (a ' + fmt(x.d) + ' m) ' + window.enlacesComoLlegar(x.f, true);
    }
    return '<hr style="margin:6px 0">Cuadrilla ' + esc(cuads.join(', ')) + ':' + linea(mejor, 'Más cercano') +
      (mejorPend && mejorPend.f !== mejor.f ? linea(mejorPend, 'Pendiente más cercano') : (mejorPend ? ' <small>(pendiente)</small>' : ''));
  };

  var modoArea = false, inicioArea = null, recuadro = null;
  var Herramientas = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      var div = L.DomUtil.create('div', 'leaflet-bar mr-control');
      div.innerHTML = '<a href="#" id="mr-btn-aqui" title="¿Qué lote es aquí? (usa el GPS)" role="button">🎯</a>' +
        '<a href="#" id="mr-btn-area" title="Seleccionar un área: arrastre un recuadro en el mapa" role="button">⬚</a>';
      L.DomEvent.disableClickPropagation(div);
      div.querySelector('#mr-btn-aqui').onclick = function (e) { e.preventDefault(); queLoteAqui(this); };
      div.querySelector('#mr-btn-area').onclick = function (e) { e.preventDefault(); alternarArea(!modoArea); };
      return div;
    }
  });
  new Herramientas().addTo(map);

  function queLoteAqui(boton) {
    if (!navigator.geolocation) { aviso('Este navegador no permite usar la ubicación.'); return; }
    boton.textContent = '⏳';
    navigator.geolocation.getCurrentPosition(function (pos) {
      boton.textContent = '🎯';
      var c = pos.coords;
      window.mostrarPuntoLote(c.latitude, c.longitude, 'Usted está aquí', 'Precisión del GPS: ±' + Math.round(c.accuracy) + ' m');
    }, function (err) {
      boton.textContent = '🎯';
      aviso(err.code === 1 ? 'Debe permitir el acceso a la ubicación en el navegador.' : 'No se pudo obtener la ubicación. Intente de nuevo al aire libre.', 5000);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
  }

  function alternarArea(activo) {
    modoArea = activo;
    var b = document.getElementById('mr-btn-area');
    if (b) b.classList.toggle('is-activo', activo);
    document.body.classList.toggle('mr-modo-area', activo);
    if (activo) { map.dragging.disable(); aviso('Arrastre un recuadro sobre el mapa para seleccionar los lotes.', 4000); }
    else map.dragging.enable();
  }
  var contenedor = map.getContainer(), ignorarClic = false;
  function latlngDe(ev) { return map.mouseEventToLatLng(ev); }
  // el clic que el navegador genera al soltar el recuadro no debe abrir el lote de abajo
  contenedor.addEventListener('click', function (ev) { if (ignorarClic) { ev.stopPropagation(); ev.preventDefault(); } }, true);
  contenedor.addEventListener('pointerdown', function (ev) {
    if (!modoArea || ev.target.closest('.leaflet-control,.leaflet-popup')) return;
    ev.preventDefault();
    inicioArea = latlngDe(ev);
    if (recuadro) map.removeLayer(recuadro);
    recuadro = L.rectangle(L.latLngBounds(inicioArea, inicioArea), { color: '#d92d20', weight: 2, dashArray: '6 4', fillOpacity: 0.08, interactive: false }).addTo(map);
    try { contenedor.setPointerCapture(ev.pointerId); } catch (e) {}
  });
  contenedor.addEventListener('pointermove', function (ev) {
    if (!modoArea || !inicioArea) return;
    recuadro.setBounds(L.latLngBounds(inicioArea, latlngDe(ev)));
  });
  contenedor.addEventListener('pointerup', function (ev) {
    if (!modoArea || !inicioArea) return;
    var limites = L.latLngBounds(inicioArea, latlngDe(ev));
    inicioArea = null;
    ignorarClic = true;
    setTimeout(function () { ignorarClic = false; }, 400);
    alternarArea(false);
    var ne = map.latLngToContainerPoint(limites.getNorthEast()), so = map.latLngToContainerPoint(limites.getSouthWest());
    if (Math.abs(ne.x - so.x) < 8 || Math.abs(ne.y - so.y) < 8) { map.removeLayer(recuadro); recuadro = null; aviso('El recuadro es muy pequeño.'); return; }
    var lista = lotesVisibles().filter(function (f) { var c = centro(f); return c && limites.contains(c); });
    abrirArea(lista);
  });
  function abrirArea(lista) {
    var h = abrirHoja('area', '⬚ Área seleccionada',
      (lista.length ? resumenHTML(lista).replace('<details>', '<details open>') : '<p class="mr-vacio">No hay lotes (de los visibles) dentro del recuadro.</p>') +
      (lista.length ? '<button type="button" class="mr-boton" id="mr-area-kml">Agregar a la selección (Descargar KML)</button>' +
        '<button type="button" class="mr-boton mr-sec" id="mr-area-csv">Descargar Excel (CSV)</button>' : '') +
      '<button type="button" class="mr-boton mr-sec" id="mr-area-borrar">Quitar recuadro</button>');
    var quitar = function () { if (recuadro) { map.removeLayer(recuadro); recuadro = null; } cerrarHoja(); };
    h.querySelector('.mr-cerrar').onclick = quitar;
    h.querySelector('#mr-area-borrar').onclick = quitar;
    if (!lista.length) return;
    h.querySelector('#mr-area-csv').onclick = function () { descargarCSV(lista, 'area_seleccionada'); };
    h.querySelector('#mr-area-kml').onclick = function () {
      lista.forEach(function (f) { if (window.lotesSeleccionados.indexOf(f) === -1) window.lotesSeleccionados.push(f); });
      recolorear();
      window.actualizarBotonKml();
      aviso(lista.length + ' lotes agregados. Use "Descargar KML" en el panel de filtros.');
    };
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (modoArea) alternarArea(false); cerrarHoja(); }
  });

  // ---------------------------------------------------------------- arranque
  recolorear();
  refrescarResumen();
  traerRegistros();
  enviarPendientes();
})();
