// server.js — un solo proceso Node: dashboard + API de filtros + chatbot +
// cron de sync. Todo en un proceso a propósito: en una Zero 2W (512MB RAM)
// cada proceso adicional (nginx, un servicio de cron separado, etc.) es RAM
// que no vas a recuperar. Un solo Node con node-cron adentro es suficiente
// para el tráfico de un dashboard personal.

require('dotenv').config();
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { db } = require('./db');
const { syncOnce } = require('./sync');
const { askQuestion } = require('./chatbot');

const app = express();
const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL_MIN = Number(process.env.SYNC_INTERVAL_MIN || 15);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Filtros básicos (el camino principal y más confiable) ---
app.get('/api/gastos', (req, res) => {
  const { desde, hasta, categoria, metodo_pago, tipo } = req.query;
  const clauses = [];
  const params = {};

  if (desde) { clauses.push('fecha >= @desde'); params.desde = desde; }
  if (hasta) { clauses.push('fecha <= @hasta'); params.hasta = hasta; }
  if (categoria) { clauses.push('categoria = @categoria'); params.categoria = categoria; }
  if (metodo_pago) { clauses.push('metodo_pago = @metodo_pago'); params.metodo_pago = metodo_pago; }
  if (tipo) { clauses.push('tipo = @tipo'); params.tipo = tipo; }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM movimientos ${where} ORDER BY fecha DESC`).all(params);
  res.json(rows);
});

// Resumen para el dashboard de GASTOS: filtra tipo='Gasto' explícitamente.
// Si no filtráramos, "Ahorro/Inversión" (que también es categoría de varios
// Ingresos e Inversiones) inflaría el gráfico de gastos por categoría.
app.get('/api/resumen', (req, res) => {
  const { desde, hasta } = req.query;
  const clauses = ["tipo = 'Gasto'"];
  const params = {};
  if (desde) { clauses.push('fecha >= @desde'); params.desde = desde; }
  if (hasta) { clauses.push('fecha <= @hasta'); params.hasta = hasta; }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const porCategoria = db
    .prepare(`SELECT categoria, SUM(monto) AS total FROM movimientos ${where} GROUP BY categoria ORDER BY total DESC`)
    .all(params);

  const porMes = db
    .prepare(
      `SELECT substr(fecha, 1, 7) AS mes, SUM(monto) AS total FROM movimientos ${where} GROUP BY mes ORDER BY mes ASC`
    )
    .all(params);

  res.json({ porCategoria, porMes });
});

// Balance: ingresos vs gastos vs inversión/ahorro, agrupado por tipo.
app.get('/api/balance', (req, res) => {
  const { desde, hasta } = req.query;
  const clauses = [];
  const params = {};
  if (desde) { clauses.push('fecha >= @desde'); params.desde = desde; }
  if (hasta) { clauses.push('fecha <= @hasta'); params.hasta = hasta; }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const porTipo = db
    .prepare(`SELECT tipo, SUM(monto) AS total FROM movimientos ${where} GROUP BY tipo`)
    .all(params);

  const totales = Object.fromEntries(porTipo.map((r) => [r.tipo, r.total]));
  const ingresos = totales.Ingreso || 0;
  const gastos = totales.Gasto || 0;

  res.json({ porTipo, ingresos, gastos, neto: ingresos - gastos });
});

app.get('/api/categorias', (_req, res) => {
  const rows = db.prepare('SELECT DISTINCT categoria FROM movimientos ORDER BY categoria').all();
  res.json(rows.map((r) => r.categoria));
});

app.get('/api/metodos-pago', (_req, res) => {
  const rows = db.prepare('SELECT DISTINCT metodo_pago FROM movimientos WHERE metodo_pago != "" ORDER BY metodo_pago').all();
  res.json(rows.map((r) => r.metodo_pago));
});

app.get('/api/tipos', (_req, res) => {
  res.json(['Gasto', 'Ingreso', 'Ahorro', 'Inversión']);
});

// --- Capa opcional de lenguaje natural sobre los mismos datos ---
app.post('/api/preguntar', async (req, res) => {
  const { pregunta } = req.body;
  if (!pregunta) return res.status(400).json({ error: 'falta "pregunta" en el body' });
  try {
    const resultado = await askQuestion(pregunta);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Sync manual (útil para probar sin esperar al cron) ---
app.post('/api/sync', async (_req, res) => {
  try {
    const n = await syncOnce();
    res.json({ ok: true, filas: n });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard corriendo en http://0.0.0.0:${PORT}`);
});

// Cron interno: sincroniza contra el Sheet cada SYNC_INTERVAL_MIN minutos.
cron.schedule(`*/${SYNC_INTERVAL_MIN} * * * *`, () => {
  syncOnce().catch((err) => console.error('[cron sync] error:', err.message));
});

// Sync inicial al arrancar, para no esperar el primer intervalo.
syncOnce().catch((err) => console.error('[sync inicial] error:', err.message));
