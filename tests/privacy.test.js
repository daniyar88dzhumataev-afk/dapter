// Данные покупателей не покидают телефон (SPEC.md, раздел 7; критерий приёмки «ни одного сетевого запроса»).
// Тест читает код приложения и падает, если в нём появится отправка данных куда-либо.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const files = ['index.html', 'sw.js', ...(await readdir(new URL('js/', root))).map((f) => `js/${f}`)];
const code = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(new URL(f, root), 'utf8')])));

test('нет способов отправки данных на сервер', () => {
  const forbidden = /XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|\.postMessage\(\s*[^'"]/;
  for (const [f, text] of Object.entries(code)) assert.doesNotMatch(text, forbidden, f);
});

test('fetch только к своим файлам: тексты i18n в app.js и кэш приложения в sw.js', () => {
  for (const [f, text] of Object.entries(code)) {
    const calls = [...text.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1].trim());
    if (f === 'js/app.js') assert.deepEqual(calls, ['`i18n/${l}.json`'], f);
    else if (f === 'sw.js') assert.ok(calls.every((c) => c === 'req'), f);
    else assert.deepEqual(calls, [], f);
  }
});

test('sw.js обрабатывает только запросы к своему сайту', () => {
  assert.match(code['sw.js'], /origin !== self\.location\.origin\) return;/);
});

test('нет внешних скриптов, стилей, шрифтов и аналитики', () => {
  assert.doesNotMatch(code['index.html'], /(src|href)="(https?:)?\/\//);
  for (const [f, text] of Object.entries(code)) {
    const urls = [...text.matchAll(/https?:\/\/[^\s'"`<)]+/g)].map((m) => m[0]);
    // Единственный внешний адрес — ссылка WhatsApp, которую открывает сам продавец
    assert.ok(urls.every((u) => u.startsWith('https://wa.me/') || u.startsWith('http://192.168.')), `${f}: ${urls}`);
  }
});
