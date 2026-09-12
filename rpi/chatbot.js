// chatbot.js — traduce una pregunta en español a una consulta SQL de solo
// lectura contra la tabla `movimientos`, la ejecuta y devuelve resultado +
// resumen. Corre con Gemini (Google AI Studio, tier gratis) en vez de
// Claude — antes usaba @anthropic-ai/sdk, se portó el 2026-09-11 porque
// Anthropic cobra por token sin tier gratis y el usuario ya tenía una
// GEMINI_API_KEY lista.
//
// Importante sobre el enfoque: esto NO reemplaza los filtros normales del
// dashboard (fecha/categoría por dropdown, ver pestaña Detalle), que siguen
// siendo el camino principal y más confiable. Esto es una capa encima para
// preguntas que no calzan en un formulario fijo ("¿en qué mes gasté más en
// el último año?"). Al ser una llamada HTTP a la API de Google, el cómputo
// pesado (el modelo) corre en la nube, no en la Pi — la Zero 2W solo hace
// la consulta SQL sobre su propia SQLite, que es barata.
//
// Seguridad: nunca ejecutamos texto libre. El modelo debe llamar a la
// función `run_query` con un SQL que validamos antes de correr: debe
// empezar con SELECT, no puede tocar otras tablas ni contener palabras de
// escritura. Mismas reglas que la versión anterior con Claude — portar de
// proveedor no relaja la validación.

// @google/genai (v0.15.0) es ESM puro — su condición "require" en el
// package.json apunta a un archivo que igual hereda "type": "module" del
// paquete (bug de empaquetado o diseño así, no importa cuál), así que un
// require() normal tira ERR_REQUIRE_ESM. El resto de este proyecto es
// CommonJS (server.js, db.js, sync.js) y no vale la pena migrarlo todo a
// ESM por una sola dependencia — se carga con import() dinámico, que sí
// puede traer un módulo ESM desde código CJS, cacheado en el módulo para
// no reimportar en cada pregunta.
const { db } = require('./db');

// gemini-3.6-flash agotó su cuota gratis (20 req/día) el 2026-09-12 con muy
// poco uso real de por medio. gemini-3.5-flash-lite tiene cuota separada
// (probado: no tiró 429 con la de -3.6 ya en cero) y respondió bien contra
// datos reales — no hay tabla pública de cuánto es exacto, Google lo
// muestra solo en el dashboard de AI Studio de cada cuenta. Cambiar acá si
// hace falta otro modelo, sin tocar el resto del archivo.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

let aiPromise = null;
let Type = null; // solo válido después de resolver getAi() una vez
function getAi() {
  if (!aiPromise) {
    aiPromise = import('@google/genai').then((mod) => {
      Type = mod.Type;
      return new mod.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    });
  }
  return aiPromise;
}

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

// Declaración de función al estilo Gemini (Type.* en vez de JSON Schema
// crudo) — mismo rol que el bloque `tools` de la versión con Claude. Es una
// función y no un objeto de módulo porque `Type` recién existe después de
// que se resuelve el import() dinámico de arriba.
function runQueryFunction() {
  return {
    name: 'run_query',
    description: 'Ejecuta una consulta SQL de SOLO LECTURA (SELECT) contra la tabla movimientos y devuelve las filas.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        sql: {
          type: Type.STRING,
          description: 'Un SELECT válido de SQLite contra la tabla movimientos. Nada de escritura.',
        },
      },
      required: ['sql'],
    },
  };
}

function isSafeSelect(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!/^select\s/i.test(trimmed)) return null;
  if (FORBIDDEN.test(trimmed)) return null;
  if (!/movimientos/i.test(trimmed)) return null; // debe referenciar la única tabla permitida
  return trimmed;
}

// El tier gratis de Gemini da 20 requests/día por proyecto, y cada
// pregunta gasta 2 (generar el SQL + redactar la respuesta) — así que a
// las ~10 preguntas reales del día, Gemini empieza a tirar 429
// RESOURCE_EXHAUSTED con un mensaje JSON crudo feo. `askQuestion()` de
// afuera atrapa eso puntual y devuelve un aviso legible en vez de dejarlo
// pasar tal cual al usuario — cualquier OTRO error (de red, de la propia
// consulta SQL, etc.) sigue subiendo normal.
const CUOTA_AGOTADA = /RESOURCE_EXHAUSTED|429|exceeded your current quota/i;

async function askQuestion(pregunta) {
  try {
    return await askQuestionInner(pregunta);
  } catch (err) {
    if (CUOTA_AGOTADA.test(err.message || '')) {
      return {
        respuesta: 'Se acabó la cuota gratis de Gemini por hoy (20 consultas/día, se resetea a las 24hs). ' +
          'Probá de nuevo mañana, o mientras tanto usá los filtros de la pestaña Detalle.',
        filas: [],
      };
    }
    throw err;
  }
}

async function askQuestionInner(pregunta) {
  const today = new Date().toISOString().slice(0, 10);
  const ai = await getAi();

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: pregunta,
    config: {
      systemInstruction: `Hoy es ${today}. Traduce preguntas sobre finanzas personales (gastos, ingresos, inversiones, ahorro) a SQL contra este esquema:\n${SCHEMA_DESC}\nUsa siempre la función run_query. Si la pregunta es ambigua, elige la interpretación más razonable y dilo en tu respuesta final.`,
      tools: [{ functionDeclarations: [runQueryFunction()] }],
    },
  });

  const call = (response.functionCalls || []).find((c) => c.name === 'run_query');

  if (!call) {
    return { respuesta: response.text || 'No pude interpretar la pregunta.', filas: [] };
  }

  const safeSql = isSafeSelect(call.args.sql);
  if (!safeSql) {
    return { respuesta: 'La consulta generada no pasó el filtro de seguridad. Reformula la pregunta.', filas: [] };
  }

  let filas;
  try {
    filas = db.prepare(safeSql).all();
  } catch (err) {
    return { respuesta: `La consulta falló: ${err.message}`, filas: [], sql: safeSql };
  }

  // Segunda vuelta: le pasamos el resultado al modelo para que redacte la
  // respuesta. Llamada independiente (no encadenada como turno de
  // conversación con el resultado de la función) — mismo patrón simple que
  // ya usaba la versión con Claude, no hace falta el protocolo completo de
  // function-response de Gemini para esto.
  const followUp = await ai.models.generateContent({
    model: MODEL,
    contents: `Pregunta original: ${pregunta}\n\nResultado de la consulta (JSON): ${JSON.stringify(filas).slice(0, 4000)}`,
    // `ai` ya está resuelto (misma instancia obtenida arriba con getAi()),
    // no hace falta un segundo await a getAi() acá.
    config: {
      systemInstruction: 'Redacta una respuesta breve en español, en moneda local, a partir de este resultado SQL. No repitas el SQL.',
    },
  });

  return {
    respuesta: followUp.text || 'Consulta ejecutada.',
    filas,
    sql: safeSql,
  };
}

module.exports = { askQuestion };
