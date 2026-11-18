// Дәптер — расчёты (SPEC.md, разделы 5 и 6).
// Только чистые функции: без экрана, без базы, без сети.
//
// Операция (transaction): { id, customerId, type: 'credit'|'payment', amount,
//   method, comment, createdAt: ISO-строка, voided: true|false }

export const MAX_AMOUNT = 10_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Суммы ----------

/**
 * Проверка суммы (правило 2): только целое число от 1 до 10 000 000.
 * Принимает число или строку из цифр. Возвращает { ok: true, value } или { ok: false, error }.
 * error: 'empty' | 'not_integer' | 'not_positive' | 'too_large'
 */
export function validateAmount(input) {
  if (input === null || input === undefined || input === '') {
    return { ok: false, error: 'empty' };
  }
  let value = input;
  if (typeof input === 'string') {
    const s = input.replace(/\s/g, '');
    if (s === '') return { ok: false, error: 'empty' };
    if (!/^-?\d+$/.test(s)) return { ok: false, error: 'not_integer' };
    value = Number(s);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, error: 'not_integer' };
  }
  if (value <= 0) return { ok: false, error: 'not_positive' };
  if (value > MAX_AMOUNT) return { ok: false, error: 'too_large' };
  return { ok: true, value };
}

/** Формат суммы (правило 11): 1250000 → «1 250 000 ₸». */
export function formatAmount(amount) {
  const sign = amount < 0 ? '-' : '';
  const digits = String(Math.abs(Math.trunc(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${digits} ₸`;
}

// ---------- Даты (по местному времени телефона) ----------

function startOfLocalDay(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Сколько календарных дней прошло от даты from до now (по местному времени). */
export function calendarDaysBetween(from, now) {
  const a = startOfLocalDay(from);
  const b = startOfLocalDay(now);
  // Math.round сглаживает переход на летнее/зимнее время (день 23 или 25 часов).
  return Math.round((b - a) / DAY_MS);
}

/** Попадает ли момент в «сегодня» (правило 9: с 00:00 до 23:59 местного времени). */
export function isSameLocalDay(date, now) {
  return calendarDaysBetween(date, now) === 0;
}

// ---------- Операции и баланс ----------

/** Неотменённые операции. */
export function activeTransactions(transactions) {
  return transactions.filter((t) => !t.voided);
}

/**
 * Баланс покупателя (правило 1): сумма credit − сумма payment по неотменённым операциям.
 * > 0 — долг, < 0 — переплата (аванс), 0 — расчёт закрыт.
 */
export function customerBalance(transactions) {
  let balance = 0;
  for (const t of activeTransactions(transactions)) {
    if (t.type === 'credit') balance += t.amount;
    else if (t.type === 'payment') balance -= t.amount;
  }
  return balance;
}

/**
 * Лимит (правило 4): превысит ли новый долг лимит покупателя.
 * Лимит пустой (null/undefined/'') — без лимита. Не блокирует, только сообщает.
 * Возвращает { exceeds, newBalance, over } — over: на сколько превышен лимит.
 */
export function checkLimit(balance, amount, creditLimit) {
  const newBalance = balance + amount;
  if (creditLimit === null || creditLimit === undefined || creditLimit === '') {
    return { exceeds: false, newBalance, over: 0 };
  }
  const over = newBalance - creditLimit;
  return { exceeds: over > 0, newBalance, over: Math.max(over, 0) };
}

/**
 * Возврат больше долга (правило 3): на сколько платёж превышает текущий долг.
 * Возвращает { overpay: true|false, extra } — extra пойдёт в аванс.
 */
export function checkOverpayment(balance, amount) {
  const debt = Math.max(balance, 0);
  const extra = amount - debt;
  return { overpay: extra > 0, extra: Math.max(extra, 0) };
}

/**
 * «Давно не платит» (правило 5): баланс > 0 и последний payment
 * (а если его не было — первый credit) старше overdueDays дней.
 * «Старше 30 дней» = прошло 31 календарный день и больше.
 */
export function isOverdue(transactions, now, overdueDays = 30) {
  const active = activeTransactions(transactions);
  if (customerBalance(active) <= 0) return false;

  const payments = active.filter((t) => t.type === 'payment');
  let reference;
  if (payments.length > 0) {
    reference = payments.reduce((max, t) => (t.createdAt > max ? t.createdAt : max), payments[0].createdAt);
  } else {
    const credits = active.filter((t) => t.type === 'credit');
    if (credits.length === 0) return false;
    reference = credits.reduce((min, t) => (t.createdAt < min ? t.createdAt : min), credits[0].createdAt);
  }
  return calendarDaysBetween(reference, now) > overdueDays;
}

/** Сколько дней назад была последняя неотменённая операция; null, если операций нет. */
export function daysSinceLastActivity(transactions, now) {
  const active = activeTransactions(transactions);
  if (active.length === 0) return null;
  const last = active.reduce((max, t) => (t.createdAt > max ? t.createdAt : max), active[0].createdAt);
  return calendarDaysBetween(last, now);
}

/**
 * Итоги магазина для плашки на главном экране.
 * totalDebt — сумма только положительных балансов (переплата одного не уменьшает долг других).
 * Возвращает { totalDebt, debtorsCount, todayCredit, todayPayment }.
 */
export function shopTotals(customers, transactions, now) {
  const byCustomer = new Map();
  for (const t of activeTransactions(transactions)) {
    if (!byCustomer.has(t.customerId)) byCustomer.set(t.customerId, []);
    byCustomer.get(t.customerId).push(t);
  }

  let totalDebt = 0;
  let debtorsCount = 0;
  for (const c of customers) {
    const balance = customerBalance(byCustomer.get(c.id) ?? []);
    if (balance > 0) {
      totalDebt += balance;
      debtorsCount += 1;
    }
  }

  let todayCredit = 0;
  let todayPayment = 0;
  for (const t of activeTransactions(transactions)) {
    if (!isSameLocalDay(t.createdAt, now)) continue;
    if (t.type === 'credit') todayCredit += t.amount;
    else if (t.type === 'payment') todayPayment += t.amount;
  }

  return { totalDebt, debtorsCount, todayCredit, todayPayment };
}

// ---------- Отчёт за месяц ----------

/** Сумма положительных балансов (общий долг) по операциям, сделанным раньше момента until. */
function debtBefore(byCustomer, until) {
  let total = 0;
  for (const ops of byCustomer.values()) {
    const balance = customerBalance(ops.filter((t) => Date.parse(t.createdAt) < until));
    if (balance > 0) total += balance;
  }
  return total;
}

/**
 * Отчёт по движениям за месяц (месяц — по местному времени телефона, month: 0–11).
 * Отменённые операции не учитываются.
 * Возвращает {
 *   credit, creditCount,             — выдано в долг
 *   payment, paymentCount, cash, kaspi — вернули (и по способам)
 *   debtStart, debtEnd, change       — общий долг на начало и конец месяца
 *   byCustomer: [{ customerId, credit, payment, balanceEnd }] — у кого были операции
 *   operations: [...]                — операции месяца, новые сверху
 * }
 */
export function monthReport(transactions, year, month) {
  const start = new Date(year, month, 1).getTime();
  const end = new Date(year, month + 1, 1).getTime();
  const active = activeTransactions(transactions);

  const byCustomer = new Map();
  for (const t of active) {
    if (!byCustomer.has(t.customerId)) byCustomer.set(t.customerId, []);
    byCustomer.get(t.customerId).push(t);
  }

  const operations = active
    .filter((t) => {
      const time = Date.parse(t.createdAt);
      return time >= start && time < end;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const r = { credit: 0, creditCount: 0, payment: 0, paymentCount: 0, cash: 0, kaspi: 0 };
  const perCustomer = new Map();
  for (const t of operations) {
    if (!perCustomer.has(t.customerId)) perCustomer.set(t.customerId, { customerId: t.customerId, credit: 0, payment: 0 });
    const row = perCustomer.get(t.customerId);
    if (t.type === 'credit') {
      r.credit += t.amount;
      r.creditCount += 1;
      row.credit += t.amount;
    } else if (t.type === 'payment') {
      r.payment += t.amount;
      r.paymentCount += 1;
      row.payment += t.amount;
      if (t.method === 'kaspi') r.kaspi += t.amount;
      else r.cash += t.amount;
    }
  }

  const rows = [...perCustomer.values()].map((row) => ({
    ...row,
    balanceEnd: customerBalance(byCustomer.get(row.customerId).filter((t) => Date.parse(t.createdAt) < end)),
  }));
  rows.sort((a, b) => b.balanceEnd - a.balanceEnd || b.credit - a.credit);

  const debtStart = debtBefore(byCustomer, start);
  const debtEnd = debtBefore(byCustomer, end);
  return { ...r, debtStart, debtEnd, change: debtEnd - debtStart, byCustomer: rows, operations };
}

// ---------- Поиск (правило 8) ----------

/** Нижний регистр, «ё» → «е», лишние пробелы убраны. Казахские буквы сохраняются. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Подходит ли покупатель под поисковый запрос: по имени и заметке (подстрока),
 * по телефону — по любой части цифр. Пустой запрос подходит всем.
 */
export function matchesSearch(customer, query) {
  const q = normalize(query);
  if (q === '') return true;

  if (normalize(customer.name).includes(q)) return true;
  if (normalize(customer.note).includes(q)) return true;

  const queryDigits = String(query).replace(/\D/g, '');
  const phoneDigits = String(customer.phone ?? '').replace(/\D/g, '');
  if (queryDigits.length > 0 && phoneDigits.includes(queryDigits)) return true;

  return false;
}
