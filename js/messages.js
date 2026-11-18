// Дәптер — тексты для покупателей и ссылки WhatsApp (SPEC.md, разделы 4.6 и 6).
// Казахские тексты — черновик, перед запуском проверить с носителем языка.

import { activeTransactions, customerBalance, formatAmount } from './ledger.js';

export const STATEMENT_LIMIT = 15;

const TEXTS = {
  ru: {
    hello: (name) => `Здравствуйте, ${name}!`,
    debtWithShop: (shop, sum) => `Напоминаем, что в магазине «${shop}» за вами ${sum}.`,
    debtNoShop: (sum) => `Напоминаем, что за вами ${sum}.`,
    kaspi: (num) => `Можно перевести на Kaspi: ${num}.`,
    thanks: 'Спасибо!',
    statementTitle: (name) => `Выписка: ${name}`,
    shop: (shop) => `Магазин «${shop}»`,
    date: (d) => `Дата: ${d}`,
    credit: 'взял',
    payment: 'вернул',
    earlier: (n) => `…и ещё ${n} более ранних операций`,
    noOps: 'Операций нет',
    totalDebt: (sum) => `Итого долг: ${sum}`,
    overpaid: (sum) => `Переплата: ${sum}`,
    noDebt: 'Долга нет',
  },
  kk: {
    hello: (name) => `Сәлеметсіз бе, ${name}!`,
    debtWithShop: (shop, sum) => `«${shop}» дүкеніндегі қарызыңыз: ${sum}.`,
    debtNoShop: (sum) => `Қарызыңыз: ${sum}.`,
    kaspi: (num) => `Kaspi арқылы аударуға болады: ${num}.`,
    thanks: 'Рахмет!',
    statementTitle: (name) => `Қарыз: ${name}`,
    shop: (shop) => `«${shop}» дүкені`,
    date: (d) => `Күні: ${d}`,
    credit: 'алды',
    payment: 'қайтарды',
    earlier: (n) => `…және тағы ${n} ертерек операция`,
    noOps: 'Операция жоқ',
    totalDebt: (sum) => `Қалған қарыз: ${sum}`,
    overpaid: (sum) => `Артық төлем: ${sum}`,
    noDebt: 'Қарыз жоқ',
  },
};

function t(lang) {
  return TEXTS[lang] ?? TEXTS.ru;
}

/** Дата по местному времени: 18.11.2026 */
export function formatDate(date) {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/** Телефон для чтения человеком: 77011234567 → «+7 701 123 45 67». */
export function formatPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length !== 11) return d;
  return `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9, 11)}`;
}

/**
 * Напоминание о долге (раздел 4.6).
 * data: { name, amount, shopName, kaspiPhone }.
 * Пустой shopName — без названия магазина; пустой kaspiPhone — без фразы про Kaspi.
 */
export function reminderText(lang, { name, amount, shopName, kaspiPhone }) {
  const L = t(lang);
  const sum = formatAmount(amount);
  const parts = [L.hello(name)];
  parts.push(shopName ? L.debtWithShop(shopName, sum) : L.debtNoShop(sum));
  if (kaspiPhone) parts.push(L.kaspi(formatPhone(kaspiPhone)));
  parts.push(L.thanks);
  return parts.join(' ');
}

/**
 * Выписка (раздел 4.6): заголовок с именем и датой, до 15 последних
 * неотменённых операций по порядку (старые выше), итог.
 * options: { shopName, now }.
 */
export function statementText(lang, customer, transactions, { shopName, now } = {}) {
  const L = t(lang);
  const active = activeTransactions(transactions)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const shown = active.slice(-STATEMENT_LIMIT);
  const hidden = active.length - shown.length;

  const lines = [L.statementTitle(customer.name)];
  if (shopName) lines.push(L.shop(shopName));
  lines.push(L.date(formatDate(now ?? new Date())));
  lines.push('');

  if (active.length === 0) {
    lines.push(L.noOps);
  } else {
    if (hidden > 0) lines.push(L.earlier(hidden));
    for (const op of shown) {
      const fields = [formatDate(op.createdAt), op.type === 'credit' ? L.credit : L.payment, formatAmount(op.amount)];
      if (op.comment) fields.push(op.comment);
      lines.push(fields.join(' — '));
    }
  }

  lines.push('');
  const balance = customerBalance(active);
  if (balance > 0) lines.push(L.totalDebt(formatAmount(balance)));
  else if (balance < 0) lines.push(L.overpaid(formatAmount(-balance)));
  else lines.push(L.noDebt);

  return lines.join('\n');
}

/**
 * Ссылка WhatsApp (правило 10): https://wa.me/<phone>?text=<текст>.
 * Номер только цифрами (11 знаков, начинается с 7), иначе null.
 */
export function waLink(phone, text) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!/^7\d{10}$/.test(digits)) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
