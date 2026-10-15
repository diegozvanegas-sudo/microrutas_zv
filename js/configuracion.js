/*
 * Configuración del mapa de microrrutas.
 *
 * registroUrl: dirección de la "Aplicación web" de Google Apps Script que guarda los
 *   lotes intervenidos en una hoja de Google y las fotos en Google Drive (ver
 *   integraciones/registro_apps_script.gs y LEEME_DESPLIEGUE.txt).
 *   Vacío = cada celular guarda sus registros solo para sí (no se comparten).
 * clave: la misma CLAVE que se ponga en el Apps Script (evita que extraños escriban).
 * frecuenciaDias: cada cuántos días toca volver a intervenir un lote según su frecuencia.
 */
window.CONFIG_MICRORUTAS = {
  registroUrl: '',
  clave: '',
  frecuenciaDias: { Semanal: 7, Quincenal: 15, Mensual: 30, Bimestral: 60, Trimestral: 90 },
  frecuenciaPorDefecto: 30,
  revisarCadaSegundos: 60
};
