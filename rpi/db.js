// db.js — capa de acceso a la SQLite local.
// SQLite se elige a propósito: no hay proceso de servidor de BD separado
// (nada de Postgres/MySQL rondando en 512MB de RAM), es un solo archivo,
// y better-sqlite3 es síncrono y rápido para el volumen de datos de un
// tracker de finanzas personales (miles de filas, no millones).
//
// La tabla se llama "movimientos", no "gastos": guarda gastos, ingresos,
// inversiones y ahorro en una sola tabla con una columna `tipo`, en vez de
// una tabla/hoja separada por tipo. Así "¿cuál fue mi balance neto en
// agosto?" es una sola consulta agrupada por tipo, no un JOIN entre tablas.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'movimientos.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL'); // mejor concurrencia lectura/escritura en SD card

db.exec(`
  CREATE TABLE IF NOT EXISTS movimientos (
    id TEXT PRIMARY KEY,
    fecha TEXT NOT NULL,
    categoria TEXT NOT NULL,
    metodo_pago TEXT,
    monto REAL NOT NULL,
    nota TEXT,
    tipo TEXT NOT NULL DEFAULT 'Gasto',
    recibido_en TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mov_fecha ON movimientos(fecha);
  CREATE INDEX IF NOT EXISTS idx_mov_categoria ON movimientos(categoria);
  CREATE INDEX IF NOT EXISTS idx_mov_tipo ON movimientos(tipo);
`);

const upsertStmt = db.prepare(`
  INSERT INTO movimientos (id, fecha, categoria, metodo_pago, monto, nota, tipo, recibido_en)
  VALUES (@id, @fecha, @categoria, @metodo_pago, @monto, @nota, @tipo, @recibido_en)
  ON CONFLICT(id) DO UPDATE SET
    fecha = excluded.fecha,
    categoria = excluded.categoria,
    metodo_pago = excluded.metodo_pago,
    monto = excluded.monto,
    nota = excluded.nota,
    tipo = excluded.tipo,
    recibido_en = excluded.recibido_en
`);

function upsertMovimientos(rows) {
  const insertMany = db.transaction((items) => {
    for (const item of items) upsertStmt.run(item);
  });
  insertMany(rows);
}

function countMovimientos() {
  return db.prepare('SELECT COUNT(*) AS n FROM movimientos').get().n;
}

module.exports = { db, upsertMovimientos, countMovimientos };
