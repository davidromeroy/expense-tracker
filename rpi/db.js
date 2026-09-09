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

// `movimientos` guarda FLUJOS: plata que se movió, con fecha.
// `saldos` guarda SALDOS: fotos de cuánto hay en una cuenta a una fecha.
// Son cosas distintas y por eso viven en tablas distintas: sumar un saldo
// con un flujo da un número sin sentido (si el fondo de emergencia pasa de
// 1.200 a 1.400 y se guardaran los dos como movimiento, el tracker diría
// que se ahorraron 2.600 en vez de 200).
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

  CREATE TABLE IF NOT EXISTS saldos (
    fecha  TEXT NOT NULL,
    cuenta TEXT NOT NULL,
    saldo  REAL NOT NULL,
    PRIMARY KEY (fecha, cuenta)
  );
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

/**
 * Espeja el Sheet completo: además de upsert, BORRA de la SQLite local todo
 * `id` que ya no está en `rows`.
 *
 * upsertMovimientos() sola nunca alcanza para un sync real: es upsert puro,
 * nunca DELETE. Si borrás una fila en el Sheet, esa fila sigue viva para
 * siempre en la Pi — el dashboard sincroniza pero nunca se entera de la baja.
 * Como el Sheet es la fuente de verdad (comentario en sync.js), "ya no está
 * en el Sheet" tiene que significar "ya no existe", punto.
 */
function syncMovimientos(rows) {
  const ids = rows.map((r) => r.id);
  const tx = db.transaction((items) => {
    for (const item of items) upsertStmt.run(item);
    if (ids.length) {
      const marcas = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM movimientos WHERE id NOT IN (${marcas})`).run(...ids);
    } else {
      // Sheet vacío no debería pasar nunca (siempre hay encabezados + datos),
      // pero si pasara, mejor no vaciar toda la tabla por un fetch en falso.
      console.warn('[db] syncMovimientos recibió 0 filas — no se borra nada, por las dudas.');
    }
  });
  tx(rows);
}

function countMovimientos() {
  return db.prepare('SELECT COUNT(*) AS n FROM movimientos').get().n;
}

const upsertSaldoStmt = db.prepare(`
  INSERT INTO saldos (fecha, cuenta, saldo)
  VALUES (@fecha, @cuenta, @saldo)
  ON CONFLICT(fecha, cuenta) DO UPDATE SET saldo = excluded.saldo
`);

/**
 * Reemplaza la tabla de saldos completa. A diferencia de los movimientos, acá
 * sí borramos antes: una foto de saldo que desaparece de la hoja es una foto
 * que el usuario quitó a propósito, y dejarla huérfana falsearía el patrimonio.
 */
function replaceSaldos(rows) {
  const tx = db.transaction((items) => {
    db.prepare('DELETE FROM saldos').run();
    for (const item of items) upsertSaldoStmt.run(item);
  });
  tx(rows);
}

module.exports = { db, upsertMovimientos, syncMovimientos, countMovimientos, replaceSaldos };
