// server.js — un solo proceso Node: dashboard + API de filtros + chatbot +
// cron de sync. Todo en un proceso a propósito: en una Zero 2W (512MB RAM)
// cada proceso adicional (nginx, un servicio de cron separado, etc.) es RAM
// que no vas a recuperar. Un solo Node con node-cron adentro es suficiente
// para el tráfico de un dashboard personal.

require('dotenv').config();
const path = require('path');
const express = require('express');
const cron = require('node-cron');
// v4 se publica transpileado desde ESM — require() normal da el objeto
// módulo entero (con __esModule: true), no la función; hay que desenvolver
// el default a mano, CommonJS no lo hace solo como sí hace Babel/webpack.
const alexaVerifier = require('alexa-verifier').default;
const { db, getMeta } = require('./db');
const { syncOnce } = require('./sync');
const { askQuestion } = require('./chatbot');

const app = express();
const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL_MIN = Number(process.env.SYNC_INTERVAL_MIN || 15);

// El `verify` guarda el body crudo (bytes exactos, antes de parsear) en
// req.rawBody — lo necesita alexaVerifier() más abajo, porque la firma de
// Alexa se calcula sobre el texto tal cual llegó, no sobre el objeto
// reconstruido por JSON.parse (el orden/espaciado de un JSON.stringify
// propio no es necesariamente igual al original).
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));
app.use(express.static(path.join(__dirname, 'public')));

// TEMPORAL: diagnosticando el flujo de Alexa — sacar una vez que ande.
app.use((req, _res, next) => {
  if (req.method === 'POST') console.log('[alexa-debug] llegó POST', req.path);
  next();
});

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

// OJO con las comillas: en SQLite las comillas dobles son para IDENTIFICADORES,
// no para strings. better-sqlite3 se compila con SQLITE_DQS=0, o sea sin el
// fallback historico que trata un identificador desconocido como literal, asi
// que `metodo_pago != ""` se parsea como "columna con nombre vacio" y revienta
// con: no such column: '' - should this be a string literal in single-quotes?
// Literales de string SIEMPRE con comilla simple.
app.get('/api/metodos-pago', (_req, res) => {
  const rows = db
    .prepare(
      "SELECT DISTINCT metodo_pago FROM movimientos WHERE metodo_pago IS NOT NULL AND metodo_pago != '' ORDER BY metodo_pago"
    )
    .all();
  res.json(rows.map((r) => r.metodo_pago));
});

app.get('/api/tipos', (_req, res) => {
  res.json(['Gasto', 'Ingreso', 'Ahorro', 'Inversión']);
});

// --- Dashboard v2: un solo endpoint con todo pre-calculado ----------------
//
// Un endpoint y no ocho a propósito. Con ~200 filas las agregaciones son
// instantáneas, y una Zero 2W sufre más por ocho round-trips HTTP (cada uno
// con su handshake) que por una query un poco más grande. El front pide esto
// una vez al cargar y arma todos los paneles con el mismo objeto.

// Fila cargada como Ingreso (o Ahorro) que en realidad es una FOTO de saldo,
// no plata que se movió ese día: "Patrimonio Actual" (el arranque del
// registro, antes de que existiera la hoja Saldos) y "Ahorro fondo de
// emergencia Actual" (mismo hack, para el fondo). Sin excluirlas se cuentan
// como si fueran ingreso/aporte del período, e inflan cualquier total en
// miles de dólares de una sola fila. Se detectan por el "Actual" en la nota
// — convención ya usada dos veces en los datos reales, cero notas legítimas
// de gasto/ingreso normal lo llevan (comprobado contra las 200+ filas de
// este Sheet), así que no hace falta ser más específico.
const NOTA_FOTO_SALDO = /\bactual\b/i;

// Un gasto por encima de esto se trata como compra única y se muestra aparte:
// mezclarlo con el gasto corriente hace que el promedio mienta.
const CORTE_COMPRA_GRANDE = Number(process.env.CORTE_COMPRA_GRANDE || 500);

