// Дәптер — работа с IndexedDB (SPEC.md, разделы 5 и 7).
// Без сторонних библиотек. Данные никуда не отправляются.
// Операции не удаляются — только отменяются (voided). Функции удаления операций нет.

import { validateAmount, customerBalance } from './ledger.js';

export const DB_NAME = 'dapter';
export const SCHEMA_VERSION = 1;
const SETTINGS_KEY = 'main';

export const DEFAULT_SETTINGS = Object.freeze({
  shopName: '',
  kaspiPhone: '',
  uiLang: 'ru',
  messageLang: null, // null = как uiLang
  overdueDays: 30,
  pinHash: '',
  lastBackupAt: null,
  schemaVersion: SCHEMA_VERSION,
});

// ---------- Ошибки с кодом (тексты для человека — в i18n) ----------

export class DbError extends Error {
  constructor(code, details) {
    super(code);
    this.name = 'DbError';
    this.code = code;
    this.details = details;
  }
}

// ---------- Обёртки над IndexedDB ----------

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DbError('aborted'));
  });
}

let dbPromise = null;

/** Открыть базу (один раз за запуск). */
export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('customers')) {
        const s = db.createObjectStore('customers', { keyPath: 'id' });
        s.createIndex('name', 'name');
      }
      if (!db.objectStoreNames.contains('transactions')) {
        const s = db.createObjectStore('transactions', { keyPath: 'id' });
        s.createIndex('customerId', 'customerId');
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

/** Попросить браузер не стирать данные (navigator.storage.persist). true — разрешено. */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ---------- Настройки ----------

export async function getSettings() {
  const db = await openDB();
  const row = await req(db.transaction('settings').objectStore('settings').get(SETTINGS_KEY));
  const { id, ...stored } = row ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

/** Изменить часть настроек: saveSettings({ shopName: 'Береке' }). */
export async function saveSettings(patch) {
  const db = await openDB();
  const tx = db.transaction('settings', 'readwrite');
  const store = tx.objectStore('settings');
  const current = (await req(store.get(SETTINGS_KEY))) ?? { id: SETTINGS_KEY, ...DEFAULT_SETTINGS };
  const next = { ...current, ...patch, id: SETTINGS_KEY, schemaVersion: SCHEMA_VERSION };
  store.put(next);
  await done(tx);
  const { id, ...settings } = next;
  return settings;
}

// ---------- Покупатели ----------

function nowISO() {
  return new Date().toISOString();
}

/** Проверка полей покупателя (раздел 5). Возвращает очищенную копию или бросает DbError. */
export function cleanCustomer(input) {
  const name = String(input.name ?? '').trim();
  if (name.length < 1 || name.length > 60) throw new DbError('bad_name');

  const phone = String(input.phone ?? '').replace(/\D/g, '');
  if (phone && !/^7\d{10}$/.test(phone)) throw new DbError('bad_phone');

  const consent = Boolean(input.consent);
  if (phone && !consent) throw new DbError('consent_required');

  const note = String(input.note ?? '').trim();
  if (note.length > 100) throw new DbError('note_too_long');

  let creditLimit = input.creditLimit;
  if (creditLimit === '' || creditLimit === undefined) creditLimit = null;
  if (creditLimit !== null) {
    const check = validateAmount(creditLimit);
    if (!check.ok) throw new DbError('bad_limit', check.error);
    creditLimit = check.value;
  }

  return { name, phone, note, creditLimit, consent: phone ? consent : false };
}

export async function listCustomers() {
  const db = await openDB();
  return req(db.transaction('customers').objectStore('customers').getAll());
}

export async function getCustomer(id) {
  const db = await openDB();
  return req(db.transaction('customers').objectStore('customers').get(id));
}

/** Создать (без id) или изменить (с id) покупателя. Возвращает сохранённую запись. */
export async function saveCustomer(input) {
  const fields = cleanCustomer(input);
  const db = await openDB();
  const tx = db.transaction('customers', 'readwrite');
  const store = tx.objectStore('customers');
  const time = nowISO();

  let record;
  if (input.id) {
    const existing = await req(store.get(input.id));
    if (!existing) throw new DbError('customer_not_found');
    record = { ...existing, ...fields, updatedAt: time };
  } else {
    record = { id: crypto.randomUUID(), ...fields, archived: false, createdAt: time, updatedAt: time };
  }
  store.put(record);
  await done(tx);
  return record;
}

/** В архив — только при нулевом балансе (раздел 4.4). */
export async function archiveCustomer(id) {
  const db = await openDB();
  const tx = db.transaction(['customers', 'transactions'], 'readwrite');
  const customers = tx.objectStore('customers');
  const existing = await req(customers.get(id));
  if (!existing) throw new DbError('customer_not_found');
  const ops = await req(tx.objectStore('transactions').index('customerId').getAll(id));
  if (customerBalance(ops) !== 0) {
    tx.abort();
    throw new DbError('has_balance');
  }
  const record = { ...existing, archived: true, updatedAt: nowISO() };
  customers.put(record);
  await done(tx);
  return record;
}

/** Вернуть из архива. */
export async function unarchiveCustomer(id) {
  const db = await openDB();
  const tx = db.transaction('customers', 'readwrite');
  const store = tx.objectStore('customers');
  const existing = await req(store.get(id));
  if (!existing) throw new DbError('customer_not_found');
  const record = { ...existing, archived: false, updatedAt: nowISO() };
  store.put(record);
  await done(tx);
  return record;
}

// ---------- Операции ----------

export async function listTransactions() {
  const db = await openDB();
  return req(db.transaction('transactions').objectStore('transactions').getAll());
}

export async function listTransactionsByCustomer(customerId) {
  const db = await openDB();
  return req(db.transaction('transactions').objectStore('transactions').index('customerId').getAll(customerId));
}

/**
 * Записать операцию: { customerId, type: 'credit'|'payment', amount, method?, comment? }.
 * Сумма проверяется по правилу 2. Для payment обязателен method: 'cash'|'kaspi'.
 */
export async function addTransaction({ customerId, type, amount, method, comment }) {
  if (type !== 'credit' && type !== 'payment') throw new DbError('bad_type');
  const check = validateAmount(amount);
  if (!check.ok) throw new DbError('bad_amount', check.error);
  if (type === 'payment' && method !== 'cash' && method !== 'kaspi') throw new DbError('bad_method');
  const text = String(comment ?? '').trim();
  if (text.length > 140) throw new DbError('comment_too_long');

  const db = await openDB();
  const tx = db.transaction(['customers', 'transactions'], 'readwrite');
  const customer = await req(tx.objectStore('customers').get(customerId));
  if (!customer) {
    tx.abort();
    throw new DbError('customer_not_found');
  }
  const record = {
    id: crypto.randomUUID(),
    customerId,
    type,
    amount: check.value,
    method: type === 'payment' ? method : null,
    comment: text,
    createdAt: nowISO(),
    voided: false,
    voidedAt: null,
    voidReason: null,
  };
  tx.objectStore('transactions').put(record);
  await done(tx);
  return record;
}

/** Отменить операцию (правило 6). Причина обязательна. Повторно отменить нельзя. */
export async function voidTransaction(id, reason) {
  const why = String(reason ?? '').trim();
  if (!why) throw new DbError('reason_required');

  const db = await openDB();
  const tx = db.transaction('transactions', 'readwrite');
  const store = tx.objectStore('transactions');
  const existing = await req(store.get(id));
  if (!existing) {
    tx.abort();
    throw new DbError('transaction_not_found');
  }
  if (existing.voided) {
    tx.abort();
    throw new DbError('already_voided');
  }
  const record = { ...existing, voided: true, voidedAt: nowISO(), voidReason: why };
  store.put(record);
  await done(tx);
  return record;
}

// ---------- Для резервной копии ----------

/** Все данные: { customers, transactions, settings }. */
export async function exportAll() {
  const db = await openDB();
  const tx = db.transaction(['customers', 'transactions', 'settings'], 'readonly');
  const [customers, transactions, settingsRow] = await Promise.all([
    req(tx.objectStore('customers').getAll()),
    req(tx.objectStore('transactions').getAll()),
    req(tx.objectStore('settings').get(SETTINGS_KEY)),
  ]);
  const { id, ...stored } = settingsRow ?? {};
  return { customers, transactions, settings: { ...DEFAULT_SETTINGS, ...stored } };
}

/**
 * Заменить все данные одной транзакцией: если что-то пойдёт не так,
 * IndexedDB откатит всё и старые данные останутся целы.
 * Данные должны быть заранее проверены (backup.validateBackup).
 */
export async function replaceAll({ customers, transactions, settings }) {
  const db = await openDB();
  const tx = db.transaction(['customers', 'transactions', 'settings'], 'readwrite');
  const cs = tx.objectStore('customers');
  const ts = tx.objectStore('transactions');
  const ss = tx.objectStore('settings');
  cs.clear();
  ts.clear();
  ss.clear();
  for (const c of customers) cs.put(c);
  for (const t of transactions) ts.put(t);
  ss.put({ ...DEFAULT_SETTINGS, ...settings, id: SETTINGS_KEY, schemaVersion: SCHEMA_VERSION });
  await done(tx);
}
