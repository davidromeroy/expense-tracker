// Cálculo de la vista "Semana": agregados de gasto por semana de lunes a
// domingo. Función pura (recibe filas y "hoy"), sin base ni reloj propios,
// para poder probarla con fechas fijas.
//
// Por qué un módulo aparte y no dentro de server.js: la lógica de calendario
// es donde se esconden los errores de un día (borde de semana, domingo por la
// noche, cambio de mes). Aislada, `npm test` la cubre sin levantar nada.

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const DIA_MS = 86400000;

// 'YYYY-MM-DD' -> ms a medianoche UTC. Se trabaja con fechas como texto y se
// pasa a UTC solo para sumar días: así el huso horario de la máquina no puede
// correr una fecha un día (el `new Date('2026-10-19')` local sí podría).
function aMs(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function deMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Fecha de "hoy" en el huso de la máquina (la Pi está en America/Guayaquil).
// NO usar `new Date().toISOString().slice(0, 10)`: eso es la fecha en UTC, y
// a las 19:00 de Ecuador ya es "mañana". El resumen sale a las 20:00 del
// domingo, que en UTC es lunes: con la fecha UTC calcularía la semana nueva
// y vacía en vez de la que acaba de terminar.
function fechaLocal(ahora = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${ahora.getFullYear()}-${p(ahora.getMonth() + 1)}-${p(ahora.getDate())}`;
}

// Lunes de la semana que contiene `fecha`. getUTCDay: domingo 0 ... sábado 6.
function lunesDe(fecha) {
  const ms = aMs(fecha);
  const dow = new Date(ms).getUTCDay();
  return deMs(ms - ((dow + 6) % 7) * DIA_MS);
}

function sumarDias(fecha, n) {
  return deMs(aMs(fecha) + n * DIA_MS);
}

// Agregados de `dias` días a partir de `lunes` (7 = semana completa; menos si
// es la semana en curso).
function tramo(gastos, lunes, dias) {
  const hasta = sumarDias(lunes, dias - 1);
  const filas = gastos.filter((r) => r.fecha >= lunes && r.fecha <= hasta);

  const porDia = Array.from({ length: 7 }, (_, i) => (i < dias ? 0 : null));
  const porCat = new Map();
  let gasto = 0;
  let mayor = null;
  for (const r of filas) {
    gasto += r.monto;
    porDia[Math.round((aMs(r.fecha) - aMs(lunes)) / DIA_MS)] += r.monto;
    porCat.set(r.categoria, (porCat.get(r.categoria) || 0) + r.monto);
    if (!mayor || r.monto > mayor.monto) {
      mayor = { monto: r.monto, categoria: r.categoria, nota: r.nota || '', fecha: r.fecha };
    }
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    gasto: r2(gasto),
    n: filas.length,
    porDia: porDia.map((v) => (v === null ? null : r2(v))),
    categorias: [...porCat].map(([categoria, total]) => ({ categoria, total: r2(total) }))
      .sort((a, b) => b.total - a.total),
    mayor,
  };
}

// Últimas `cuantas` semanas, de la más vieja a la actual (la actual al final).
//
// Comparación justa: la semana en curso se compara con la anterior HASTA EL
// MISMO DÍA, no con la anterior entera. Un miércoles, comparar 3 días contra
// 7 daría siempre "gastaste menos" y no diría nada.
function calcularSemanas(movs, hoy, cuantas = 12) {
  const gastos = movs.filter((r) => r.tipo === 'Gasto' && RE_FECHA.test(r.fecha || ''));
  const lunesActual = lunesDe(hoy);

  const semanas = [];
  for (let i = cuantas - 1; i >= 0; i--) {
    const lunes = sumarDias(lunesActual, -7 * i);
    const enCurso = i === 0;
    // Lunes = 1 día transcurrido ... domingo = 7.
    const dias = enCurso ? Math.round((aMs(hoy) - aMs(lunes)) / DIA_MS) + 1 : 7;
    const actual = tramo(gastos, lunes, dias);
    const previo = tramo(gastos, sumarDias(lunes, -7), dias);
    semanas.push({
      desde: lunes,
      hasta: sumarDias(lunes, 6),
      enCurso,
      dias,
      ...actual,
      previo: { gasto: previo.gasto, n: previo.n },
    });
  }
  return semanas;
}

module.exports = { calcularSemanas, fechaLocal, lunesDe, sumarDias };
