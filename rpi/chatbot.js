// chatbot.js — traduce una pregunta en español a una consulta SQL de solo
// lectura contra la tabla `gastos`, la ejecuta y devuelve resultado + resumen.
//
// Importante sobre el enfoque: esto NO reemplaza los filtros normales del
// dashboard (fecha/categoría por dropdown), que siguen siendo el camino
// principal y más confiable. Esto es una capa encima para preguntas que no
// calzan en un formulario fijo ("¿en qué mes gasté más en el último año?").
// Al ser una llamada HTTP a la API de Anthropic, el cómputo pesado (el
// modelo) corre en la nube, no en la Pi — la Zero 2W solo hace la consulta
// SQL sobre su propia SQLite, que es barata.
//
// Seguridad: nunca ejecutamos texto libre. El modelo debe llamar a la
// "tool" run_query con un SQL que validamos antes de correr: debe empezar
// con SELECT, no puede tocar otras tablas ni contener palabras de escritura.

const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('./db');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|PRAGMA|CREATE|REPLACE)\b/i;

const SCHEMA_DESC = `
Tabla: movimientos (incluye TODO: gastos, ingresos, inversiones y ahorro — no solo gastos)
Columnas:
  id TEXT
  fecha TEXT (formato YYYY-MM-DD)
  categoria TEXT
  metodo_pago TEXT (ej: Efectivo, ApplePay, Transferencia Bancaria, Tarjeta de Débito, Tarjeta de Crédito, Aplicación Móvil, Otro)
  monto REAL (siempre positivo, el signo lo da la columna tipo, no el monto)
  nota TEXT
  tipo TEXT (uno de: 'Gasto', 'Ingreso', 'Ahorro', 'Inversión')
  recibido_en TEXT

Importante: si la pregunta es sobre "gastos" o "cuánto gasté", filtra siempre
tipo = 'Gasto'. Si pregunta por "balance", "neto" o "cuánto me quedó", resta
SUM(monto) con tipo='Gasto' de SUM(monto) con tipo='Ingreso'.
`;

const tools = [
  {
    name: 'run_query',
    description:
      'Ejecuta una consulta SQL de SOLO LECTURA (SELECT) contra la tabla movimientos y devuelve las filas.',
    input_schema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'Un SELECT válido de SQLite contra la tabla movimientos. Nada de escritura.',
        },
      },
      required: ['sql'],
    },
  },
];

function isSafeSelect(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!/^select\s/i.test(trimmed)) return null;
  if (FORBIDDEN.test(trimmed)) return null;
  if (!/movimientos/i.test(trimmed)) return null; // debe referenciar la única tabla permitida
  return trimmed;
}

async function askQuestion(pregunta) {
  const today = new Date().toISOString().slice(0, 10);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: `Hoy es ${today}. Traduce preguntas sobre finanzas personales (gastos, ingresos, inversiones, ahorro) a SQL contra este esquema:\n${SCHEMA_DESC}\nUsa siempre la tool run_query. Si la pregunta es ambigua, elige la interpretación más razonable y dilo en tu respuesta final.`,
    tools,
    messages: [{ role: 'user', content: pregunta }],
  });

  const toolUse = response.content.find((c) => c.type === 'tool_use' && c.name === 'run_query');

  if (!toolUse) {
    const textBlock = response.content.find((c) => c.type === 'text');
    return { respuesta: textBlock ? textBlock.text : 'No pude interpretar la pregunta.', filas: [] };
  }

  const safeSql = isSafeSelect(toolUse.input.sql);
  if (!safeSql) {
    return { respuesta: 'La consulta generada no pasó el filtro de seguridad. Reformula la pregunta.', filas: [] };
  }

  let filas;
  try {
    filas = db.prepare(safeSql).all();
  } catch (err) {
    return { respuesta: `La consulta falló: ${err.message}`, filas: [], sql: safeSql };
  }

  // Segunda vuelta: le pasamos el resultado al modelo para que redacte la respuesta.
  const followUp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    system: 'Redacta una respuesta breve en español, en moneda local, a partir de este resultado SQL. No repitas el SQL.',
    messages: [
      { role: 'user', content: pregunta },
      { role: 'user', content: `Resultado de la consulta (JSON): ${JSON.stringify(filas).slice(0, 4000)}` },
    ],
  });

  const textBlock = followUp.content.find((c) => c.type === 'text');

  return {
    respuesta: textBlock ? textBlock.text : 'Consulta ejecutada.',
    filas,
    sql: safeSql,
  };
}

module.exports = { askQuestion };
