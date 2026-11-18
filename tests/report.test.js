// Тесты отчёта за месяц и благодарности после погашения долга. Только вымышленные данные.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { monthReport, customerBalance } from '../js/ledger.js';
import { paidOffText, waLink } from '../js/messages.js';

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
let seq = 0;
const tx = (customerId, type, amount, createdAt, extra = {}) => ({
  id: `t${++seq}`,
  customerId,
  type,
  amount,
  createdAt,
  voided: false,
  ...extra,
});

// Ноябрь 2026 = month 10
const ops = [
  tx('a', 'credit', 5000, at(2026, 10, 20)), // октябрь: долг на начало ноября
  tx('b', 'credit', 1000, at(2026, 10, 31, 23, 59)), // последняя минута октября
  tx('a', 'payment', 2000, at(2026, 11, 1, 0, 0), { method: 'cash' }), // первая минута ноября
  tx('b', 'credit', 3000, at(2026, 11, 10)),
  tx('b', 'payment', 4000, at(2026, 11, 15), { method: 'kaspi' }), // b погасил полностью
  tx('c', 'credit', 700, at(2026, 11, 20)),
  tx('c', 'credit', 9999, at(2026, 11, 21), { voided: true }), // отменена — не считается
  tx('a', 'credit', 1500, at(2026, 11, 30, 23, 59)), // последняя минута ноября
  tx('a', 'credit', 800, at(2026, 12, 1, 0, 0)), // уже декабрь
];

describe('Отчёт за месяц', () => {
  const r = monthReport(ops, 2026, 10);

  test('выдано и вернули за месяц, границы месяца по местному времени', () => {
    assert.equal(r.credit, 3000 + 700 + 1500);
    assert.equal(r.creditCount, 3);
    assert.equal(r.payment, 2000 + 4000);
    assert.equal(r.paymentCount, 2);
  });
  test('возвраты по способам: наличные и Kaspi', () => {
    assert.equal(r.cash, 2000);
    assert.equal(r.kaspi, 4000);
  });
  test('долг на начало и конец месяца и изменение', () => {
    assert.equal(r.debtStart, 5000 + 1000);
    // a: 5000 − 2000 + 1500 = 4500; b: 0; c: 700
    assert.equal(r.debtEnd, 4500 + 700);
    assert.equal(r.change, 5200 - 6000);
  });
  test('по покупателям: только те, у кого были операции в месяце, долг на конец месяца', () => {
    assert.deepEqual(r.byCustomer, [
      { customerId: 'a', credit: 1500, payment: 2000, balanceEnd: 4500 },
      { customerId: 'c', credit: 700, payment: 0, balanceEnd: 700 },
      { customerId: 'b', credit: 3000, payment: 4000, balanceEnd: 0 },
    ]);
  });
  test('операции месяца новые сверху, без отменённых и без соседних месяцев', () => {
    assert.equal(r.operations.length, 5);
    assert.equal(r.operations[0].amount, 1500);
    assert.equal(r.operations.at(-1).amount, 2000);
    assert.ok(r.operations.every((o) => !o.voided));
  });
  test('пустой месяц — нули, долг переносится', () => {
    const empty = monthReport(ops, 2026, 8); // сентябрь
    assert.equal(empty.operations.length, 0);
    assert.equal(empty.credit + empty.payment, 0);
    assert.equal(empty.debtStart, 0);
    const jan = monthReport(ops, 2027, 0); // январь: операций нет, долг с декабря
    assert.equal(jan.operations.length, 0);
    assert.equal(jan.debtStart, 4500 + 800 + 700);
    assert.equal(jan.debtEnd, jan.debtStart);
  });
  test('архив = баланс ровно 0: b погасил, а переплата в архив не попадает', () => {
    assert.equal(customerBalance(ops.filter((o) => o.customerId === 'b')), 0);
    const over = [tx('d', 'credit', 1000, at(2026, 11, 1)), tx('d', 'payment', 1500, at(2026, 11, 2))];
    assert.notEqual(customerBalance(over), 0);
  });
});

describe('Благодарность после погашения', () => {
  test('русский текст', () => {
    assert.equal(
      paidOffText('ru', { name: 'Айгуль', shopName: 'Береке' }),
      'Здравствуйте, Айгуль! Спасибо, ваш долг в магазине «Береке» полностью погашен. Всегда рады вас видеть — приходите к нам ещё!'
    );
  });
  test('казахский текст', () => {
    assert.equal(
      paidOffText('kk', { name: 'Айгуль', shopName: 'Береке' }),
      'Сәлеметсіз бе, Айгуль! Рахмет, «Береке» дүкеніндегі қарызыңыз толық өтелді. Сізді әрқашан күтеміз — тағы келіңіз!'
    );
  });
  test('без названия магазина', () => {
    assert.match(paidOffText('ru', { name: 'Болат', shopName: '' }), /^Здравствуйте, Болат! Спасибо, ваш долг полностью погашен\./);
  });
  test('ссылка WhatsApp с благодарностью', () => {
    const link = waLink('77011234567', paidOffText('kk', { name: 'Әсел', shopName: '' }));
    assert.match(decodeURIComponent(link), /Әсел! Рахмет, қарызыңыз толық өтелді/);
  });
});
