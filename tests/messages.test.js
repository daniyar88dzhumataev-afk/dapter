// Тесты текстов и ссылок WhatsApp (SPEC.md, разделы 4.6 и 6). Только вымышленные данные.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reminderText, statementText, waLink, formatPhone, formatDate } from '../js/messages.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
const NOW = new Date(2026, 10, 18, 15, 0);

describe('Напоминание', () => {
  const data = { name: 'Айгуль', amount: 14300, shopName: 'Береке', kaspiPhone: '77071112233' };

  test('русский текст по шаблону из ТЗ', () => {
    assert.equal(
      reminderText('ru', data),
      'Здравствуйте, Айгуль! Напоминаем, что в магазине «Береке» за вами 14 300 ₸. Можно перевести на Kaspi: +7 707 111 22 33. Спасибо!'
    );
  });
  test('казахский текст по шаблону из ТЗ', () => {
    assert.equal(
      reminderText('kk', data),
      'Сәлеметсіз бе, Айгуль! «Береке» дүкеніндегі қарызыңыз: 14 300 ₸. Kaspi арқылы аударуға болады: +7 707 111 22 33. Рахмет!'
    );
  });
  test('без номера Kaspi фраза про Kaspi убирается', () => {
    const text = reminderText('ru', { ...data, kaspiPhone: '' });
    assert.equal(text.includes('Kaspi'), false);
    assert.equal(text.endsWith('за вами 14 300 ₸. Спасибо!'), true);
  });
  test('без названия магазина текст остаётся понятным', () => {
    assert.equal(reminderText('ru', { ...data, shopName: '', kaspiPhone: '' }), 'Здравствуйте, Айгуль! Напоминаем, что за вами 14 300 ₸. Спасибо!');
  });
});

describe('Выписка', () => {
  const customer = { id: 'c1', name: 'Айгуль' };
  const mk = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      customerId: 'c1',
      type: 'credit',
      amount: 100,
      createdAt: at(2026, 10, i + 1),
      voided: false,
    }));

  test('заголовок, операции и итог', () => {
    const ops = [
      { type: 'credit', amount: 2500, createdAt: at(2026, 11, 10), comment: 'хлеб, молоко', voided: false },
      { type: 'payment', amount: 1000, createdAt: at(2026, 11, 12), comment: '', voided: false },
    ];
    const text = statementText('ru', customer, ops, { shopName: 'Береке', now: NOW });
    assert.equal(
      text,
      [
        'Выписка: Айгуль',
        'Магазин «Береке»',
        'Дата: 18.11.2026',
        '',
        '10.11.2026 — взял — 2 500 ₸ — хлеб, молоко',
        '12.11.2026 — вернул — 1 000 ₸',
        '',
        'Итого долг: 1 500 ₸',
      ].join('\n')
    );
  });
  test('не больше 15 последних операций, итог по всем', () => {
    const text = statementText('ru', customer, mk(20), { now: NOW });
    const opLines = text.split('\n').filter((l) => / — взял — /.test(l));
    assert.equal(opLines.length, 15);
    assert.equal(opLines[0].startsWith('06.10.2026'), true); // первые 5 скрыты
    assert.match(text, /…и ещё 5 более ранних операций/);
    assert.match(text, /Итого долг: 2 000 ₸/);
  });
  test('отменённые операции в выписку не попадают', () => {
    const ops = [
      { type: 'credit', amount: 2500, createdAt: at(2026, 11, 10), voided: false },
      { type: 'credit', amount: 9999, createdAt: at(2026, 11, 11), voided: true },
    ];
    const text = statementText('ru', customer, ops, { now: NOW });
    assert.equal(text.includes('9 999'), false);
    assert.match(text, /Итого долг: 2 500 ₸/);
  });
  test('переплата и нулевой долг', () => {
    const over = [
      { type: 'credit', amount: 1000, createdAt: at(2026, 11, 1), voided: false },
      { type: 'payment', amount: 1500, createdAt: at(2026, 11, 2), voided: false },
    ];
    assert.match(statementText('ru', customer, over, { now: NOW }), /Переплата: 500 ₸$/);
    assert.match(statementText('ru', customer, [], { now: NOW }), /Операций нет\n\nДолга нет$/);
  });
  test('казахская выписка', () => {
    const ops = [{ type: 'credit', amount: 2500, createdAt: at(2026, 11, 10), voided: false }];
    const text = statementText('kk', customer, ops, { now: NOW });
    assert.match(text, /^Қарыз: Айгуль\nКүні: 18\.11\.2026/);
    assert.match(text, /10\.11\.2026 — алды — 2 500 ₸/);
    assert.match(text, /Қалған қарыз: 2 500 ₸$/);
  });
});

describe('Ссылка WhatsApp (правило 10)', () => {
  test('номер только цифрами, текст закодирован', () => {
    assert.equal(waLink('77011234567', 'Привет!'), 'https://wa.me/77011234567?text=' + encodeURIComponent('Привет!'));
  });
  test('номер с маской очищается до цифр', () => {
    assert.match(waLink('+7 (701) 123-45-67', 'x'), /^https:\/\/wa\.me\/77011234567\?/);
  });
  test('казахские буквы проходят через ссылку без потерь', () => {
    const text = 'Сәлеметсіз бе! Қарызыңыз: 14 300 ₸. Рахмет!';
    const link = waLink('77011234567', text);
    assert.equal(/[^\x21-\x7e]/.test(link), false); // в ссылке нет пробелов и не-ASCII
    assert.equal(decodeURIComponent(link.split('?text=')[1]), text);
  });
  test('неверный номер — ссылки нет', () => {
    assert.equal(waLink('', 'x'), null);
    assert.equal(waLink('12345', 'x'), null);
    assert.equal(waLink('87011234567', 'x'), null);
  });
});

describe('Вспомогательное', () => {
  test('формат телефона и даты', () => {
    assert.equal(formatPhone('77011234567'), '+7 701 123 45 67');
    assert.equal(formatDate(new Date(2026, 0, 5)), '05.01.2026');
  });
});