function mediana(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Coincide con el nombre de categoría tal cual está en el Sheet hoy. Es un
// match de texto, no una columna de "recurrencia" separada (esa no existe
// todavía — ver Decisiones/Finanzas-05 en la bóveda): mezcla el arriendo y
// el préstamo (fijos de verdad) con compras únicas mal categorizadas. Sirve
// como primera aproximación del "% del sueldo en gastos fijos" mientras esa
// columna no exista.
const ES_GASTOS_FIJOS = (cat) => (cat || '').trim().toLowerCase() === 'gastos fijos';

function resumenDe(movs) {
  const gastos = movs.filter((r) => r.tipo === 'Gasto');
  const montos = gastos.map((r) => r.monto);
  const ing = movs.filter((r) => r.tipo === 'Ingreso').reduce((a, r) => a + r.monto, 0);
  const gas = montos.reduce((a, b) => a + b, 0);
  const inv = movs.filter((r) => r.tipo === 'Inversión').reduce((a, r) => a + r.monto, 0);
  const ahorro = movs.filter((r) => r.tipo === 'Ahorro').reduce((a, r) => a + r.monto, 0);
  const gasFijos = gastos.filter((r) => ES_GASTOS_FIJOS(r.categoria)).reduce((a, r) => a + r.monto, 0);
  const gasOtros = gas - gasFijos;

  const porCat = new Map();
  const porMet = new Map();
  const nPorMet = new Map();
  for (const r of gastos) {
    porCat.set(r.categoria, (porCat.get(r.categoria) || 0) + r.monto);
    const m = r.metodo_pago || 'Sin método';
    porMet.set(m, (porMet.get(m) || 0) + r.monto);
    nPorMet.set(m, (nPorMet.get(m) || 0) + 1);
  }
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0] || ['—', 0];
  const [topCat, topCatV] = top(porCat);
  const [topMet, topMetV] = top(porMet);
  const [topMetN, topMetNv] = top(nPorMet);
  const mayor = gastos.reduce((a, r) => (!a || r.monto > a.monto ? r : a), null);

  return {
    ing: round2(ing),
    gas: round2(gas),
    inv: round2(inv),
    ahorro: round2(ahorro),
    neto: round2(ing - gas),
    n: gastos.length,
    med: round2(mediana(montos)),
    prom: gastos.length ? round2(gas / gastos.length) : 0,
    topCat,
    topCatV: round2(topCatV),
    topCatPct: gas ? round2((topCatV / gas) * 100) : 0,
    topMet,
    topMetV: round2(topMetV),
    topMetPct: gas ? round2((topMetV / gas) * 100) : 0,
    topMetN,
    topMetNv,
    big: mayor ? mayor.nota || mayor.categoria : '—',
    bigV: mayor ? round2(mayor.monto) : 0,
    tasa: ing ? round2((inv / ing) * 100) : 0,
    gasFijos: round2(gasFijos),
    gasFijosPct: ing ? round2((gasFijos / ing) * 100) : 0,
    gasOtros: round2(gasOtros),
    gasOtrosPct: ing ? round2((gasOtros / ing) * 100) : 0,
  };
}

