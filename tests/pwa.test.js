// Тесты PWA (SPEC.md, раздел 7): manifest, иконки, список файлов service worker, напоминание о копии.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { backupReminder } from '../js/backup.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root));
const exists = (p) => access(new URL(p, root)).then(() => true, () => false);

/** Размер PNG из заголовка IHDR. */
async function pngSize(path) {
  const b = await read(path);
  assert.equal(b.toString('ascii', 1, 4), 'PNG', path);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

describe('manifest.json', () => {
  test('корректный JSON с нужными полями', async () => {
    const m = JSON.parse(await read('manifest.json'));
    assert.equal(m.display, 'standalone');
    assert.ok(m.name && m.short_name && m.start_url && m.theme_color);
  });
  test('иконки 192 и 512 на месте и нужного размера', async () => {
    const m = JSON.parse(await read('manifest.json'));
    const sizes = m.icons.map((i) => i.sizes);
    assert.ok(sizes.includes('192x192'));
    assert.ok(sizes.includes('512x512'));
    for (const icon of m.icons) assert.equal(await pngSize(icon.src), icon.sizes, icon.src);
  });
  test('иконка для iPhone 180×180', async () => {
    assert.equal(await pngSize('icons/apple-touch-icon.png'), '180x180');
  });
});

describe('sw.js', () => {
  const swText = () => read('sw.js').then((b) => b.toString('utf8'));
  const listed = async () => {
    const m = (await swText()).match(/const FILES = \[([\s\S]*?)\];/);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };

  test('есть номер версии', async () => {
    assert.match(await swText(), /const VERSION = 'dapter-v\d+';/);
  });
  test('каждый файл из списка существует', async () => {
    for (const f of await listed()) {
      if (f === './') continue;
      assert.ok(await exists(f), f);
    }
  });
  test('все файлы приложения есть в списке (иначе не будут работать без интернета)', async () => {
    const files = new Set(await listed());
    const required = ['index.html', 'manifest.json'];
    for (const dir of ['css', 'js', 'i18n', 'icons']) {
      for (const name of await readdir(new URL(dir + '/', root))) required.push(`${dir}/${name}`);
    }
    const missing = required.filter((f) => !files.has(f));
    assert.deepEqual(missing, []);
  });
});

describe('Напоминание о резервной копии', () => {
  const NOW = new Date(2026, 10, 18, 12);
  const daysAgo = (n) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };
  const data = { customers: [{ createdAt: daysAgo(20) }], transactions: [{ createdAt: daysAgo(3) }] };

  test('7 дней после копии — ещё не напоминать', () => {
    assert.deepEqual(backupReminder({ ...data, lastBackupAt: daysAgo(7) }, NOW), { show: false, days: 7 });
  });
  test('8 дней — напомнить', () => {
    assert.deepEqual(backupReminder({ ...data, lastBackupAt: daysAgo(8) }, NOW), { show: true, days: 8 });
  });
  test('копии не было — считаем от самой ранней записи', () => {
    assert.deepEqual(backupReminder({ ...data, lastBackupAt: null }, NOW), { show: true, days: 20 });
    const fresh = { customers: [{ createdAt: daysAgo(2) }], transactions: [] };
    assert.equal(backupReminder({ ...fresh, lastBackupAt: null }, NOW).show, false);
  });
  test('нет данных — не напоминать', () => {
    assert.equal(backupReminder({ customers: [], transactions: [], lastBackupAt: null }, NOW).show, false);
  });
});
