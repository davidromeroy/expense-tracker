/**
 * Apps Script Web App — receptor de movimientos (gastos, ingresos, inversiones,
 * ahorro) desde el Atajo de iOS.
 *
 * Cómo desplegar:
 * 1. Abre tu Google Sheet de movimientos.
 * 2. Extensiones > Apps Script.
 * 3. Pega este archivo reemplazando el contenido de Code.gs.
 * 4. Ajusta SHEET_NAME y SHARED_SECRET abajo.
 * 5. Implementar > Nueva implementación > Tipo: Aplicación web.
 *    - Ejecutar como: Yo (tu cuenta)
 *    - Quién tiene acceso: Cualquiera (necesario para que el Atajo la llame sin login)
 * 6. Copia la URL que te da (termina en /exec). Esa es la que usa el Atajo.
 *
 * Seguridad: como el acceso es "Cualquiera", cualquiera con la URL podría escribir
 * filas. Por eso exigimos un SHARED_SECRET simple en el body — no es seguridad
 * fuerte, pero evita que un bot random que encuentre la URL te ensucie el Sheet.
 * Si quieres algo más serio, cambia el acceso a "Cualquiera con cuenta de Google"
 * y valida Session.getActiveUser() en vez del secreto.
 */

const SHEET_NAME = 'Movimientos';
const SHARED_SECRET = 'CAMBIA_ESTO_POR_ALGO_TUYO'; // debe coincidir con el Atajo
const TIPOS_VALIDOS = ['Gasto', 'Ingreso', 'Ahorro', 'Inversión'];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
    }

    const { id, fecha, categoria, metodo_pago, monto, nota, tipo } = body;

    if (!id || !fecha || !categoria || monto === undefined || monto === null) {
      return jsonResponse({ ok: false, error: 'faltan campos requeridos (id, fecha, categoria, monto)' }, 400);
    }

    const tipoFinal = tipo || 'Gasto'; // si el Atajo aún no manda tipo, asume Gasto
    if (TIPOS_VALIDOS.indexOf(tipoFinal) === -1) {
      return jsonResponse({ ok: false, error: `tipo inválido: ${tipoFinal}` }, 400);
    }

    const montoNum = Number(monto);
    if (isNaN(montoNum)) {
      return jsonResponse({ ok: false, error: 'monto no es numérico' }, 400);
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) {
      return jsonResponse({ ok: false, error: `no existe la hoja "${SHEET_NAME}"` }, 500);
    }

    // Idempotencia: si el Atajo reintenta por mala conexión, no duplicamos la fila.
    if (rowWithIdExists(sheet, id)) {
      return jsonResponse({ ok: true, duplicate: true });
    }

    sheet.appendRow([
      id,
      fecha,
      categoria,
      metodo_pago || '',
      montoNum,
      nota || '',
      tipoFinal,
      new Date().toISOString(), // timestamp de recepción del servidor
    ]);

    return jsonResponse({ ok: true, duplicate: false });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
}

function rowWithIdExists(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false; // solo encabezados
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  return ids.indexOf(id) !== -1;
}

function jsonResponse(obj, statusCode) {
  // Apps Script no permite fijar status HTTP en Web Apps clásicas; el statusCode
  // queda solo como referencia dentro del propio JSON para quien llame.
  const out = ContentService.createTextOutput(JSON.stringify(Object.assign({}, obj, { statusCode })));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}

/**
 * Encabezados esperados en la fila 1 de la hoja "Movimientos" (en este orden, A-H):
 * id | fecha | categoria | metodo_pago | monto | nota | tipo | recibido_en
 *
 * tipo: uno de 'Gasto', 'Ingreso', 'Ahorro', 'Inversión'.
 */
