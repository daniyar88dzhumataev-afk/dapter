// Тесты расчётов (SPEC.md, раздел 6). Только вымышленные данные.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAmount,
  formatAmount,
  calendarDaysBetween,
  customerBalance,
  checkLimit,
  checkOverpayment,
  isOverdue,
  daysSinceLastActivity,
  shopTotals,
  normalize,
  matchesSearch,
} from '../js/ledger.js';

// Дата по местному времени → ISO, как её запишет приложение.
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
let seq = 0;
const tx = (type, amount, createdAt, extra = {}) => ({
  id: `t${++seq}`,
  customerId: 'c1',
  type,
  amount,
  createdAt,
  voided: false,
  ...extra,
});
const NOW = new Date(2026, 10, 18, 15, 0); // 18.11.2026, 15:00 местного времени

describe('Суммы (правило 2)', () => {
  test('целая положительная сумма принимается', () => {
    assert.deepEqual(validateAmount(2500), { ok: true, value: 2500 });
    assert.deepEqual(validateAmount('12 500'), { ok: true, value: 12500 });
  });
  test('ноль и отрицательные не принимаются', () => {
    assert.equal(validateAmount(0).error, 'not_positive');
    assert.equal(validateAmount(-100).error, 'not_positive');
  });
  test('дробные не принимаются', () => {
    assert.equal(validateAmount(10.5).error, 'not_integer');
    assert.equal(validateAmount('10,5').error, 'not_integer');
  });
  test('пусто и мусор не принимаются', () => {
    assert.equal(validateAmount('').error, 'empty');
    assert.equal(validateAmount(null).error, 'empty');
    assert.equal(validateAmount('abc').error, 'not_integer');
  });
  test('максимум 10 000 000', () => {
    assert.equal(validateAmount(10_000_000).ok, true);
    assert.equal(validateAmount(10_000_001).error, 'too_large');
  });
});

describe('Формат суммы (правило 11)', () => {
  test('разделитель тысяч — пробел, ₸ после числа', () => {
    assert.equal(formatAmount(1250000), '1 250 000 ₸');
    assert.equal(formatAmount(12500), '12 500 ₸');
    assert.equal(formatAmount(500), '500 ₸');
    assert.equal(formatAmount(0), '0 ₸');
  });
  test('отрицательная сумма со знаком минус', () => {
    assert.equal(formatAmount(-1500), '-1 500 ₸');
  });
});

describe('Баланс (правило 1) и отмена (правило 6)', () => {
  test('серия долгов, частичных возвратов и отмен совпадает с ручным расчётом', () => {
    const ops = [
      tx('credit', 2500, at(2026, 11, 1)),
      tx('credit', 1800, at(2026, 11, 3)),
      tx('payment', 1000, at(2026, 11, 5)),
      tx('credit', 9999, at(2026, 11, 6), { voided: true }), // ошибка, отменена
      tx('credit', 999, at(2026, 11, 6)),
      tx('payment', 500, at(2026, 11, 7), { voided: true }), // отменена
    ];
    // 2500 + 1800 − 1000 + 999 = 4299
    assert.equal(customerBalance(ops), 4299);
  });
  test('нет операций — баланс 0', () => {
    assert.equal(customerBalance([]), 0);
  });
  test('переплата даёт отрицательный баланс и уменьшает следующий долг', () => {
    const ops = [tx('credit', 1000, at(2026, 11, 1)), tx('payment', 1500, at(2026, 11, 2))];
    assert.equal(customerBalance(ops), -500);
    ops.push(tx('credit', 2000, at(2026, 11, 3)));
    assert.equal(customerBalance(ops), 1500);
  });
});

describe('Возврат больше долга (правило 3)', () => {
  test('платёж больше долга — предупреждение с суммой аванса', () => {
    assert.deepEqual(checkOverpayment(3000, 5000), { overpay: true, extra: 2000 });
  });
  test('платёж равен долгу или меньше — без предупреждения', () => {
    assert.deepEqual(checkOverpayment(3000, 3000), { overpay: false, extra: 0 });
    assert.deepEqual(checkOverpayment(3000, 1000), { overpay: false, extra: 0 });
  });
  test('при уже существующей переплате весь платёж — аванс', () => {
    assert.deepEqual(checkOverpayment(-500, 1000), { overpay: true, extra: 1000 });
  });
});

describe('Лимит (правило 4)', () => {
  test('превышение лимита — предупреждение и на сколько', () => {
    assert.deepEqual(checkLimit(9000, 2000, 10000), { exceeds: true, newBalance: 11000, over: 1000 });
  });
  test('ровно до лимита — без предупреждения', () => {
    assert.equal(checkLimit(8000, 2000, 10000).exceeds, false);
  });
  test('пустой лимит — без лимита', () => {
    assert.equal(checkLimit(999999, 1000, null).exceeds, false);
    assert.equal(checkLimit(999999, 1000, undefined).exceeds, false);
    assert.equal(checkLimit(999999, 1000, '').exceeds, false);
  });
});

