/**
 * Registro compartido de lotes intervenidos (Google Sheets + fotos en Google Drive).
 *
 * Instalación (una sola vez, ~5 minutos):
 *  1. Cree una hoja de cálculo nueva en Google Sheets (p. ej. "Registro microrrutas").
 *  2. Menú Extensiones > Apps Script. Borre lo que haya y pegue TODO este archivo.
 *  3. Cambie CLAVE por una palabra secreta (la misma que irá en js/configuracion.js).
 *  4. Guardar. Luego "Implementar" > "Nueva implementación" > tipo "Aplicación web":
 *       - Ejecutar como: Yo
 *       - Quién tiene acceso: Cualquier usuario
 *     Autorice los permisos que pide Google (hoja y Drive de su cuenta).
 *  5. Copie la "URL de la aplicación web" (termina en /exec) y péguela en
 *     js/configuracion.js -> registroUrl  (y la clave en -> clave).
 *
 * Cada vez que alguien marca un lote, se agrega una fila (historial completo) y,
 * si mandó foto, se guarda en la carpeta de Drive "Microrrutas - fotos".
 */
var CLAVE = 'cambie-esta-clave';
var NOMBRE_HOJA = 'Registros';
var CARPETA_FOTOS = 'Microrrutas - fotos';
var COLUMNAS = ['hora', 'fid', 'microruta', 'lote', 'cuadrilla', 'fecha', 'nota', 'quien', 'foto'];

function hoja_() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(NOMBRE_HOJA);
  if (!hoja) {
    hoja = libro.insertSheet(NOMBRE_HOJA);
    hoja.getRange(1, 1, 1, COLUMNAS.length).setValues([COLUMNAS]).setFontWeight('bold');
    hoja.getRange('A:I').setNumberFormat('@'); // todo como texto: fechas tal cual
    hoja.setFrozenRows(1);
  }
  return hoja;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Lectura: devuelve el último registro de cada lote
function doGet(e) {
  if (CLAVE && (e.parameter.clave || '') !== CLAVE) return json_({ ok: false, error: 'clave incorrecta' });
  var valores = hoja_().getDataRange().getDisplayValues();
  var cab = valores.shift();
  var ultimo = {};
  valores.forEach(function (fila) {
    var r = {};
    cab.forEach(function (c, i) { r[c] = fila[i]; });
    if (!r.fid) return;
    if (!ultimo[r.fid] || r.hora > ultimo[r.fid].hora) ultimo[r.fid] = r;
  });
  return json_({ ok: true, registros: Object.keys(ultimo).map(function (k) { return ultimo[k]; }) });
}

// Escritura: {accion:'registrar', clave, registros:[...], foto: 'data:image/jpeg;base64,...' | null}
function doPost(e) {
  var datos = JSON.parse(e.postData.contents);
  if (CLAVE && (datos.clave || '') !== CLAVE) return json_({ ok: false, error: 'clave incorrecta' });
  var bloqueo = LockService.getScriptLock();
  bloqueo.waitLock(20000);
  try {
    var urlFoto = '';
    if (datos.foto) {
      var carpetas = DriveApp.getFoldersByName(CARPETA_FOTOS);
      var carpeta = carpetas.hasNext() ? carpetas.next() : DriveApp.createFolder(CARPETA_FOTOS);
      var r0 = datos.registros[0] || {};
      var base64 = datos.foto.split(',')[1];
      var archivo = carpeta.createFile(Utilities.newBlob(Utilities.base64Decode(base64), 'image/jpeg',
        (r0.fecha || 'foto') + '_' + (r0.microruta || '') + '_lote' + (r0.lote || '') + '.jpg'));
      archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      urlFoto = 'https://drive.google.com/thumbnail?id=' + archivo.getId() + '&sz=w900';
    }
    var filas = datos.registros.map(function (r) {
      return COLUMNAS.map(function (c) { return c === 'foto' ? (urlFoto || '') : String(r[c] == null ? '' : r[c]); });
    });
    if (filas.length) {
      var hoja = hoja_();
      hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, COLUMNAS.length).setNumberFormat('@').setValues(filas);
    }
    return json_({ ok: true, filas: filas.length, foto: urlFoto });
  } finally {
    bloqueo.releaseLock();
  }
}
