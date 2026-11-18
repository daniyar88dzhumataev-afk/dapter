// Таблица «ключ — русский — казахский» для проверки носителем языка.
// Запуск: node tools/kk-table.js  → docs/kk-proverka.csv (открывается в Excel)
// Включает все тексты интерфейса и образцы сообщений WhatsApp из js/messages.js.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { reminderText, statementText } from '../js/messages.js';

const root = new URL('../', import.meta.url);
const ru = JSON.parse(await readFile(new URL('i18n/ru.json', root), 'utf8'));
const kk = JSON.parse(await readFile(new URL('i18n/kk.json', root), 'utf8'));

// Образцы сообщений покупателям (вымышленные данные)
const sample = { name: 'Айгуль', amount: 14300, shopName: 'Береке', kaspiPhone: '77071112233' };
const ops = [
  { type: 'credit', amount: 2500, createdAt: new Date(2026, 10, 10, 12).toISOString(), comment: 'хлеб, молоко', voided: false },
  { type: 'payment', amount: 1000, createdAt: new Date(2026, 10, 12, 12).toISOString(), comment: '', voided: false },
];
const now = new Date(2026, 10, 18, 12);
const messages = [
  ['whatsapp.reminder', reminderText('ru', sample), reminderText('kk', sample)],
  ['whatsapp.reminderNoKaspi', reminderText('ru', { ...sample, kaspiPhone: '' }), reminderText('kk', { ...sample, kaspiPhone: '' })],
  [
    'whatsapp.statement',
    statementText('ru', { name: 'Айгуль' }, ops, { shopName: 'Береке', now }),
    statementText('kk', { name: 'Айгуль' }, ops, { shopName: 'Береке', now }),
  ],
];

const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
const rows = [
  ['Ключ', 'Русский', 'Казахский (черновик)', 'Исправление носителя языка'],
  ...Object.keys(ru).map((k) => [k, ru[k], kk[k] ?? '— НЕТ ПЕРЕВОДА —', '']),
  ...messages.map(([k, r, q]) => [k, r, q, '']),
];
// BOM и «;» — чтобы Excel с русскими настройками открыл файл правильно
const csv = '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';

await mkdir(new URL('docs/', root), { recursive: true });
await writeFile(new URL('docs/kk-proverka.csv', root), csv);
console.log(`docs/kk-proverka.csv — ${rows.length - 1} строк`);