describe('«Давно не платит» (правило 5)', () => {
  const daysAgo = (n) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };
  test('29 дней с последнего платежа — ещё нет', () => {
    const ops = [tx('credit', 5000, daysAgo(60)), tx('payment', 1000, daysAgo(29))];
    assert.equal(isOverdue(ops, NOW, 30), false);
  });
  test('30 дней — ещё нет (порог «старше 30»)', () => {
    const ops = [tx('credit', 5000, daysAgo(60)), tx('payment', 1000, daysAgo(30))];
    assert.equal(isOverdue(ops, NOW, 30), false);
  });
  test('31 день — да', () => {
    const ops = [tx('credit', 5000, daysAgo(60)), tx('payment', 1000, daysAgo(31))];
    assert.equal(isOverdue(ops, NOW, 30), true);
  });
  test('платежей не было — считается от первого долга', () => {
    assert.equal(isOverdue([tx('credit', 5000, daysAgo(31)), tx('credit', 100, daysAgo(1))], NOW, 30), true);
    assert.equal(isOverdue([tx('credit', 5000, daysAgo(30)), tx('credit', 100, daysAgo(1))], NOW, 30), false);
  });
  test('нет долга — не «давно не платит»', () => {
    const ops = [tx('credit', 1000, daysAgo(90)), tx('payment', 1000, daysAgo(80))];
    assert.equal(isOverdue(ops, NOW, 30), false);
  });
  test('порог берётся из настроек', () => {
    const ops = [tx('credit', 5000, daysAgo(8))];
    assert.equal(isOverdue(ops, NOW, 7), true);
    assert.equal(isOverdue(ops, NOW, 30), false);
  });
  test('отменённый платёж не считается платежом', () => {
    const ops = [tx('credit', 5000, daysAgo(40)), tx('payment', 1000, daysAgo(2), { voided: true })];
    assert.equal(isOverdue(ops, NOW, 30), true);
  });
  test('считаются календарные дни, а не часы', () => {
    // 23:59 вчера и 00:01 сегодня — это 1 день
    assert.equal(calendarDaysBetween(new Date(2026, 10, 17, 23, 59), new Date(2026, 10, 18, 0, 1)), 1);
  });
});

describe('«N дн. назад»', () => {
  test('по последней неотменённой операции', () => {
    const ops = [tx('credit', 100, at(2026, 11, 10)), tx('credit', 100, at(2026, 11, 15)), tx('credit', 1, at(2026, 11, 18), { voided: true })];
    assert.equal(daysSinceLastActivity(ops, NOW), 3);
  });
  test('нет операций — null', () => {
    assert.equal(daysSinceLastActivity([], NOW), null);
  });
});

describe('Итоги магазина и «Сегодня» (правило 9)', () => {
  const customers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ops = [
    tx('credit', 5000, at(2026, 11, 10), { customerId: 'a' }),
    tx('credit', 2000, at(2026, 11, 18, 0, 0), { customerId: 'b' }), // сегодня, ровно 00:00
    tx('payment', 500, at(2026, 11, 18, 23, 59), { customerId: 'b' }), // сегодня, 23:59
    tx('credit', 1000, at(2026, 11, 17, 23, 59), { customerId: 'c' }), // вчера
    tx('payment', 3000, at(2026, 11, 18, 9, 0), { customerId: 'c' }), // сегодня → переплата 2000
    tx('credit', 7777, at(2026, 11, 18, 10, 0), { customerId: 'a', voided: true }), // отменена
  ];
  test('общий долг — только положительные балансы, переплата не вычитается', () => {
    const r = shopTotals(customers, ops, NOW);
    assert.equal(r.totalDebt, 5000 + 1500);
    assert.equal(r.debtorsCount, 2);
  });
  test('сегодня: выдано и вернули, отменённые не считаются', () => {
    const r = shopTotals(customers, ops, NOW);
    assert.equal(r.todayCredit, 2000);
    assert.equal(r.todayPayment, 3500);
  });
  test('после полуночи «Сегодня» обнуляется', () => {
    const tomorrow = new Date(2026, 10, 19, 0, 1);
    const r = shopTotals(customers, ops, tomorrow);
    assert.equal(r.todayCredit, 0);
    assert.equal(r.todayPayment, 0);
  });
});

describe('Поиск (правило 8)', () => {
  const aigul = { name: 'Айгуль', phone: '77011234567', note: '3-й подъезд' };
  test('«айг» и «АЙГ» находят Айгуль', () => {
    assert.equal(matchesSearch(aigul, 'айг'), true);
    assert.equal(matchesSearch(aigul, 'АЙГ'), true);
  });
  test('по последним 4 цифрам телефона', () => {
    assert.equal(matchesSearch(aigul, '4567'), true);
  });
  test('по любой части цифр, даже с пробелами и +7', () => {
    assert.equal(matchesSearch(aigul, '+7 701 123'), true);
  });
  test('по слову из заметки', () => {
    assert.equal(matchesSearch(aigul, 'подъезд'), true);
  });
  test('е/ё не различаются', () => {
    const p = { name: 'Пётр', phone: '', note: '' };
    assert.equal(matchesSearch(p, 'петр'), true);
    assert.equal(matchesSearch({ name: 'Семен' }, 'Семён'), true);
  });
  test('лишние пробелы не мешают', () => {
    assert.equal(matchesSearch({ name: 'Анна  Ким' }, '  анна   ким '), true);
  });
  test('казахские буквы ищутся корректно', () => {
    const names = ['Әсел', 'Ғалым', 'Қайрат', 'Аңсар', 'Өмір', 'Ұлан', 'Үміт', 'Һади', 'Ілияс'];
    for (const name of names) {
      assert.equal(matchesSearch({ name }, name.slice(0, 2).toLowerCase()), true, name);
      assert.equal(matchesSearch({ name }, name.toUpperCase()), true, name);
    }
    // ә и а — разные буквы
    assert.equal(matchesSearch({ name: 'Әсел' }, 'асел'), false);
  });
  test('нет совпадения — false; пустой запрос — все', () => {
    assert.equal(matchesSearch(aigul, 'Болат'), false);
    assert.equal(matchesSearch(aigul, '9999'), false);
    assert.equal(matchesSearch(aigul, ''), true);
  });
  test('normalize: регистр, ё, пробелы', () => {
    assert.equal(normalize('  ЁЛКА   Зелёная '), 'елка зеленая');
  });
});
