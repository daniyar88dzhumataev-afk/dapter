// Дәптер — резервная копия (SPEC.md, раздел 7).
// Верхняя часть — чистые функции (проверяются тестами в Node).
// Нижняя часть — работа с файлами в браузере (проверяется вручную).

import { SCHEMA_VERSION, exportAll, replaceAll, saveSettings } from './db.js';
import { validateAmount, shopTotals } from './ledger.js';

export const APP_ID = 'dapter';

// ---------- Чистые функции ----------

/** Имя файла: dapter-backup-2026-11-18.json (дата по местному времени). */
export function backupFileName(date = new Date(), suffix = '') {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `dapter-backup-${yyyy}-${mm}-${dd}${suffix}.json`;
}

/** Собрать объект резервной копии из данных базы. */
export function buildBackup({ customers, transactions, settings }, now = new Date()) {
  return {
    app: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(now).toISOString(),
    customers,
    transactions,
    settings,
  };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isValidDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function fail(error, details) {
  return { ok: false, error, details };
}

/**
 * Проверить текст файла резервной копии.
 * Успех: { ok: true, data: { customers, transactions, settings }, summary }
 *   summary: { customers, transactions, totalDebt, exportedAt }
 * Ошибка: { ok: false, error, details }
 *   error: 'empty' | 'not_json' | 'not_dapter' | 'newer_version' | 'bad_structure'
 *        | 'bad_customer' | 'bad_transaction' | 'duplicate_id' | 'unknown_customer'
 */
export function validateBackup(text, now = new Date()) {
  if (typeof text !== 'string' || text.trim() === '') return fail('empty');

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('not_json');
  }

  if (!isObject(json) || json.app !== APP_ID) return fail('not_dapter');

  if (!Number.isInteger(json.schemaVersion) || json.schemaVersion < 1) return fail('bad_structure', 'schemaVersion');
  if (json.schemaVersion > SCHEMA_VERSION) return fail('newer_version', json.schemaVersion);

  const { customers, transactions } = json;
  const settings = json.settings ?? {};
  if (!Array.isArray(customers) || !Array.isArray(transactions) || !isObject(settings)) {
    return fail('bad_structure');
  }

  // Покупатели
  const customerIds = new Set();
  for (let i = 0; i < customers.length; i++) {
    const c = customers[i];
    if (!isObject(c) || !isNonEmptyString(c.id)) return fail('bad_customer', i);
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (name.length < 1 || name.length > 60) return fail('bad_customer', i);
    if (c.phone && !/^7\d{10}$/.test(String(c.phone))) return fail('bad_customer', i);
    if (c.creditLimit !== null && c.creditLimit !== undefined && !validateAmount(c.creditLimit).ok) {
      return fail('bad_customer', i);
    }
    if (customerIds.has(c.id)) return fail('duplicate_id', c.id);
    customerIds.add(c.id);
  }

  // Операции
  const txIds = new Set();
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    if (!isObject(t) || !isNonEmptyString(t.id)) return fail('bad_transaction', i);
    if (t.type !== 'credit' && t.type !== 'payment') return fail('bad_transaction', i);
    if (typeof t.amount !== 'number' || !validateAmount(t.amount).ok) return fail('bad_transaction', i);
    if (!isValidDate(t.createdAt)) return fail('bad_transaction', i);
    if (t.voided !== undefined && typeof t.voided !== 'boolean') return fail('bad_transaction', i);
    if (t.type === 'payment' && t.method != null && t.method !== 'cash' && t.method !== 'kaspi') {
      return fail('bad_transaction', i);
    }
    if (txIds.has(t.id)) return fail('duplicate_id', t.id);
    txIds.add(t.id);
    if (!customerIds.has(t.customerId)) return fail('unknown_customer', i);
  }

  const data = { customers, transactions, settings };
  const summary = {
    customers: customers.length,
    transactions: transactions.length,
    totalDebt: shopTotals(customers, transactions, now).totalDebt,
    exportedAt: isValidDate(json.exportedAt) ? json.exportedAt : null,
  };
  return { ok: true, data, summary };
}

// ---------- Браузер: сохранить и восстановить ----------

function makeFile(backup, fileName) {
  return new File([JSON.stringify(backup, null, 2)], fileName, { type: 'application/json' });
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Сохранить резервную копию: через «Поделиться» (если телефон умеет делиться файлами),
 * иначе скачиванием. После успеха обновляет lastBackupAt.
 * Возвращает { saved: true, method: 'share'|'download', fileName } или { saved: false, cancelled: true }.
 */
export async function exportBackup() {
  const now = new Date();
  const backup = buildBackup(await exportAll(), now);
  const file = makeFile(backup, backupFileName(now));

  let method = 'download';
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      method = 'share';
    } catch (err) {
      if (err?.name === 'AbortError') return { saved: false, cancelled: true };
      downloadFile(file); // «Поделиться» не сработало — скачиваем
    }
  } else {
    downloadFile(file);
  }

  await saveSettings({ lastBackupAt: now.toISOString() });
  return { saved: true, method, fileName: file.name };
}

/** Шаг 1 восстановления: прочитать и проверить выбранный файл (для предпросмотра). */
export async function prepareRestore(file) {
  if (!file) return fail('empty');
  let text;
  try {
    text = await file.text();
  } catch {
    return fail('not_json');
  }
  return validateBackup(text);
}

/**
 * Шаг 2 восстановления (после подтверждения человеком):
 * автокопия текущих данных в файл *-before-restore.json, затем замена одной транзакцией.
 * checked — результат prepareRestore с ok: true.
 */
export async function applyRestore(checked) {
  if (!checked?.ok) throw new Error('backup_not_checked');
  const now = new Date();
  const current = await exportAll();
  if (current.customers.length > 0 || current.transactions.length > 0) {
    downloadFile(makeFile(buildBackup(current, now), backupFileName(now, '-before-restore')));
  }
  await replaceAll(checked.data);
}
