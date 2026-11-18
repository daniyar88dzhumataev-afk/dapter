// Проверка текстов интерфейса: каждый ключ, который использует app.js, есть в i18n/ru.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const ru = JSON.parse(await readFile(new URL('i18n/ru.json', root), 'utf8'));
const kk = JSON.parse(await readFile(new URL('i18n/kk.json', root), 'utf8'));
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('в kk.json есть каждый ключ из ru.json', () => {
  const missing = Object.keys(ru).filter((k) => !(k in kk));
  assert.deepEqual(missing, [], `В kk.json не хватает ключей: ${missing.join(', ')}`);
});

test('в kk.json нет лишних ключей, которых нет в ru.json', () => {
  assert.deepEqual(Object.keys(kk).filter((k) => !(k in ru)), []);
});

test('казахские тексты непустые и с теми же {подстановками}', () => {
  for (const [key, value] of Object.entries(kk)) {
    assert.equal(typeof value, 'string', key);
    assert.notEqual(value.trim(), '', key);
    assert.deepEqual(placeholders(value), placeholders(ru[key] ?? ''), key);
  }
});
const appCode = await readFile(new URL('js/app.js', root), 'utf8');
const dbCode = await readFile(new URL('js/db.js', root), 'utf8');

test('все тексты — непустые строки', () => {
  for (const [key, value] of Object.entries(ru)) {
    assert.equal(typeof value, 'string', key);
    assert.notEqual(value.trim(), '', key);
  }
});

test('каждый ключ t(\'…\') из app.js есть в ru.json', () => {
  // Префиксы вроде t('tab.' + k) проверяет следующий тест
  const used = [...appCode.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.'));
  assert.ok(used.length > 50);
  const missing = [...new Set(used)].filter((k) => !(k in ru));
  assert.deepEqual(missing, []);
});

test('ключи, которые собираются из частей, тоже есть', () => {
  const groups = {
    'tab.': ['debtors', 'overdue', 'all'],
    'sort.': ['recent', 'amount', 'name'],
    'method.': ['cash', 'kaspi'],
    'amount.': ['empty', 'not_integer', 'not_positive', 'too_large'],
    'restore.err.': ['empty', 'not_json', 'not_dapter', 'newer_version', 'bad_structure', 'bad_customer', 'bad_transaction', 'duplicate_id', 'unknown_customer'],
  };
  for (const [prefix, names] of Object.entries(groups)) {
    for (const n of names) assert.ok(prefix + n in ru, prefix + n);
  }
});

test('у каждой ошибки из db.js есть понятный текст', () => {
  const codes = [...dbCode.matchAll(/new DbError\('(\w+)'/g)].map((m) => m[1]);
  assert.ok(codes.length > 5);
  const missing = [...new Set(codes)].filter((c) => !(`error.${c}` in ru));
  assert.deepEqual(missing, []);
});
