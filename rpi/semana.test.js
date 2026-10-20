// `npm test` — sin framework: node assert y listo. Las fechas son fijas
// para que ningún resultado dependa del día en que se corra.
const assert = require('assert');
const { calcularSemanas, fechaLocal, lunesDe, sumarDias } = require('./semana');

const g = (fecha, monto, categoria = 'Alimentos', extra = {}) =>
  ({ fecha, monto, categoria, tipo: 'Gasto', nota: '', ...extra });

// 2026-10-19 es lunes; 2026-10-25 es domingo.
assert.strictEqual(lunesDe('2026-10-19'), '2026-10-19', 'el lunes es su propio lunes');
assert.strictEqual(lunesDe('2026-10-25'), '2026-10-19', 'el domingo pertenece a la semana que empezó el lunes anterior');
assert.strictEqual(lunesDe('2026-10-26'), '2026-10-26', 'el lunes siguiente abre semana nueva');
assert.strictEqual(sumarDias('2026-10-31', 1), '2026-11-01', 'cruza fin de mes');
assert.strictEqual(sumarDias('2026-12-31', 1), '2027-01-01', 'cruza fin de año');
assert.strictEqual(lunesDe('2027-01-01'), '2026-12-28', 'semana que cruza el año');

// fechaLocal usa los componentes locales, no UTC. 23:30 local sigue siendo ese día.
assert.strictEqual(fechaLocal(new Date(2026, 9, 25, 23, 30)), '2026-10-25');
assert.strictEqual(fechaLocal(new Date(2026, 0, 5, 0, 5)), '2026-01-05');

const movs = [
  g('2026-10-12', 100),            // semana anterior, lunes
  g('2026-10-14', 40, 'Transporte'), // semana anterior, miércoles
  g('2026-10-18', 60),             // semana anterior, domingo
  g('2026-10-19', 30),             // actual, lunes
  g('2026-10-21', 70, 'Salidas', { nota: 'cena' }), // actual, miércoles
  g('2026-10-21', 10, 'Alimentos'),
  { fecha: '2026-10-21', monto: 999, categoria: 'Sueldo', tipo: 'Ingreso', nota: '' }, // se ignora
  g('2026-10-22', 500),            // jueves: futuro si hoy es miércoles
];

// --- domingo por la noche: semana completa, comparación contra la anterior entera
let s = calcularSemanas(movs, '2026-10-25', 3);
assert.strictEqual(s.length, 3);
let act = s[2];
assert.strictEqual(act.desde, '2026-10-19');
assert.strictEqual(act.hasta, '2026-10-25');
assert.strictEqual(act.enCurso, true);
assert.strictEqual(act.dias, 7);
assert.strictEqual(act.gasto, 610, '30 + 70 + 10 + 500');
assert.strictEqual(act.n, 4, 'no cuenta el Ingreso');
assert.strictEqual(act.previo.gasto, 200);
assert.deepStrictEqual(act.mayor, { monto: 500, categoria: 'Alimentos', nota: '', fecha: '2026-10-22' });
assert.strictEqual(act.categorias[0].categoria, 'Alimentos');
assert.strictEqual(act.categorias[0].total, 540);
assert.deepStrictEqual(act.porDia, [30, 0, 80, 500, 0, 0, 0]);

// --- miércoles: 3 días transcurridos, el jueves de 500 todavía no cuenta
s = calcularSemanas(movs, '2026-10-21', 3);
act = s[2];
assert.strictEqual(act.dias, 3);
assert.strictEqual(act.gasto, 110, 'el gasto del jueves queda fuera del tramo');
assert.strictEqual(act.previo.gasto, 140, 'lunes a miércoles de la semana anterior: 100 + 40');
assert.deepStrictEqual(act.porDia, [30, 0, 80, null, null, null, null], 'los días futuros son null, no 0');

// --- la semana anterior se mide completa (7 días) aunque hoy sea miércoles
const ant = s[1];
assert.strictEqual(ant.enCurso, false);
assert.strictEqual(ant.dias, 7);
assert.strictEqual(ant.gasto, 200);

// --- semana sin gastos
s = calcularSemanas([], '2026-10-21', 2);
assert.strictEqual(s[1].gasto, 0);
assert.strictEqual(s[1].mayor, null);
assert.deepStrictEqual(s[1].categorias, []);
assert.strictEqual(s[1].previo.gasto, 0);

// --- filas con fecha rota no tumban el cálculo
assert.doesNotThrow(() => calcularSemanas([g('basura', 5), g(undefined, 5)], '2026-10-21', 2));

// --- centavos: sin colas de punto flotante
s = calcularSemanas([g('2026-10-19', 0.1), g('2026-10-19', 0.2)], '2026-10-19', 1);
assert.strictEqual(s[0].gasto, 0.3);

console.log('semana.test.js: todo OK');