app.get('/api/dashboard', (_req, res) => {
  const todos = db.prepare('SELECT * FROM movimientos ORDER BY fecha ASC').all();
  const saldos = db.prepare('SELECT * FROM saldos ORDER BY fecha ASC, cuenta ASC').all();

  // Los saldos de apertura son el piso desde el que arranca el patrimonio.
  // Se toman de la fila de `saldos` más antigua de cada cuenta.
  const aperturaPorCuenta = new Map();
  for (const s of saldos) if (!aperturaPorCuenta.has(s.cuenta)) aperturaPorCuenta.set(s.cuenta, s);
  const fechaApertura = saldos.length ? saldos[0].fecha : null;
  const patrimonioInicial = [...aperturaPorCuenta.values()]
    .filter((s) => s.fecha === fechaApertura)
    .reduce((a, s) => a + s.saldo, 0);

  // El saldo más reciente de cada cuenta es lo que hay hoy en ella.
  const ultimoPorCuenta = new Map();
  for (const s of saldos) ultimoPorCuenta.set(s.cuenta, s);

  // Flujos: solo se excluye el saldo inicial disfrazado de Ingreso.
  //
  // ANTES esto también tiraba todo movimiento anterior a `fechaApertura`
  // (la fecha del saldo más viejo de la hoja Saldos), asumiendo que ya
  // estaba contado dentro de ese saldo. Es una trampa: `fechaApertura` es
  // el MÍNIMO global de fechas entre TODAS las cuentas de Saldos, y una sola
  // foto reciente (ej. "Fondo de emergencia hoy") sin una fila de apertura
  // vieja al lado hace que ese mínimo sea HOY — y de un saque desaparecen
  // meses enteros de movimientos reales, sin ningún error en pantalla.
  // (Bug real, reportado: "Septiembre a Septiembre" con 8 meses de historial
  // vivos en la base pero invisibles en el dashboard.)
  //
  // La fecha 2025 de un movimiento viejo (ver Decisiones, nota "Fecha 2025")
  // resultó ser un dato REAL, no un typo — una inversión hecha antes de
  // empezar a trackear (confirmado con el usuario). Sigue sumando en los
  // totales de siempre (Invertido, Patrimonio, Liquidez — para eso usan
  // `flujos`/`generalBase` sin este filtro), pero no tiene que aparecer
  // como un mes suelto, un año antes de todo lo demás, en los gráficos
  // mensuales (Neto mensual, Ingresos, Resumen). `fechaInicioTracking` es
  // la fecha de la semilla de patrimonio — todo lo anterior a eso se
  // considera "de antes de trackear" y no arma su propio mes.
  const flujos = todos.filter((r) => !NOTA_FOTO_SALDO.test(r.nota || ''));

  const fechaInicioTracking = todos
    .filter((r) => r.tipo === 'Ingreso' && NOTA_FOTO_SALDO.test(r.nota || ''))
    .reduce((min, r) => (!min || r.fecha < min ? r.fecha : min), null);

  const meses = [...new Set(
    flujos
      .filter((r) => !fechaInicioTracking || r.fecha >= fechaInicioTracking)
      .map((r) => r.fecha.slice(0, 7))
  )].sort();
  const hoy = new Date().toISOString().slice(0, 10);
  const mesEnCurso = hoy.slice(0, 7);

  const porMes = meses.map((mes) => ({
    mes,
    enCurso: mes === mesEnCurso,
    ...resumenDe(flujos.filter((r) => r.fecha.slice(0, 7) === mes)),
  }));

  // Los meses cerrados son los únicos que se pueden comparar entre sí: el mes
  // en curso siempre parece un desplome porque todavía no terminó.
  const cerrados = porMes.filter((m) => !m.enCurso);

  const gastos = flujos.filter((r) => r.tipo === 'Gasto');
  const generalBase = resumenDe(flujos);

  // Fondo de emergencia TOTAL (para la tarjeta) es otra pregunta que
  // `generalBase.ahorro` (aportes del período): acá SÍ hay que contar la
  // fila "Actual" — es la semilla de lo que ya tenías ahorrado antes de
  // trackear, misma idea que `patrimonioInicial` para el patrimonio. Sin
  // ella, la tarjeta muestra solo los aportes nuevos y esconde la plata que
  // de verdad hay guardada. Se suma sobre `todos`, no `flujos`, justamente
  // para NO pasar por el filtro que la excluye.
  const fondoEmergenciaTotal = round2(
    todos.filter((r) => r.tipo === 'Ahorro').reduce((a, r) => a + r.monto, 0)
  );

  // Semilla de patrimonio (fila "Patrimonio Actual", tipo=Ingreso) — misma
  // idea que fondoEmergenciaTotal arriba, sobre `todos` para no perderla.
  // Reportado: la primera versión de `liquidez` no la usaba en absoluto (la
  // excluía como si nunca hubiera existido), y daba un número muy lejos del
  // real. Probado contra los saldos reales del usuario: agregarla acá SÍ
  // cierra la cuenta — confirmado que el "Actual" de enero y el "Actual"
  // del fondo de emergencia NO se solapan (son plata distinta), así que
  // sumar los dos no duplica nada.
  const patrimonioInicialMov = round2(
    todos.filter((r) => r.tipo === 'Ingreso' && NOTA_FOTO_SALDO.test(r.nota || ''))
      .reduce((a, r) => a + r.monto, 0)
  );

  // Patrimonio total = semilla + todo lo que entró - todo lo que salió.
  // Liquidez = ese total MENOS lo que ya está en otro lado (invertido +
  // fondo) — lo que queda es lo único que puede estar en banco/efectivo.
  // Ojo: acá se resta el TOTAL de invertido/fondo (no solo aportes del
  // período) porque toda esa plata, venga de cuando venga, no está en la
  // cuenta corriente hoy.
  // `generalBase.inv` sirve tal cual como "invertido total": no hay una
  // fila "Inversión Actual" en los datos (comprobado — la única palabra
  // "actual" en todo el Sheet aparece en las 2 filas ya cubiertas arriba),
  // así que los aportes acumulados SON el total, sin semilla aparte.
  const patrimonioTotalMov = round2(patrimonioInicialMov + generalBase.ing - generalBase.gas);
  const liquidez = round2(patrimonioTotalMov - generalBase.inv - fondoEmergenciaTotal);

  const porCategoria = [...gastos.reduce((map, r) => {
    const c = map.get(r.categoria) || { categoria: r.categoria, total: 0, n: 0, unico: 0 };
    c.total += r.monto;
    c.n += 1;
    if (r.monto >= CORTE_COMPRA_GRANDE) c.unico += r.monto;
    map.set(r.categoria, c);
    return map;
  }, new Map()).values()]
    .map((c) => ({ ...c, total: round2(c.total), unico: round2(c.unico) }))
    .sort((a, b) => b.total - a.total);

  const porMetodo = [...gastos.reduce((map, r) => {
    const k = r.metodo_pago || 'Sin método';
    const m = map.get(k) || { metodo: k, total: 0, n: 0 };
    m.total += r.monto;
    m.n += 1;
    map.set(k, m);
    return map;
  }, new Map()).values()]
    .map((m) => ({ ...m, total: round2(m.total), ticket: round2(m.total / m.n) }))
    .sort((a, b) => b.total - a.total);

  const metodosMes = meses.map((mes) => {
    const delMes = gastos.filter((r) => r.fecha.slice(0, 7) === mes);
    const acc = {};
    for (const r of delMes) {
      const k = r.metodo_pago || 'Sin método';
      acc[k] = acc[k] || { total: 0, n: 0 };
      acc[k].total = round2(acc[k].total + r.monto);
      acc[k].n += 1;
    }
    return { mes, enCurso: mes === mesEnCurso, metodos: acc };
  });

  const inversiones = flujos.filter((r) => r.tipo === 'Inversión');
  // Aportes de inversión de ANTES de fechaInicioTracking (ej. la compra de
  // MSFT de 2025) no tienen mes en `meses`, así que el .map() de abajo
  // nunca los va a sumar — sin esto, ese aporte real desaparecía del
  // acumulado en vez de solo dejar de tener su propio mes. Se suman acá,
  // como semilla, junto con lo que ya viniera de la hoja Saldos.
  const inversionesPrevias = round2(
    inversiones.filter((r) => !meses.includes(r.fecha.slice(0, 7))).reduce((a, r) => a + r.monto, 0)
  );
  let acumulado = round2(
    [...aperturaPorCuenta.values()]
      .filter((s) => s.fecha === fechaApertura && /invers/i.test(s.cuenta))
      .reduce((a, s) => a + s.saldo, 0) + inversionesPrevias
  );
  const invMes = meses.map((mes) => {
    const aporte = round2(
      inversiones.filter((r) => r.fecha.slice(0, 7) === mes).reduce((a, r) => a + r.monto, 0)
    );
    acumulado = round2(acumulado + aporte);
    return { mes, aporte, acumulado, enCurso: mes === mesEnCurso };
  });

  const patrimonio = saldos.length
    ? (() => {
        const total = round2(patrimonioInicial + generalBase.ing - generalBase.gas);
        const invertidoHoy = invMes.length ? invMes[invMes.length - 1].acumulado : 0;

        // Dos clases de cuenta, y confundirlas da un patrimonio mal repartido:
        //  - La de inversión NO se lee de su última foto: esa foto es apenas el
        //    saldo de apertura, y desde entonces se le fueron sumando aportes.
        //    Su valor de hoy es el acumulado (apertura + todo lo aportado).
        //  - Las demás (fondo, garantía) sí valen lo que dice su última foto.
        // La cuenta bancaria de apertura tampoco cuenta: ese dinero ya está
        // dentro de `total` a través de patrimonioInicial, y sumarlo de nuevo
        // lo contaría dos veces.
        const otras = [...ultimoPorCuenta.values()]
          .filter((s) => !/invers/i.test(s.cuenta))
          .filter((s) => !(s.fecha === fechaApertura && /banco|corriente|cuenta/i.test(s.cuenta)))
          .map((s) => ({ cuenta: s.cuenta, saldo: round2(s.saldo), fecha: s.fecha }));

        const cuentas = invertidoHoy
          ? [{ cuenta: 'Inversiones', saldo: invertidoHoy, fecha: null }, ...otras]
          : otras;
        const medido = round2(cuentas.reduce((a, c) => a + c.saldo, 0));

        return {
          disponible: true,
          inicial: round2(patrimonioInicial),
          fechaApertura,
          total,
          cuentas,
          // Liquidez es un DERIVADO, no un dato medido: sale de restar. Si el
          // usuario carga el saldo real de su cuenta corriente, la diferencia
          // contra este número es exactamente lo que le falta registrar.
          liquidez: round2(total - medido),
        };
      })()
    : { disponible: false };

  res.json({
    generadoEn: new Date().toISOString(),
    corteCompraGrande: CORTE_COMPRA_GRANDE,
    mesEnCurso,
    filas: todos.length,
    // De dónde saca el dashboard el aviso de "esto no se actualiza": el
    // momento del último sync que terminó bien, y el mensaje del último que
    // falló (si lo hay, aunque uno posterior haya salido bien — así un
    // error transitorio no desaparece sin que el usuario lo haya visto).
    sync: {
      ultimoOk: getMeta('lastSyncAt'),
      ultimoError: getMeta('lastSyncError') || null,
      ultimoErrorEn: getMeta('lastSyncErrorAt'),
      intervaloMin: SYNC_INTERVAL_MIN,
    },
    general: {
      ...generalBase,
      fondoEmergenciaTotal,
      patrimonioTotalMov,
      liquidez,
      mesMasCaro: cerrados.reduce((a, m) => (!a || m.gas > a.gas ? m : a), null),
      mesMasBarato: cerrados.reduce((a, m) => (!a || m.gas < a.gas ? m : a), null),
    },
    porMes,
    porCategoria,
    porMetodo,
    metodosMes,
    invMes,
    topGastos: [...gastos]
      .sort((a, b) => b.monto - a.monto)
      .slice(0, 15)
      .map((r) => ({
        fecha: r.fecha,
        categoria: r.categoria,
        metodo: r.metodo_pago,
        monto: round2(r.monto),
        nota: r.nota,
      })),
    patrimonio,
  });
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

// --- Alexa Skill "finanzas" — único endpoint pensado para exponerse a
// internet (vía Tailscale Funnel, configurado a nivel de SO, no acá).
// Todo lo demás de este archivo sigue exclusivamente detrás de Tailscale.
//
// Ojo con `tailscale funnel --set-path=/api/alexa`: pela el prefijo al
// proxyear, la request le llega al backend como POST / (no POST
// /api/alexa). Por eso hay DOS rutas con DOS autenticaciones distintas:
//
//   POST /api/alexa  — solo alcanzable dentro del tailnet (Funnel no la
//                       expone tal cual). Gateada por ALEXA_SHARED_SECRET
//                       en un header — sirve para probar con curl a mano.
//   POST /            — la que realmente pega Funnel desde internet. Un
//                       header custom no sirve acá: la consola de Alexa no
//                       deja configurar headers en un endpoint HTTPS
//                       propio. En su lugar se verifica la FIRMA que Alexa
//                       manda en todo request real (headers Signature +
//                       SignatureCertChainUrl, estándar, no custom) — si
//                       no verifica, no es Alexa quien preguntó.
//
// POST a '/' no choca con nada más: no hay ningún otro handler POST en esa
// ruta, solo GET/estático.

function requiereSecretoCompartido(req, res, next) {
  // Ojo con el fail-open: si ALEXA_SHARED_SECRET no está seteado en .env,
  // `process.env.ALEXA_SHARED_SECRET` es `undefined`, y un request sin
  // header también da `undefined` — comparar undefined !== undefined es
  // `false`, o sea que SIN secreto configurado, CUALQUIERA pasaría. Por eso
  // el chequeo exige explícitamente que `secreto` exista, no solo que
  // coincida.
  const secreto = process.env.ALEXA_SHARED_SECRET;
  if (!secreto || req.headers['x-alexa-secret'] !== secreto) {
    return res.status(401).json({ error: 'no autorizado' });
  }
  next();
}

// Tolerancia estándar recomendada por Amazon para el timestamp del
// request (ver Alexa docs de "request validation") — más viejo que esto,
// se rechaza como posible replay de una request capturada antes.
const TOLERANCIA_TIMESTAMP_MS = 150 * 1000;

function requiereFirmaAlexa(req, res, next) {
  const certUrl = req.headers.signaturecertchainurl;
  const firma = req.headers.signature;
  const timestamp = req.body && req.body.request && req.body.request.timestamp;

  // TEMPORAL: diagnosticando por qué el simulador de Alexa no llega a
  // buen puerto — sacar estos logs una vez que ande.
  console.log('[alexa-debug] POST / — certUrl:', !!certUrl, 'firma:', !!firma, 'rawBody:', !!req.rawBody, 'timestamp:', timestamp, '| reloj Pi ahora:', new Date().toISOString());

  if (!certUrl || !firma || !req.rawBody || !timestamp) {
    console.log('[alexa-debug] rechazado: falta certUrl/firma/rawBody/timestamp');
    return res.status(401).json({ error: 'no autorizado' });
  }
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (Math.abs(diffMs) > TOLERANCIA_TIMESTAMP_MS) {
    console.log('[alexa-debug] rechazado por timestamp, diffMs:', diffMs);
    return res.status(401).json({ error: 'no autorizado' });
  }

  const skillId = process.env.ALEXA_SKILL_ID;
  const skillIdEnRequest = req.body.context && req.body.context.System &&
    req.body.context.System.application && req.body.context.System.application.applicationId;
  if (!skillId || skillIdEnRequest !== skillId) {
    console.log('[alexa-debug] rechazado por skillId. esperado:', skillId, 'recibido:', skillIdEnRequest);
    return res.status(401).json({ error: 'no autorizado' });
  }

  alexaVerifier(certUrl, firma, req.rawBody, (err) => {
    if (err) {
      console.log('[alexa-debug] rechazado por alexaVerifier:', err.message || err);
      return res.status(401).json({ error: 'no autorizado' });
    }
    console.log('[alexa-debug] firma OK, pasando a manejarPreguntaAlexa');
    next();
  });
}

async function manejarPreguntaAlexa(req, res) {
  // Shape real de un IntentRequest de Alexa (ver el modelo de interacción
  // del Custom Skill): la pregunta transcripta vive en
  // request.intent.slots.query.value — el nombre "query" viene del slot
  // AMAZON.SearchQuery definido en el Skill.
  const slots = req.body && req.body.request && req.body.request.intent && req.body.request.intent.slots;
  const pregunta = slots && slots.query && slots.query.value;

  function hablar(texto) {
    res.json({
      version: '1.0',
      response: {
        outputSpeech: { type: 'PlainText', text: texto },
        shouldEndSession: true,
      },
    });
  }

  if (!pregunta) {
    return hablar('No entendí la pregunta, probá de nuevo.');
  }

  try {
    const resultado = await askQuestion(pregunta);
    hablar(resultado.respuesta);
  } catch (err) {
    // askQuestion() ya atrapa el caso de cuota agotada de Gemini y devuelve
    // texto legible en vez de tirar — esto solo cubre errores realmente
    // inesperados (red caída, etc.), ver chatbot.js.
    hablar('Hubo un error consultando tus datos: ' + err.message);
  }
}

app.post('/api/alexa', requiereSecretoCompartido, manejarPreguntaAlexa);
app.post('/', requiereFirmaAlexa, manejarPreguntaAlexa);

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
