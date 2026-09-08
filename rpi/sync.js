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
const { upsertMovimientos } = require('./db');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Movimientos';
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

async function syncOnce() {
  if (!SHEET_ID) throw new Error('Falta SHEET_ID en .env');

  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:H`, // A1:H1 son encabezados, se ignoran
  });

  const values = res.data.values || [];
  const rows = values
    .filter((r) => r[0]) // descarta filas sin id
    .map((r) => ({
      id: String(r[0]),
      fecha: r[1] || '',
      categoria: r[2] || '',
      metodo_pago: r[3] || '',
      monto: Number(r[4]) || 0,
      nota: r[5] || '',
      tipo: r[6] || 'Gasto',
      recibido_en: r[7] || '',
    }));

  upsertMovimientos(rows);
  console.log(`[sync] ${new Date().toISOString()} — ${rows.length} filas sincronizadas`);
  return rows.length;
}

if (require.main === module) {
  syncOnce()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[sync] error:', err.message);
      process.exit(1);
    });
}

module.exports = { syncOnce };
