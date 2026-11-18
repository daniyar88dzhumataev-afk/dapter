// Дәптер — экраны и навигация (SPEC.md, раздел 4).
// Логика расчётов — в ledger.js, тексты WhatsApp — в messages.js,
// база — в db.js, резервная копия — в backup.js. Здесь только интерфейс.

import * as L from './ledger.js';
import * as M from './messages.js';
import * as DB from './db.js';
import * as B from './backup.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = () => $('#app');

// ---------- Тексты интерфейса (i18n/*.json) ----------

let dict = {};

async function loadTexts(lang) {
  for (const l of [lang, 'ru']) {
    try {
      const res = await fetch(`i18n/${l}.json`);
      if (res.ok) {
        dict = await res.json();
        document.documentElement.lang = l;
        return;
      }
    } catch {
      /* пробуем следующий язык */
    }
  }
}

/** Текст по ключу с подстановкой {параметров}. Параметры с данными людей экранировать при вставке в HTML. */
function t(key, params = {}) {
  const s = dict[key];
  if (typeof s !== 'string') return key;
  return s.replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m));
}

function errorText(err) {
  const key = `error.${err?.code ?? err?.message}`;
  return key in dict ? dict[key] : t('error.unknown');
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => L.formatAmount(n);
const two = (n) => String(n).padStart(2, '0');
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  return `${M.formatDate(d)} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const byDate = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

// Удобства одного телефона (последний способ оплаты). Без них приложение тоже работает.
const local = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* нет доступа — не страшно */
    }
  },
};

// ---------- Данные в памяти ----------

const state = {
  settings: { ...DB.DEFAULT_SETTINGS },
  customers: [],
  txs: [],
  byCustomer: new Map(),
  info: new Map(),
  query: '',
  tab: 'debtors',
  sort: 'recent',
  unlocked: false,
};

async function reload() {
  const [settings, customers, txs] = await Promise.all([DB.getSettings(), DB.listCustomers(), DB.listTransactions()]);
  state.settings = settings;
  state.customers = customers;
  state.txs = txs;
  reindex();
}

function reindex() {
  const now = new Date();
  state.byCustomer = new Map();
  for (const x of state.txs) {
    if (!state.byCustomer.has(x.customerId)) state.byCustomer.set(x.customerId, []);
    state.byCustomer.get(x.customerId).push(x);
  }
  state.info = new Map();
  for (const c of state.customers) {
    const ops = state.byCustomer.get(c.id) ?? [];
    const balance = L.customerBalance(ops);
    const lastAt = L.activeTransactions(ops).reduce((m, x) => (x.createdAt > m ? x.createdAt : m), c.createdAt ?? '');
    state.info.set(c.id, {
      balance,
      lastAt,
      overdue: L.isOverdue(ops, now, state.settings.overdueDays),
      days: L.daysSinceLastActivity(ops, now),
      overLimit: c.creditLimit != null && balance > c.creditLimit,
    });
  }
}

const customerById = (id) => state.customers.find((c) => c.id === id);
const infoOf = (id) => state.info.get(id) ?? { balance: 0, lastAt: '', overdue: false, days: null, overLimit: false };
const msgLang = () => state.settings.messageLang || state.settings.uiLang;

// ---------- Телефон с маской +7 (•••) •••-••-•• ----------

function phoneDigits(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  // Вставили «8701…» или «+7701…» в поле, где уже стоит «+7»
  if (d.length === 12 && d[0] === '7' && (d[1] === '7' || d[1] === '8')) d = '7' + d.slice(2);
  if (d.startsWith('8')) d = '7' + d.slice(1);
  if (d && !d.startsWith('7')) d = '7' + d;
  return d.slice(0, 11);
}

function maskPhone(d) {
  if (!d) return '';
  const p = d.slice(1);
  let s = '+7 (' + p.slice(0, 3);
  if (p.length >= 3) s += ')';
  if (p.length > 3) s += ' ' + p.slice(3, 6);
  if (p.length > 6) s += '-' + p.slice(6, 8);
  if (p.length > 8) s += '-' + p.slice(8, 10);
  return s;
}

function onPhoneInput(el, e) {
  let d = phoneDigits(el.value);
  // Стёрли скобку или дефис — стираем и цифру перед ними
  if (e.inputType?.startsWith('delete') && d === (el.dataset.digits || '')) d = d.slice(0, -1);
  el.dataset.digits = d;
  el.value = maskPhone(d);
}

const cleanPhone = (d) => (d && d.length > 1 ? d : '');

// ---------- Навигация ----------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'customer' && parts[1] === 'new') return { name: 'edit', id: null };
  if (parts[0] === 'customer' && parts[1] && parts[2] === 'edit') return { name: 'edit', id: parts[1] };
  if (parts[0] === 'customer' && parts[1]) return { name: 'customer', id: parts[1] };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'main' };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function render() {
  if (state.settings.pinHash && !state.unlocked) return renderLock();
  const r = parseRoute();
  if (r.name === 'customer') renderCustomer(r.id);
  else if (r.name === 'edit') renderEdit(r.id);
  else if (r.name === 'settings') renderSettings();
  else renderMain();
}

const backLink = (href) => `<a class="icon-btn" href="${href}" aria-label="${esc(t('nav.back'))}">←</a>`;
const customerHref = (id) => `#/customer/${encodeURIComponent(id)}`;

function renderNotFound() {
  app().innerHTML = `
    <header class="bar">${backLink('#/')}<h1 class="bar-title">${esc(t('app.name'))}</h1></header>
    <main class="page"><p class="empty">${esc(t('notFound.text'))}</p>
      <a class="btn" href="#/">${esc(t('notFound.back'))}</a></main>`;
}

// ---------- 4.1 Главный экран «Должники» ----------

function renderMain() {
  const tot = L.shopTotals(state.customers, state.txs, new Date());
  const title = state.settings.shopName || t('app.name');
  const tabs = ['debtors', 'overdue', 'all'];
  const sorts = ['recent', 'amount', 'name'];
  const remind = B.backupReminder({ lastBackupAt: state.settings.lastBackupAt, customers: state.customers, transactions: state.txs });
  app().innerHTML = `
    <header class="bar">
      <h1 class="bar-title">${esc(title)}</h1>
      <a class="icon-btn" href="#/settings" aria-label="${esc(t('settings.title'))}">⚙</a>
    </header>
    <main class="page">
      ${
        remind.show
          ? `<div class="notice backup-notice"><span>${esc(t('backup.banner', { n: remind.days }))}</span>
             <button type="button" class="btn small primary" data-action="backup-save">${esc(t('backup.bannerBtn'))}</button></div>`
          : ''
      }
      <section class="totals" aria-label="${esc(t('totals.aria'))}">
        <div><span class="label">${esc(t('totals.debt'))}</span><b class="tot-sum">${money(tot.totalDebt)}</b></div>
        <div class="tot-side"><span class="label">${esc(t('totals.debtors'))}</span><b>${tot.debtorsCount}</b></div>
        <div class="tot-today">
          <span class="label">${esc(t('totals.today'))}:</span>
          <span>${esc(t('totals.todayCredit'))} <b class="credit">${money(tot.todayCredit)}</b></span>
          <span>${esc(t('totals.todayPayment'))} <b class="payment">${money(tot.todayPayment)}</b></span>
        </div>
      </section>
      <input id="search" class="search" type="search" autocomplete="off" enterkeyhint="search"
        placeholder="${esc(t('main.search'))}" aria-label="${esc(t('main.search'))}" value="${esc(state.query)}">
      <div class="tabs" role="tablist">
        ${tabs
          .map(
            (k) => `<button type="button" role="tab" class="tab ${state.tab === k ? 'active' : ''}"
              aria-selected="${state.tab === k}" data-action="tab" data-tab="${k}">${esc(t('tab.' + k))}</button>`
          )
          .join('')}
      </div>
      <label class="sortrow">${esc(t('sort.label'))}
        <select id="sort">${sorts
          .map((k) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>${esc(t('sort.' + k))}</option>`)
          .join('')}</select>
      </label>
      <ul id="list" class="list"></ul>
    </main>
    <button type="button" class="fab" data-action="new-credit">${esc(t('main.addCredit'))}</button>`;
  updateList();
}

function updateList() {
  const list = $('#list');
  if (!list) return;
  const query = state.query.trim();
  let rows = state.customers.filter((c) => !c.archived);
  if (query) {
    // При поиске ищем среди всех покупателей, а не только во вкладке
    rows = rows.filter((c) => L.matchesSearch(c, query));
  } else if (state.tab === 'debtors') {
    rows = rows.filter((c) => infoOf(c.id).balance > 0);
  } else if (state.tab === 'overdue') {
    rows = rows.filter((c) => infoOf(c.id).overdue);
  }
  const sorters = {
    recent: (a, b) => (infoOf(b.id).lastAt > infoOf(a.id).lastAt ? 1 : infoOf(b.id).lastAt < infoOf(a.id).lastAt ? -1 : 0),
    amount: (a, b) => infoOf(b.id).balance - infoOf(a.id).balance,
    name: (a, b) => a.name.localeCompare(b.name, 'ru'),
  };
  rows.sort(sorters[state.sort] ?? sorters.recent);

  if (rows.length === 0) {
    let text = t('main.emptyDebtors');
    if (state.customers.length === 0) text = t('main.emptyStart');
    else if (query) text = t('main.emptySearch');
    else if (state.tab === 'overdue') text = t('main.emptyOverdue');
    list.innerHTML = `<li class="empty">${esc(text)}</li>`;
    return;
  }
  list.innerHTML = rows.map(rowHtml).join('');
}

function daysText(d) {
  if (d === null) return t('row.noOps');
  if (d === 0) return t('row.today');
  return t('row.daysAgo', { n: d });
}

function rowHtml(c) {
  const i = infoOf(c.id);
  const flag = i.overLimit || i.overdue;
  const cls = i.balance > 0 ? 'debt' : i.balance < 0 ? 'over' : 'zero';
  const sum = i.balance < 0 ? t('row.overpaid', { sum: money(-i.balance) }) : money(i.balance);
  const marks = [daysText(i.days)];
  if (i.overdue) marks.push(t('row.overdue'));
  if (i.overLimit) marks.push(t('row.overLimit'));
  return `<li><a class="row${flag ? ' flag' : ''}" href="${customerHref(c.id)}">
    <span class="row-main">
      <span class="row-name">${flag ? '<span class="dot" aria-hidden="true"></span>' : ''}${esc(c.name)}</span>
      ${c.note ? `<span class="row-note">${esc(c.note)}</span>` : ''}
      <span class="row-meta">${esc(marks.join(' · '))}</span>
    </span>
    <span class="row-sum ${cls}">${esc(sum)}</span></a></li>`;
}

// ---------- 4.2 Карточка покупателя ----------

function renderCustomer(id) {
  const c = customerById(id);
  if (!c) return renderNotFound();
  const i = infoOf(id);
  const ops = state.byCustomer.get(id) ?? [];
  const s = state.settings;
  const reminder =
    c.phone && i.balance > 0
      ? M.waLink(c.phone, M.reminderText(msgLang(), { name: c.name, amount: i.balance, shopName: s.shopName, kaspiPhone: s.kaspiPhone }))
      : null;
  const statement = c.phone ? M.waLink(c.phone, M.statementText(msgLang(), c, ops, { shopName: s.shopName, now: new Date() })) : null;
  const cls = i.balance > 0 ? 'debt' : i.balance < 0 ? 'over' : 'zero';
  const label = i.balance > 0 ? t('card.debt') : i.balance < 0 ? t('card.overpaid') : t('card.noDebt');
  const dis = c.archived ? 'disabled' : '';

  app().innerHTML = `
    <header class="bar">${backLink('#/')}
      <h1 class="bar-title">${esc(c.name)}</h1>
      <a class="bar-link" href="${customerHref(id)}/edit">${esc(t('card.edit'))}</a>
    </header>
    <main class="page">
      ${
        c.archived
          ? `<div class="notice">${esc(t('card.archived'))}
             <button type="button" class="btn small" data-action="unarchive" data-id="${esc(id)}">${esc(t('archive.restore'))}</button></div>`
          : ''
      }
      <section class="card-info">
        ${c.phone ? `<div>${esc(M.formatPhone(c.phone))}</div>` : `<div class="muted">${esc(t('card.noPhone'))}</div>`}
        ${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}
        ${c.creditLimit != null ? `<div class="muted">${esc(t('card.limit', { sum: money(c.creditLimit) }))}</div>` : ''}
      </section>
      <section class="balance ${cls}">
        <span class="label">${esc(label)}</span>
        ${i.balance !== 0 ? `<b class="balance-sum">${money(Math.abs(i.balance))}</b>` : ''}
      </section>
      <div class="actions2">
        <button type="button" class="btn big credit" data-action="op" data-type="credit" data-id="${esc(id)}" ${dis}>${esc(t('card.credit'))}</button>
        <button type="button" class="btn big payment" data-action="op" data-type="payment" data-id="${esc(id)}" ${dis}>${esc(t('card.payment'))}</button>
      </div>
      <div class="actions2">
        ${waButton(reminder, t('card.remind'))}
        ${waButton(statement, t('card.statement'))}
      </div>
      ${c.phone ? '' : `<p class="hint">${esc(t('card.waHint'))}</p>`}
      <h2 class="section-title">${esc(t('card.history'))}</h2>
      ${historyHtml(ops)}
    </main>`;
}

function waButton(href, label) {
  return href
    ? `<a class="btn wa" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`
    : `<button type="button" class="btn wa" disabled>${esc(label)}</button>`;
}

function historyHtml(ops) {
  if (ops.length === 0) return `<p class="empty">${esc(t('card.noHistory'))}</p>`;
  const after = new Map();
  let run = 0;
  for (const x of ops.filter((o) => !o.voided).sort(byDate)) {
    run += x.type === 'credit' ? x.amount : -x.amount;
    after.set(x.id, run);
  }
  const items = [...ops].sort(byDate).reverse();
  return `<ul class="history">${items
    .map((x) => {
      const type = x.type === 'credit' ? t('op.credit') : t('op.payment');
      const method = x.type === 'payment' && x.method ? ' · ' + t('method.' + x.method) : '';
      const sign = x.type === 'credit' ? '+' : '−';
      const bottom = x.voided
        ? `<div class="op-void">${esc(t('op.voided', { reason: x.voidReason || '' }))}</div>`
        : `<div class="op-bottom"><span class="muted">${esc(t('op.balanceAfter', { sum: money(after.get(x.id)) }))}</span>
             <button type="button" class="btn small ghost" data-action="void" data-id="${esc(x.id)}">${esc(t('op.void'))}</button></div>`;
      return `<li class="op ${x.type}${x.voided ? ' voided' : ''}">
        <div class="op-top"><span>${esc(type + method)}</span><span class="op-sum">${sign}${money(x.amount)}</span></div>
        <div class="op-meta">${esc(fmtDateTime(x.createdAt))}${x.comment ? ' · ' + esc(x.comment) : ''}</div>
        ${bottom}</li>`;
    })
    .join('')}</ul>`;
}

// ---------- 4.4 Покупатель: добавление и редактирование ----------

const fv = (form, name) => form.querySelector(`[name="${name}"]`);

function renderEdit(id) {
  const c = id ? customerById(id) : null;
  if (id && !c) return renderNotFound();
  const i = c ? infoOf(c.id) : null;
  let archiveBlock = '';
  if (c && !c.archived) {
    archiveBlock =
      i.balance === 0
        ? `<button type="button" class="btn ghost danger" data-action="archive" data-id="${esc(c.id)}">${esc(t('archive.toArchive'))}</button>`
        : `<p class="hint">${esc(t('archive.hasBalance'))}</p>`;
  }
  app().innerHTML = `
    <header class="bar">${backLink(c ? customerHref(c.id) : '#/')}
      <h1 class="bar-title">${esc(c ? t('edit.titleEdit') : t('edit.titleNew'))}</h1></header>
    <main class="page">
      <form id="cform" class="form" data-id="${esc(c?.id ?? '')}" novalidate>
        <label class="field"><span>${esc(t('field.name'))} *</span>
          <input name="name" maxlength="60" autocomplete="off" value="${esc(c?.name)}"></label>
        <label class="field"><span>${esc(t('field.phone'))}</span>
          <input name="phone" type="tel" inputmode="tel" autocomplete="off" data-phone placeholder="+7 (___) ___-__-__"
            data-digits="${esc(c?.phone ?? '')}" value="${esc(maskPhone(c?.phone ?? ''))}"></label>
        <label class="field"><span>${esc(t('field.note'))}</span>
          <input name="note" maxlength="100" autocomplete="off" value="${esc(c?.note)}"></label>
        <label class="field"><span>${esc(t('field.limit'))}</span>
          <input name="limit" inputmode="numeric" autocomplete="off" placeholder="${esc(t('field.limitHint'))}" value="${esc(c?.creditLimit ?? '')}"></label>
        <label class="check"><input type="checkbox" name="consent" ${c?.consent ? 'checked' : ''}>
          <span>${esc(t('field.consent'))}</span></label>
        <p id="dup" class="warn" hidden></p>
        <p id="form-error" class="error" role="alert" hidden></p>
        <button type="submit" class="btn big primary">${esc(t('edit.save'))}</button>
      </form>
      ${archiveBlock}
    </main>`;
  checkDuplicate();
}

function checkDuplicate() {
  const form = $('#cform');
  if (!form) return;
  const selfId = form.dataset.id || null;
  const name = L.normalize(fv(form, 'name').value);
  const phone = cleanPhone(fv(form, 'phone').dataset.digits);
  const dup = state.customers.find(
    (o) => o.id !== selfId && ((phone.length === 11 && o.phone === phone) || (name && L.normalize(o.name) === name))
  );
  const el = $('#dup');
  if (dup) {
    el.hidden = false;
    el.innerHTML = esc(t('edit.duplicate', { name: '\u0000' })).replace(
      '\u0000',
      `<a href="${customerHref(dup.id)}">${esc(dup.name)}</a>`
    );
  } else {
    el.hidden = true;
  }
}

function showFormError(text) {
  const el = $('#form-error');
  if (!el) return toast(text);
  el.textContent = text;
  el.hidden = false;
}

async function submitCustomer(form) {
  const limit = fv(form, 'limit').value.replace(/\s/g, '');
  const data = {
    id: form.dataset.id || undefined,
    name: fv(form, 'name').value,
    phone: cleanPhone(fv(form, 'phone').dataset.digits),
    note: fv(form, 'note').value,
    creditLimit: limit === '' ? null : limit,
    consent: fv(form, 'consent').checked,
  };
  try {
    const saved = await DB.saveCustomer(data);
    await reload();
    go(customerHref(saved.id));
  } catch (err) {
    showFormError(errorText(err));
  }
}

async function archive(id) {
  const c = customerById(id);
  if (!c) return;
  const ok = await confirmDialog(t('archive.confirmTitle'), t('archive.confirmText', { name: c.name }), t('archive.toArchive'), 'danger');
  if (!ok) return;
  try {
    await DB.archiveCustomer(id);
    await reload();
    go('#/');
    toast(t('archive.done'));
  } catch (err) {
    toast(errorText(err));
  }
}

async function unarchive(id) {
  try {
    await DB.unarchiveCustomer(id);
    await reload();
    render();
    toast(t('archive.restored'));
  } catch (err) {
    toast(errorText(err));
  }
}

// ---------- 4.5 Настройки ----------

const pinAvailable = () => Boolean(globalThis.crypto?.subtle);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pinSection() {
  if (!pinAvailable()) return `<p class="hint">${esc(t('pin.unavailable'))}</p>`;
  if (state.settings.pinHash) {
    return `<p class="muted">${esc(t('pin.on'))}</p>
      <div class="stack">
        <button type="button" class="btn" data-action="pin-change">${esc(t('pin.change'))}</button>
        <button type="button" class="btn ghost danger" data-action="pin-off">${esc(t('pin.off'))}</button>
      </div>`;
  }
  return `<p class="muted">${esc(t('pin.offState'))}</p>
    <button type="button" class="btn" data-action="pin-on">${esc(t('pin.enable'))}</button>`;
}

function renderSettings() {
  const s = state.settings;
  const archived = state.customers.filter((c) => c.archived).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  app().innerHTML = `
    <header class="bar">${backLink('#/')}<h1 class="bar-title">${esc(t('settings.title'))}</h1></header>
    <main class="page">
      <form id="sform" class="form" novalidate>
        <h2 class="section-title">${esc(t('settings.shop'))}</h2>
        <label class="field"><span>${esc(t('settings.shopName'))}</span>
          <input name="shopName" maxlength="60" autocomplete="off" value="${esc(s.shopName)}"></label>
        <label class="field"><span>${esc(t('settings.kaspi'))}</span>
          <input name="kaspiPhone" type="tel" inputmode="tel" autocomplete="off" data-phone placeholder="+7 (___) ___-__-__"
            data-digits="${esc(s.kaspiPhone)}" value="${esc(maskPhone(s.kaspiPhone))}"></label>
        <label class="field"><span>${esc(t('settings.overdueDays'))}</span>
          <input name="overdueDays" inputmode="numeric" autocomplete="off" value="${esc(s.overdueDays)}"></label>
        <p id="form-error" class="error" role="alert" hidden></p>
        <button type="submit" class="btn primary">${esc(t('settings.save'))}</button>
      </form>

      <h2 class="section-title">${esc(t('pin.title'))}</h2>
      ${pinSection()}

      <h2 class="section-title">${esc(t('backup.title'))}</h2>
      <p class="muted">${esc(s.lastBackupAt ? t('backup.last', { date: fmtDateTime(s.lastBackupAt) }) : t('backup.never'))}</p>
      <div class="stack">
        <button type="button" class="btn primary" data-action="backup-save">${esc(t('backup.save'))}</button>
        <button type="button" class="btn" data-action="backup-restore">${esc(t('backup.restore'))}</button>
        <input id="restore-file" type="file" accept=".json,application/json" hidden>
      </div>

      <h2 class="section-title">${esc(t('install.title'))}</h2>
      ${
        isStandalone()
          ? `<p class="muted">${esc(t('install.done'))}</p>`
          : `<button type="button" class="btn" data-action="install-help">${esc(t('install.how'))}</button>`
      }

      <h2 class="section-title">${esc(t('archive.title'))}</h2>
      ${
        archived.length
          ? `<ul class="list">${archived
              .map(
                (c) => `<li class="row static"><span class="row-main"><span class="row-name">${esc(c.name)}</span>
                  ${c.note ? `<span class="row-note">${esc(c.note)}</span>` : ''}</span>
                  <button type="button" class="btn small" data-action="unarchive" data-id="${esc(c.id)}">${esc(t('archive.restore'))}</button></li>`
              )
              .join('')}</ul>`
          : `<p class="muted">${esc(t('archive.empty'))}</p>`
      }
      <p class="footer muted">${esc(t('app.name'))} · ${esc(t('settings.privacy'))}</p>
    </main>`;
}

async function submitSettings(form) {
  const shopName = fv(form, 'shopName').value.trim();
  const kaspiPhone = cleanPhone(fv(form, 'kaspiPhone').dataset.digits);
  const days = Number(fv(form, 'overdueDays').value.trim());
  if (kaspiPhone && !/^7\d{10}$/.test(kaspiPhone)) return showFormError(t('error.bad_phone'));
  if (!Number.isInteger(days) || days < 1 || days > 365) return showFormError(t('settings.badDays'));
  try {
    await DB.saveSettings({ shopName, kaspiPhone, overdueDays: days });
    await reload();
    renderSettings();
    toast(t('settings.saved'));
  } catch (err) {
    showFormError(errorText(err));
  }
}

// PIN-код: 4 цифры, хранится только хэш SHA-256 (защита от случайного взгляда, не шифрование).

async function askPin(title) {
  const r = await showDialog({
    title,
    input: { type: 'password', inputmode: 'numeric', maxlength: 4, autocomplete: 'off' },
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.ok'), value: 'ok', kind: 'primary' },
    ],
  });
  return r.value === 'ok' ? r.input.trim() : null;
}

async function verifyCurrentPin() {
  const p = await askPin(t('pin.current'));
  if (p === null) return false;
  if ((await sha256(p)) !== state.settings.pinHash) {
    toast(t('pin.wrong'));
    return false;
  }
  return true;
}

async function setNewPin() {
  const a = await askPin(t('pin.new'));
  if (a === null) return;
  if (!/^\d{4}$/.test(a)) return toast(t('pin.need4'));
  const b = await askPin(t('pin.repeat'));
  if (b === null) return;
  if (a !== b) return toast(t('pin.mismatch'));
  await DB.saveSettings({ pinHash: await sha256(a) });
  state.unlocked = true;
  await reload();
  renderSettings();
  toast(t('pin.saved'));
}

async function pinOff() {
  if (!(await verifyCurrentPin())) return;
  await DB.saveSettings({ pinHash: '' });
  await reload();
  renderSettings();
  toast(t('pin.disabled'));
}

// Экран ввода PIN при запуске

let lockEntry = '';

function keypadHtml(keys, action) {
  return keys
    .map((k) =>
      k === ''
        ? '<span></span>'
        : `<button type="button" class="key" data-action="${action}" data-key="${k}"
            aria-label="${esc(k === '⌫' ? t('keypad.back') : k)}">${k}</button>`
    )
    .join('');
}

function renderLock(wrong = false) {
  app().innerHTML = `
    <main class="lock">
      <h1>${esc(t('app.name'))}</h1>
      <p>${esc(pinAvailable() ? t('lock.enter') : t('pin.unavailable'))}</p>
      <div class="pin-dots">${[0, 1, 2, 3].map((i) => `<span class="pd ${i < lockEntry.length ? 'on' : ''}"></span>`).join('')}</div>
      <p class="error" role="alert" ${wrong ? '' : 'hidden'}>${esc(t('lock.wrong'))}</p>
      <div class="keypad">${keypadHtml(['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'], 'lock-key')}</div>
    </main>`;
}

async function lockKey(k) {
  if (k === '⌫') lockEntry = lockEntry.slice(0, -1);
  else if (lockEntry.length < 4) lockEntry += k;
  renderLock();
  if (lockEntry.length < 4) return;
  const ok = pinAvailable() && (await sha256(lockEntry)) === state.settings.pinHash;
  lockEntry = '';
  if (ok) {
    state.unlocked = true;
    render();
  } else {
    renderLock(true);
  }
}

// Резервная копия

async function backupSave() {
  try {
    const r = await B.exportBackup();
    if (!r.saved) return;
    await reload();
    render();
    toast(t('backup.saved', { file: r.fileName }));
  } catch {
    toast(t('backup.failed'));
  }
}

async function onRestoreFile(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const checked = await B.prepareRestore(file);
  if (!checked.ok) {
    await showDialog({ title: t('restore.badTitle'), text: t('restore.err.' + checked.error), buttons: [{ label: t('common.ok'), value: 'ok', kind: 'primary' }] });
    return;
  }
  const s = checked.summary;
  const lines = [t('restore.preview', { customers: s.customers, transactions: s.transactions, debt: money(s.totalDebt) })];
  if (s.exportedAt) lines.push(t('restore.from', { date: fmtDateTime(s.exportedAt) }));
  lines.push('', t('restore.warning'));
  const ok = await confirmDialog(t('restore.confirmTitle'), lines.join('\n'), t('restore.do'), 'danger');
  if (!ok) return;
  try {
    await B.applyRestore(checked);
    state.unlocked = true; // человек уже прошёл PIN на этом телефоне
    await reload();
    go('#/');
    toast(t('restore.done'));
  } catch {
    toast(t('restore.failed'));
  }
}

// ---------- Установка на главный экран и обновление версии (раздел 7) ----------

let installPrompt = null; // событие Chrome на Android: можно показать системное окно установки

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  local.set('dapter.installHintSeen', '1');
});

async function showInstallHint() {
  local.set('dapter.installHintSeen', '1');
  if (isIOS()) {
    await showDialog({ title: t('install.title'), text: t('install.ios'), buttons: [{ label: t('install.ok'), value: 'ok', kind: 'primary' }] });
    return;
  }
  if (installPrompt) {
    const r = await showDialog({
      title: t('install.title'),
      text: t('install.android'),
      buttons: [
        { label: t('install.later'), value: null },
        { label: t('install.button'), value: 'ok', kind: 'primary' },
      ],
    });
    if (r.value === 'ok' && installPrompt) {
      const p = installPrompt;
      installPrompt = null;
      await p.prompt();
    }
    return;
  }
  await showDialog({ title: t('install.title'), text: t('install.manual'), buttons: [{ label: t('install.ok'), value: 'ok', kind: 'primary' }] });
}

/** Подсказка при первом запуске: только если приложение не установлено и подсказку ещё не показывали. */
function maybeShowInstallHint() {
  if (isStandalone() || local.get('dapter.installHintSeen')) return;
  // Небольшая пауза: Chrome присылает beforeinstallprompt не сразу после загрузки
  setTimeout(() => {
    if (!isStandalone() && !local.get('dapter.installHintSeen') && !dialogOpen && !sheet && !state.settings.pinHash) showInstallHint();
  }, 1500);
}

let reloadingForUpdate = false;

function showUpdateBar(worker) {
  const bar = $('#update-bar');
  bar.innerHTML = '<span class="toast-text"></span>';
  $('.toast-text', bar).textContent = t('update.available');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-btn';
  btn.textContent = t('update.button');
  btn.addEventListener('click', () => {
    reloadingForUpdate = true;
    btn.disabled = true;
    worker.postMessage('skipWaiting');
  });
  bar.appendChild(btn);
  bar.hidden = false;
}

async function registerServiceWorker() {
  // Service worker работает только по https и на localhost
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(w);
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForUpdate) location.reload();
    });
  } catch {
    /* без service worker приложение тоже работает, только не офлайн */
  }
}

// ---------- 4.3 Окно операции (снизу) ----------

let sheet = null;

function openSheet({ type, customerId = null }) {
  sheet = {
    type,
    customerId,
    fixed: Boolean(customerId),
    amount: '',
    method: local.get('dapter.method') === 'kaspi' ? 'kaspi' : 'cash',
    comment: '',
    commentOpen: false,
    query: '',
    isNew: false,
    newName: '',
    newPhone: '',
    newConsent: false,
    error: '',
    saving: false,
  };
  const root = $('#sheet-root');
  root.hidden = false;
  document.body.classList.add('no-scroll');
  renderSheet();
  if (!customerId) $('#sh-q')?.focus();
}

function closeSheet() {
  sheet = null;
  const root = $('#sheet-root');
  root.hidden = true;
  root.innerHTML = '';
  document.body.classList.remove('no-scroll');
}

function balanceShort(b) {
  if (b > 0) return t('sheet.balanceDebt', { sum: money(b) });
  if (b < 0) return t('sheet.balanceOver', { sum: money(-b) });
  return t('card.noDebt');
}

function sheetCustomerHtml() {
  const s = sheet;
  if (s.customerId) {
    const c = customerById(s.customerId);
    return `<div class="sh-chosen">
      <span><b>${esc(c?.name)}</b><span class="muted">${esc(balanceShort(infoOf(s.customerId).balance))}</span></span>
      ${s.fixed ? '' : `<button type="button" class="link-btn" data-action="sh-unpick">${esc(t('sheet.change'))}</button>`}
    </div>`;
  }
  if (s.isNew) {
    return `<div class="sh-new">
      <div class="sh-new-head"><b>${esc(t('sheet.newTitle'))}</b>
        <button type="button" class="link-btn" data-action="sh-unpick">${esc(t('sheet.backToSearch'))}</button></div>
      <input id="sh-new-name" maxlength="60" autocomplete="off" placeholder="${esc(t('field.name'))}" value="${esc(s.newName)}">
      <input id="sh-new-phone" type="tel" inputmode="tel" autocomplete="off" data-phone placeholder="${esc(t('sheet.phoneOptional'))}"
        data-digits="${esc(s.newPhone)}" value="${esc(maskPhone(s.newPhone))}">
      <label class="check"><input id="sh-new-consent" type="checkbox" ${s.newConsent ? 'checked' : ''}>
        <span>${esc(t('field.consent'))}</span></label>
    </div>`;
  }
  return `<input id="sh-q" type="search" autocomplete="off" placeholder="${esc(t('sheet.searchCustomer'))}" value="${esc(s.query)}">
    <ul id="sh-sugg" class="sugg"></ul>`;
}

function renderSheet() {
  const s = sheet;
  const methods = ['cash', 'kaspi'];
  $('#sheet-root').innerHTML = `
    <div class="sheet-backdrop" data-action="sheet-close"></div>
    <div class="sheet ${s.type}" role="dialog" aria-modal="true" aria-label="${esc(t('sheet.title'))}">
      <div class="seg">
        <button type="button" class="seg-btn ${s.type === 'credit' ? 'on credit' : ''}" data-action="sh-type" data-type="credit">${esc(t('sheet.credit'))}</button>
        <button type="button" class="seg-btn ${s.type === 'payment' ? 'on payment' : ''}" data-action="sh-type" data-type="payment">${esc(t('sheet.payment'))}</button>
      </div>
      <div class="sh-customer">${sheetCustomerHtml()}</div>
      <div id="sh-amount" class="sh-amount" aria-live="polite"></div>
      ${
        s.type === 'payment'
          ? `<div class="sh-pay">
              <button type="button" class="btn small" data-action="sh-all">${esc(t('sheet.allDebt'))}</button>
              <div class="seg small">${methods
                .map(
                  (m) => `<button type="button" class="seg-btn ${s.method === m ? 'on' : ''}" data-action="sh-method" data-method="${m}">${esc(t('method.' + m))}</button>`
                )
                .join('')}</div></div>`
          : ''
      }
      ${
        s.commentOpen
          ? `<input id="sh-comment" class="sh-comment" maxlength="140" autocomplete="off" placeholder="${esc(t('sheet.commentHint'))}" value="${esc(s.comment)}">`
          : `<button type="button" class="link-btn" data-action="sh-comment">${esc(t('sheet.addComment'))}</button>`
      }
      <p id="sh-error" class="error" role="alert" ${s.error ? '' : 'hidden'}>${esc(s.error)}</p>
      <div class="keypad">${keypadHtml(['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0', '⌫'], 'sh-key')}</div>
      <div class="sheet-actions">
        <button type="button" class="btn" data-action="sheet-close">${esc(t('common.cancel'))}</button>
        <button type="button" id="sh-save" class="btn big primary" data-action="sh-save">${esc(t('sheet.save'))}</button>
      </div>
    </div>`;
  updateSheetAmount();
  updateSuggestions();
}

function updateSuggestions() {
  const ul = $('#sh-sugg');
  if (!ul || !sheet) return;
  const q = sheet.query.trim();
  const list = state.customers
    .filter((c) => !c.archived && (!q || L.matchesSearch(c, q)))
    .sort((a, b) => (infoOf(b.id).lastAt > infoOf(a.id).lastAt ? 1 : -1))
    .slice(0, 5);
  const isPhone = /^[+\d\s()-]+$/.test(q);
  const newLabel = q && !isPhone ? t('sheet.newNamed', { name: q }) : t('sheet.newCustomer');
  ul.innerHTML =
    list
      .map(
        (c) => `<li><button type="button" class="sugg-btn" data-action="sh-pick" data-id="${esc(c.id)}">
          <span>${esc(c.name)}${c.note ? ` <span class="muted">${esc(c.note)}</span>` : ''}</span>
          <span class="muted">${esc(balanceShort(infoOf(c.id).balance))}</span></button></li>`
      )
      .join('') + `<li><button type="button" class="sugg-btn new" data-action="sh-new">${esc(newLabel)}</button></li>`;
}

function updateSheetAmount() {
  const el = $('#sh-amount');
  if (!el || !sheet) return;
  const n = sheet.amount === '' ? 0 : Number(sheet.amount);
  el.textContent = money(n);
  el.classList.toggle('placeholder', sheet.amount === '');
  const hasCustomer = Boolean(sheet.customerId) || (sheet.isNew && sheet.newName.trim() !== '');
  $('#sh-save').disabled = !(n > 0 && hasCustomer) || sheet.saving;
}

function sheetError(text) {
  if (!sheet) return;
  sheet.error = text;
  const el = $('#sh-error');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function sheetKey(k) {
  let a = sheet.amount;
  if (k === '⌫') a = a.slice(0, -1);
  else if (k === '000') a = a === '' ? '' : a + '000';
  else a = a + k;
  a = a.replace(/^0+/, '');
  if (a.length > 8) return;
  sheet.amount = a;
  sheetError('');
  updateSheetAmount();
}

async function sheetSave() {
  const s = sheet;
  if (!s || s.saving) return;
  const check = L.validateAmount(s.amount);
  if (!check.ok) return sheetError(t('amount.' + check.error));
  const amount = check.value;

  let customer = s.customerId ? customerById(s.customerId) : null;
  const newData = { name: s.newName, phone: cleanPhone(s.newPhone), consent: s.newConsent };
  if (!customer && !s.isNew) return sheetError(t('sheet.pickCustomer'));
  if (s.isNew) {
    try {
      DB.cleanCustomer(newData);
    } catch (err) {
      return sheetError(errorText(err));
    }
  }

  // Предупреждения — не запрет: решает продавец
  const balance = customer ? infoOf(customer.id).balance : 0;
  if (s.type === 'credit') {
    const lim = L.checkLimit(balance, amount, customer?.creditLimit ?? null);
    if (lim.exceeds) {
      const ok = await confirmDialog(
        t('warn.limitTitle'),
        t('warn.limitText', { limit: money(customer.creditLimit), over: money(lim.over) }),
        t('warn.limitOk'),
        'danger'
      );
      if (!ok) return;
    }
  } else {
    const ov = L.checkOverpayment(balance, amount);
    if (ov.overpay) {
      const ok = await confirmDialog(t('warn.overTitle'), t('warn.overText', { extra: money(ov.extra) }), t('warn.overOk'), 'primary');
      if (!ok) return;
    }
  }

  s.saving = true;
  updateSheetAmount();
  try {
    if (s.isNew) customer = await DB.saveCustomer(newData);
    const comment = s.commentOpen ? ($('#sh-comment')?.value ?? s.comment) : '';
    const tx = await DB.addTransaction({
      customerId: customer.id,
      type: s.type,
      amount,
      method: s.type === 'payment' ? s.method : undefined,
      comment,
    });
    if (s.type === 'payment') local.set('dapter.method', s.method);
    closeSheet();
    await reload();
    render();
    const sum = (s.type === 'credit' ? '+' : '−') + money(amount);
    toast(t('toast.saved', { name: customer.name, sum, balance: balanceShort(infoOf(customer.id).balance) }), {
      label: t('toast.undo'),
      duration: 5000,
      run: () => undoTransaction(tx.id),
    });
  } catch (err) {
    if (!sheet) return toast(errorText(err));
    s.saving = false;
    updateSheetAmount();
    sheetError(errorText(err));
  }
}

async function undoTransaction(id) {
  try {
    await DB.voidTransaction(id, t('void.quickReason'));
    await reload();
    render();
    toast(t('toast.undone'));
  } catch (err) {
    toast(errorText(err));
  }
}

async function voidFromHistory(id) {
  const r = await showDialog({
    title: t('void.title'),
    text: t('void.text'),
    input: { type: 'text', maxlength: 100, placeholder: t('void.reasonHint'), autocomplete: 'off' },
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('void.confirm'), value: 'ok', kind: 'danger' },
    ],
  });
  if (r.value !== 'ok') return;
  const reason = (r.input ?? '').trim();
  if (!reason) return toast(t('error.reason_required'));
  try {
    await DB.voidTransaction(id, reason);
    await reload();
    render();
    toast(t('void.done'));
  } catch (err) {
    toast(errorText(err));
  }
}

// ---------- Диалог и уведомление ----------

let dialogOpen = false;

function showDialog({ title, text = '', input = null, buttons }) {
  return new Promise((resolve) => {
    const root = $('#dialog-root');
    const attrs = input
      ? Object.entries(input)
          .map(([k, v]) => `${k}="${esc(v)}"`)
          .join(' ')
      : '';
    root.innerHTML = `
      <div class="dialog-backdrop"></div>
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
        <h2 id="dlg-title">${esc(title)}</h2>
        ${text ? `<p class="dlg-text">${esc(text)}</p>` : ''}
        ${input ? `<input id="dlg-input" class="dlg-input" ${attrs}>` : ''}
        <div class="dlg-buttons">${buttons
          .map((b, i) => `<button type="button" class="btn ${b.kind ?? ''}" data-i="${i}">${esc(b.label)}</button>`)
          .join('')}</div>
      </div>`;
    root.hidden = false;
    dialogOpen = true;
    const field = $('#dlg-input', root);

    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    function close(i) {
      const value = field ? field.value : undefined;
      document.removeEventListener('keydown', onKey);
      root.hidden = true;
      root.innerHTML = '';
      dialogOpen = false;
      resolve({ value: i === null ? null : buttons[i].value, input: value });
    }
    document.addEventListener('keydown', onKey);
    root.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => close(Number(b.dataset.i))));
    $('.dialog-backdrop', root).addEventListener('click', () => close(null));
    if (field) {
      field.focus();
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          close(buttons.length - 1);
        }
      });
    } else {
      $('.dlg-buttons .btn:last-child', root).focus();
    }
  });
}

async function confirmDialog(title, text, okLabel, kind = 'primary') {
  const r = await showDialog({
    title,
    text,
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: okLabel, value: 'ok', kind },
    ],
  });
  return r.value === 'ok';
}

let toastTimer = null;

function toast(text, action = null) {
  const el = $('#toast');
  el.innerHTML = '<span class="toast-text"></span>';
  $('.toast-text', el).textContent = text;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      hideToast();
      action.run();
    });
    el.appendChild(btn);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action?.duration ?? 3000);
}

function hideToast() {
  const el = $('#toast');
  el.hidden = true;
  el.innerHTML = '';
}

// ---------- События ----------

const actions = {
  tab: (el) => {
    state.tab = el.dataset.tab;
    renderMain();
  },
  'new-credit': () => openSheet({ type: 'credit' }),
  op: (el) => openSheet({ type: el.dataset.type, customerId: el.dataset.id }),
  void: (el) => voidFromHistory(el.dataset.id),
  archive: (el) => archive(el.dataset.id),
  unarchive: (el) => unarchive(el.dataset.id),

  'sheet-close': () => closeSheet(),
  'sh-type': (el) => {
    sheet.type = el.dataset.type;
    sheet.error = '';
    renderSheet();
  },
  'sh-method': (el) => {
    sheet.method = el.dataset.method;
    renderSheet();
  },
  'sh-all': () => {
    const b = sheet.customerId ? infoOf(sheet.customerId).balance : 0;
    if (b > 0) {
      sheet.amount = String(b);
      sheetError('');
      updateSheetAmount();
    }
  },
  'sh-comment': () => {
    sheet.commentOpen = true;
    renderSheet();
    $('#sh-comment')?.focus();
  },
  'sh-pick': (el) => {
    sheet.customerId = el.dataset.id;
    sheet.error = '';
    renderSheet();
  },
  'sh-unpick': () => {
    sheet.customerId = null;
    sheet.isNew = false;
    renderSheet();
    $('#sh-q')?.focus();
  },
  'sh-new': () => {
    const q = sheet.query.trim();
    if (/^[+\d\s()-]+$/.test(q)) {
      sheet.newPhone = phoneDigits(q);
      sheet.newName = '';
    } else {
      sheet.newName = q;
    }
    sheet.isNew = true;
    sheet.error = '';
    renderSheet();
    if (!sheet.newName) $('#sh-new-name')?.focus();
  },
  'sh-key': (el) => sheetKey(el.dataset.key),
  'sh-save': () => sheetSave(),

  'lock-key': (el) => lockKey(el.dataset.key),
  'pin-on': () => setNewPin(),
  'pin-change': async () => {
    if (await verifyCurrentPin()) await setNewPin();
  },
  'pin-off': () => pinOff(),
  'backup-save': () => backupSave(),
  'backup-restore': () => $('#restore-file')?.click(),
  'install-help': () => showInstallHint(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el, e);
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.matches('[data-phone]')) onPhoneInput(el, e);
  if (el.id === 'search') {
    state.query = el.value;
    updateList();
  }
  if (sheet) {
    if (el.id === 'sh-q') {
      sheet.query = el.value;
      updateSuggestions();
    } else if (el.id === 'sh-new-name') {
      sheet.newName = el.value;
      updateSheetAmount();
    } else if (el.id === 'sh-new-phone') {
      sheet.newPhone = el.dataset.digits;
    } else if (el.id === 'sh-comment') {
      sheet.comment = el.value;
    }
  }
  if (el.closest('#cform')) checkDuplicate();
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'sort') {
    state.sort = el.value;
    updateList();
  } else if (el.id === 'sh-new-consent' && sheet) {
    sheet.newConsent = el.checked;
  } else if (el.id === 'restore-file') {
    onRestoreFile(el);
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'cform') {
    e.preventDefault();
    submitCustomer(e.target);
  } else if (e.target.id === 'sform') {
    e.preventDefault();
    submitSettings(e.target);
  }
});

// Поле телефона: при фокусе сразу «+7 (», чтобы вводить только остальные цифры
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (el.matches?.('[data-phone]') && !el.value) {
    el.dataset.digits = '7';
    el.value = maskPhone('7');
  }
});
document.addEventListener('focusout', (e) => {
  const el = e.target;
  if (el.matches?.('[data-phone]') && (el.dataset.digits || '').length <= 1) {
    el.dataset.digits = '';
    el.value = '';
    if (el.id === 'sh-new-phone' && sheet) sheet.newPhone = '';
  }
});

// Клавиатура компьютера в окне операции: цифры, Backspace, Enter, Esc
document.addEventListener('keydown', (e) => {
  if (!sheet || dialogOpen) return;
  if (e.key === 'Escape') return closeSheet();
  if (e.target.closest?.('input, textarea, select')) return;
  if (/^\d$/.test(e.key)) sheetKey(e.key);
  else if (e.key === 'Backspace') sheetKey('⌫');
  else if (e.key === 'Enter') sheetSave();
  else return;
  e.preventDefault();
});

window.addEventListener('hashchange', () => {
  if (sheet) closeSheet();
  render();
  window.scrollTo(0, 0);
});

// ---------- Запуск ----------

async function init() {
  await loadTexts('ru');
  try {
    await reload();
  } catch {
    app().innerHTML = `<p class="fatal">${esc(t('error.storage'))}</p>`;
    return;
  }
  if (state.settings.uiLang !== 'ru') await loadTexts(state.settings.uiLang);
  document.title = t('app.name');
  DB.requestPersistence();
  render();
  registerServiceWorker();
  maybeShowInstallHint();
}

init();
