// Тесты проверки файла резервной копии (SPEC.md, раздел 7). Только вымышленные данные.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateBackup, buildBackup, backupFileName } from '../js/backup.js';
import { SCHEMA_VERSION } from '../js/db.js';

const NOW = new Date(2026, 10, 18, 15, 0);

function sample() {
  return {
    customers: [
      { id: 'c1', name: 'Айгуль', phone: '77011234567', note: '', creditLimit: 20000, consent: true, archived: false },
      { id: 'c2', name: 'Болат', phone: '', note: '3-й подъезд', creditLimit: null, consent: false, archived: false },
    ],
    transactions: [
      { id: 't1', customerId: 'c1', type: 'credit', amount: 5000, createdAt: '2026-11-10T06:00:00.000Z', voided: false },
      { id: 't2', customerId: 'c1', type: 'payment', amount: 2000, method: 'kaspi', createdAt: '2026-11-12T06:00:00.000Z', voided: false },
      { id: 't3', customerId: 'c2', type: 'credit', amount: 1500, createdAt: '2026-11-13T06:00:00.000Z', voided: false },
      { id: 't4', customerId: 'c2', type: 'credit', amount: 9999, createdAt: '2026-11-13T07:00:00.000Z', voided: true },
    ],
    settings: { shopName: 'Береке', overdueDays: 30 },
  };
}
const goodText = () => JSON.stringify(buildBackup(sample(), NOW));
const withChange = (fn) => {
  const b = buildBackup(sample(), NOW);
  fn(b);
  return JSON.stringify(b);
};

describe('Имя файла и сборка', () => {
  test('имя файла по местной дате', () => {
    assert.equal(backupFileName(NOW), 'dapter-backup-2026-11-18.json');
    assert.equal(backupFileName(new Date(2027, 0, 5), '-before-restore'), 'dapter-backup-2027-01-05-before-restore.json');
  });
  test('в копии есть метка приложения, версия и все три хранилища', () => {
    const b = buildBackup(sample(), NOW);
    assert.equal(b.app, 'dapter');
    assert.equal(b.schemaVersion, SCHEMA_VERSION);
    assert.equal(b.customers.length, 2);
    assert.equal(b.transactions.length, 4);
    assert.equal(b.settings.shopName, 'Береке');
  });
});

describe('Верный файл', () => {
  test('проходит и даёт правильный предпросмотр', () => {
    const r = validateBackup(goodText(), NOW);
    assert.equal(r.ok, true);
    // Айгуль 5000 − 2000 = 3000, Болат 1500 (отменённые 9999 не считаются)
    assert.deepEqual(r.summary, { customers: 2, transactions: 4, totalDebt: 4500, exportedAt: NOW.toISOString() });
  });
  test('копия без покупателей тоже верная', () => {
    const r = validateBackup(JSON.stringify(buildBackup({ customers: [], transactions: [], settings: {} }, NOW)), NOW);
    assert.equal(r.ok, true);
    assert.equal(r.summary.totalDebt, 0);
  });
  test('сохранить → проверить: данные не меняются', () => {
    const r = validateBackup(goodText(), NOW);
    assert.deepEqual(r.data, sample());
  });
});

describe('Повреждённый файл', () => {
  test('пустой', () => {
    assert.equal(validateBackup('').error, 'empty');
    assert.equal(validateBackup('   ').error, 'empty');
  });
  test('не JSON', () => {
    assert.equal(validateBackup('это не json').error, 'not_json');
  });
  test('обрезанный при пересылке', () => {
    const t = goodText();
    assert.equal(validateBackup(t.slice(0, t.length / 2)).error, 'not_json');
  });
  test('нет списка покупателей или операций', () => {
    assert.equal(validateBackup(withChange((b) => delete b.customers)).error, 'bad_structure');
    assert.equal(validateBackup(withChange((b) => (b.transactions = 'много'))).error, 'bad_structure');
  });
});

describe('Чужой файл', () => {
  test('JSON другого приложения', () => {
    assert.equal(validateBackup(JSON.stringify({ incomes: [], expenses: [] })).error, 'not_dapter');
  });
  test('массив вместо объекта', () => {
    assert.equal(validateBackup('[1, 2, 3]').error, 'not_dapter');
  });
  test('просто число или строка', () => {
    assert.equal(validateBackup('42').error, 'not_dapter');
    assert.equal(validateBackup('"dapter"').error, 'not_dapter');
  });
});

describe('Ошибки внутри данных', () => {
  test('дробная сумма', () => {
    assert.equal(validateBackup(withChange((b) => (b.transactions[0].amount = 10.5))).error, 'bad_transaction');
  });
  test('отрицательная и нулевая сумма', () => {
    assert.equal(validateBackup(withChange((b) => (b.transactions[0].amount = -100))).error, 'bad_transaction');
    assert.equal(validateBackup(withChange((b) => (b.transactions[0].amount = 0))).error, 'bad_transaction');
  });
  test('сумма строкой', () => {
    assert.equal(validateBackup(withChange((b) => (b.transactions[0].amount = '5000'))).error, 'bad_transaction');
  });
  test('неизвестный тип операции', () => {
    assert.equal(validateBackup(withChange((b) => (b.transactions[0].type = 'gift'))).error, 'bad_transaction');
  });
  test('неверный способ оплаты', () => {
    assert.equal(validateBackup(withChange((b) => (b.transactions[1].method = 'card'))).error, 'bad_transaction');
  });
  test('кривая дата', () => {
    assert.equal(validateBackup(withChange((b) => (b.transactions[0].createdAt = 'вчера'))).error, 'bad_transaction');
  });
  test('операция ссылается на несуществующего покупателя', () => {
    assert.equal(validateBackup(withChange((b) => (b.transactions[0].customerId = 'c999'))).error, 'unknown_customer');
  });
  test('повторяющиеся id', () => {
    assert.equal(validateBackup(withChange((b) => (b.customers[1].id = 'c1'))).error, 'duplicate_id');
    assert.equal(validateBackup(withChange((b) => (b.transactions[1].id = 't1'))).error, 'duplicate_id');
  });
  test('покупатель без имени или с неверным телефоном', () => {
    assert.equal(validateBackup(withChange((b) => (b.customers[0].name = ''))).error, 'bad_customer');
    assert.equal(validateBackup(withChange((b) => (b.customers[0].phone = '12345'))).error, 'bad_customer');
  });
});

describe('Версия', () => {
  test('файл от более новой версии приложения не принимается', () => {
    const r = validateBackup(withChange((b) => (b.schemaVersion = SCHEMA_VERSION + 1)));
    assert.equal(r.error, 'newer_version');
  });
  test('без версии — повреждённый', () => {
    assert.equal(validateBackup(withChange((b) => delete b.schemaVersion)).error, 'bad_structure');
  });
});
