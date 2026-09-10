// sync.js — jala el Google Sheet completo y espeja las filas a SQLite local.
//
// Diseño clave: el Sheet es la fuente de verdad. Este script NUNCA escribe
// al Sheet, solo lee. Si el sync falla o la Pi estuvo apagada varios días,
// simplemente vuelve a leer todo el Sheet la próxima vez — no hay estado
// incremental frágil que se pueda desincronizar. Con el volumen de datos de
// un tracker personal (unos cuantos miles de filas en varios años), leer
// todo cada vez es barato y mucho más robusto que llevar un cursor.

require('dotenv').config();
const fs = require('fs');
const { google } = require('googleapis');
const { db, syncMovimientos, replaceSaldos, setMeta } = require('./db');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Movimientos';
const SHEET_SALDOS = process.env.SHEET_SALDOS || 'Saldos';
const KEY_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './service-account.json';

async function getSheetsClient() {
  if (!fs.existsSync(KEY_FILE)) {
    throw new Error(
      `No encuentro el archivo de credenciales en ${KEY_FILE}. Revisa la Fase 2 del README.`
    );
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// --- normalización de campos ---------------------------------------------

/**
 * Convierte lo que venga en la celda `monto` a un número, o null si no se puede.
 *
 * Con valueRenderOption UNFORMATTED_VALUE esto recibe un number y devuelve el
 * mismo number. El resto del cuerpo es una red de seguridad para celdas que
 * quedaron guardadas como TEXTO — algo que pasa fácil cuando escribís "1234.56"
 * a mano en un Sheet cuyo locale espera coma decimal: Sheets no lo reconoce
 * como número y lo guarda como cadena.
 *
 * Ambigüedad conocida: "1.000" puede ser mil (separador de miles) o uno con
 * tres decimales. Se asume miles, que es lo que ocurre en la práctica, y se
 * deja constancia acá porque es una decisión, no una casualidad.
 */
function parseMonto(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (valor === null || valor === undefined) return null;

  let s = String(valor).trim();
  if (!s) return null;

  s = s.replace(/[^\d,.-]/g, ''); // fuera "$", espacios, NBSP…
  if (!s || s === '-') return null;

  const ultimaComa = s.lastIndexOf(',');
  const ultimoPunto = s.lastIndexOf('.');
  const corte = Math.max(ultimaComa, ultimoPunto);

  if (corte !== -1) {
    const entero = s.slice(0, corte).replace(/[.,]/g, '');
    const decimal = s.slice(corte + 1).replace(/[.,]/g, '');
    const haySoloUnSeparador = ultimaComa === -1 || ultimoPunto === -1;
    // "1.000" / "1,000" -> miles, no decimales
    s = haySoloUnSeparador && decimal.length === 3 ? entero + decimal : `${entero}.${decimal}`;
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * La columna `fecha` es texto "YYYY-MM-DD" en la práctica, pero si alguna celda
 * quedó como fecha real de Sheets puede llegar como número de serie (días desde
 * 1899-12-30). Esto la devuelve siempre como "YYYY-MM-DD".
 */
function normalizeFecha(valor) {
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    const ms = Math.round((valor - 25569) * 86400 * 1000); // 25569 = 1970-01-01
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(valor || '').trim();
  return s.length > 10 && s.includes('T') ? s.slice(0, 10) : s;
}

/**
 * Lee la hoja `Saldos` (fecha | cuenta | saldo), si existe.
 *
 * Es OPCIONAL a propósito: el tracker funcionaba antes de que esta hoja
 * existiera y tiene que seguir funcionando si alguien clona el repo y no la
 * crea. Si la hoja no está, la API responde 400 con "Unable to parse range"
 * y eso NO es un error del sync: se avisa una vez y se sigue.
 */
async function syncSaldos(sheets) {
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_SALDOS}!A2:C`,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
  } catch (err) {
    const msg = String(err.message || '');
    if (msg.includes('Unable to parse range') || msg.includes('not found')) {
      // Limpiar, no dejar huérfano: si la hoja existió y se borró, los
      // saldos viejos en la Pi tienen que borrarse con ella. Si no, el
      // patrimonio queda calculado con datos que el usuario ya sacó del
      // Sheet, sin ninguna forma de notarlo.
      replaceSaldos([]);
      console.log(`[sync] hoja "${SHEET_SALDOS}" no existe — patrimonio deshabilitado`);
      return 0;
    }
    throw err;
  }

  const filas = (res.data.values || [])
    .filter((r) => r[0] && r[1])
    .map((r) => ({ fecha: normalizeFecha(r[0]), cuenta: String(r[1]).trim(), saldo: parseMonto(r[2]) }))
    .filter((r) => r.saldo !== null);

  replaceSaldos(filas);
  return filas.length;
}

/**
 * Wrapper delgado alrededor de syncOnceInner() que registra en `meta` cuándo
 * fue el último sync exitoso y cuál fue el último error, sin importar quién
 * la llamó (arranque, cron, el botón Sincronizar, o `npm run sync-once`).
 * Antes un fallo solo dejaba rastro en `journalctl` — si nadie miraba la
 * consola, el dashboard seguía mostrando datos viejos sin ningún aviso.
 */
async function syncOnce() {
  try {
    const n = await syncOnceInner();
    setMeta('lastSyncAt', new Date().toISOString());
    setMeta('lastSyncError', '');
    return n;
  } catch (err) {
    setMeta('lastSyncErrorAt', new Date().toISOString());
    setMeta('lastSyncError', err.message);
    throw err;
  }
}

async function syncOnceInner() {
  if (!SHEET_ID) throw new Error('Falta SHEET_ID en .env');

  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:H`, // A1:H1 son encabezados, se ignoran

    // UNFORMATTED_VALUE es OBLIGATORIO, no una optimización.
    // El default de la API es FORMATTED_VALUE: devuelve el texto tal como se VE
    // en pantalla, con el locale del Sheet aplicado. Con un Sheet en español,
    // 1000 vuelve como la cadena "1.000,00" y `Number("1.000,00")` es NaN, que
    // el `|| 0` de antes convertía en 0 sin avisar: el sueldo entero
    // desaparecía del dashboard en silencio. Con UNFORMATTED_VALUE la API
    // manda el número crudo y el locale deja de importar.
    valueRenderOption: 'UNFORMATTED_VALUE',
    // Contrapartida: si `fecha` fuera una fecha real de Sheets (no texto),
    // UNFORMATTED_VALUE la devolvería como número de serie. Esto la mantiene
    // legible; normalizeFecha() cubre el caso igual por si acaso.
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const values = res.data.values || [];
  const descartadas = [];

  const rows = values
    .filter((r) => r[0]) // descarta filas sin id
    .map((r) => {
      const monto = parseMonto(r[4]);
      if (monto === null) descartadas.push({ id: String(r[0]), crudo: r[4] });
      return {
        id: String(r[0]),
        fecha: normalizeFecha(r[1]),
        categoria: r[2] || '',
        metodo_pago: r[3] || '',
        monto: monto === null ? 0 : monto,
        nota: r[5] || '',
        tipo: r[6] || 'Gasto',
        recibido_en: r[7] || '',
      };
    });

  syncMovimientos(rows);
  const nSaldos = await syncSaldos(sheets);
  console.log(
    `[sync] ${new Date().toISOString()} — ${rows.length} movimientos, ${nSaldos} saldos`
  );

  // Ruidoso a propósito: un monto que no se puede leer es plata que desaparece
  // del dashboard. Antes esto se tragaba con `|| 0` y no había forma de notarlo.
  if (descartadas.length) {
    console.warn(`[sync] ¡OJO! ${descartadas.length} fila(s) con monto ilegible, guardadas como 0:`);
    for (const d of descartadas) console.warn(`  id=${d.id} monto=${JSON.stringify(d.crudo)}`);
  }

  return rows.length;
}

if (require.main === module) {
  syncOnce()
    .then(() => {
      // Cerrar la base ANTES de salir, no después: `process.exit()` corta el
      // proceso ya, sin esperar a que el GC finalice los prepared statements
      // que better-sqlite3 dejó vivos. En ese cruce (limpieza nativa en
      // marcha + entorno de Node destruyéndose) V8 puede plantar:
      //   Assertion failed: (env) != nullptr
      //   at node::RemoveEnvironmentCleanupHook(...)
      // db.close() finaliza todo en el hilo principal, de forma sincrónica,
      // así que cuando llega el exit ya no queda nada nativo pendiente.
      db.close();
      process.exit(0);
    })
    .catch((err) => {
      console.error('[sync] error:', err.message);
      try { db.close(); } catch (_) {}
      process.exit(1);
    });
}

module.exports = { syncOnce, syncSaldos, parseMonto, normalizeFecha };
