import { $, $$, esc, api, state, toast, modal, confirmBox, money, money0, toInput, fromInput, LS, on, emit, clientId, itemOptions, accountOptions, itemById, loadLayout, bar, go, monthName, fmtDate, weekday, curMonth, clampMonth, isPhone, B, debounce } from './core.js';
import { budgetView, yearView } from './budgetview.js';
import { calendarView } from './calendar.js';
import { debtsView } from './debts.js';
import { billsView, payBill } from './bills.js';
import { reportsView } from './reports.js';
import { inboxView, subsView, bankSettings, inboxCard, insightsCard, netWorthChart } from './inbox.js';

const NAV = [
  ['home', '🏠', 'Home'], ['budget', '📊', 'Budget'], ['year', '🗓️', 'Year plan'], ['inbox', '📥', 'New transactions'], ['txns', '🧾', 'Transactions'], ['calendar', '📅', 'Calendar'],
  ['bills', '🔁', 'Bills & income'], ['subs', '🔔', 'Subscriptions'], ['debts', '⛓️', 'Debt snowball'], ['reports', '📈', 'Reports'], ['accounts', '🏦', 'Accounts'], ['settings', '⚙️', 'Settings'],
];
let current = null, cleanup = null, gen = 0;

// ------------------------------------------------------------------ theme
const applyTheme = () => {
  const t = LS.get('ledger.theme', 'auto');
  document.documentElement.dataset.theme = t === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
};
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ------------------------------------------------------------------ auth
async function showAuth() {
  const { setup } = await fetch('/api/status').then((r) => r.json());
  document.body.className = 'auth';
  document.body.innerHTML = `<div class="authbox"><div class="logo big">$</div><h1>Ledger</h1>
    <p class="muted">${setup ? 'Create your household budget. Your partner can be added from Settings.' : 'Sign in to your household budget.'}</p>
    <form>${setup ? '<input name="name" placeholder="Your name" required autocomplete="name"><input name="household" placeholder="Budget name (e.g. The Howell budget)">' : ''}
      <input name="email" type="email" placeholder="Email" required autocomplete="username">
      <input name="password" type="password" placeholder="Password${setup ? ' (8+ characters)' : ''}" required minlength="${setup ? 8 : 1}" autocomplete="${setup ? 'new-password' : 'current-password'}">
      <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code from your authenticator app" hidden>
      ${setup ? '<label class="check"><input type="checkbox" name="blank"> Start with a blank budget (no starter categories)</label>' : ''}
      <button class="btn primary big">${setup ? 'Create budget' : 'Sign in'}</button><p class="err"></p></form></div>`;
  const f = $('form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f)); body.blank = !!body.blank;
    try {
      const r = await api('POST', setup ? '/api/setup' : '/api/login', body);
      if (r.totp) { f.code.hidden = false; f.code.required = true; f.code.focus(); $('.err').textContent = 'Enter the code from your authenticator app.'; return; }
      location.reload();
    } catch (err) { $('.err').textContent = err.message; }
  };
}
on('signedout', () => showAuth());

// ------------------------------------------------------------------ shell
function shell() {
  document.body.className = '';
  document.body.innerHTML = `<div id="app">
    <aside id="side"><div class="brand"><span class="logo">$</span><span>${esc(state.settings.household)}</span></div>
      <button class="btn primary addbtn" id="sideAdd">＋ Add transaction</button>
      <nav id="nav">${NAV.map(([k, ic, l]) => `<a href="#/${k}" data-k="${k}"><span class="ic">${ic}</span>${l}<span class="cnt" data-cnt="${k}"></span></a>`).join('')}</nav>
      <div class="sp"></div>
      <div class="me"><span class="dot" style="background:${esc(state.me.color)}"></span>${esc(state.me.name)}<span class="sp"></span><span class="net ${state.online ? '' : 'offline'}" title="Connection"></span></div>
    </aside>
    <main id="main"></main>
    <nav id="tabs">
      <a href="#/home" data-k="home"><span>🏠</span>Home</a><a href="#/budget" data-k="budget"><span>📊</span>Budget</a>
      <button id="fab" aria-label="Add transaction">＋</button>
      <a href="#/calendar" data-k="calendar"><span>📅</span>Calendar</a><a href="#/more" data-k="more"><span>☰</span>More<i class="tbadge" data-cnt="inbox"></i></a>
    </nav>
    <div id="toasts"></div></div>`;
  $('#sideAdd').onclick = () => quickAdd();
  $('#fab').onclick = () => quickAdd();
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || $('.overlay')) return;
    if (e.key === 'n' || e.key === 'a') { e.preventDefault(); quickAdd(); }
    const map = { b: 'budget', h: 'home', t: 'txns', c: 'calendar', d: 'debts', y: 'year', r: 'reports' };
    if (map[e.key]) go('/' + map[e.key]);
  });
}

async function route() {
  const [, view = 'home', ...rest] = location.hash.slice(1).split('/');
  if (view === 'add') { history.replaceState(null, '', '#/home'); route(); quickAdd(); return; }
  cleanup?.(); cleanup = null;
  current = view;
  const my = ++gen;
  $$('#nav a, #tabs a').forEach((a) => a.classList.toggle('active', a.dataset.k === view || (a.dataset.k === 'more' && !['home', 'budget', 'calendar'].includes(view))));
  const main = $('#main');
  main.scrollTop = 0; window.scrollTo(0, 0);
  const views = { home, budget: budgetView, year: yearView, txns: txnsView, calendar: calendarView, bills: billsView, debts: debtsView, reports: reportsView, accounts: accountsView, settings: settingsView, more: moreView, inbox: inboxView, subs: subsView };
  try { cleanup = (await (views[view] || home)(main, rest)) || null; }
  catch (e) { if (my !== gen) return; if (e.message !== 'Signed out') { console.error(e); main.innerHTML = `<div class="page"><p class="err">Couldn't load: ${esc(e.message)}</p></div>`; } }
  updateBadges();
}
const refresh = debounce(async () => { await loadLayout().catch(() => {}); emit('refresh'); }, 300);
on('refresh', () => { if (!$('.overlay') || current === 'home') route(); updateBadges(); });

async function updateBadges() {
  try {
    const { count } = await api('GET', '/api/inbox/count');
    $$('[data-cnt="inbox"]').forEach((e) => (e.textContent = count ? count : ''));
  } catch {}
}

function moreView(main) {
  main.innerHTML = `<div class="page"><h1>More</h1><div class="morelist">${NAV.filter(([k]) => !['home', 'budget', 'calendar'].includes(k)).map(([k, ic, l]) => `<a href="#/${k}"><span class="ic">${ic}</span>${l}<span class="sp"></span>›</a>`).join('')}</div>
    <p class="muted small center">Tip: add Ledger to your Home Screen for one-tap logging. Long-press the icon for “Add transaction”.</p></div>`;
}

// ------------------------------------------------------------------ home dashboard
async function home(main) {
  const m = clampMonth(curMonth());
  const [v, up, cf, debts, recent, tray, ins] = await Promise.all([api('GET', `/api/budget/${m}`), api('GET', '/api/upcoming?days=14'), api('GET', '/api/cashflow'), api('GET', '/api/debts'), api('GET', '/api/txns?limit=8'), inboxCard(), insightsCard()]);
  const s = v.summary, t = state.today;
  const dayOfMonth = +t.slice(8), dim = B.daysIn(+m.slice(0, 4), +m.slice(5));
  const pace = m === curMonth() ? dayOfMonth / dim : 1;
  const items = v.groups.filter((g) => g.kind !== 'income').flatMap((g) => g.items.map((i) => ({ ...i, color: g.color })));
  const watch = items.filter((i) => i.available < 0 || (i.available > 0 && i.planned + i.carry > 0 && i.available / (i.planned + i.carry) < 0.15)).sort((a, b) => a.available - b.available).slice(0, 8);
  const cash = state.accounts.filter((a) => a.kind !== 'credit').reduce((x, a) => x + a.balance, 0);
  const ltb = s.leftToBudget;
  main.innerHTML = `<div class="page home">
    <header class="phead"><div><h1>${greeting()}, ${esc(state.me.name.split(' ')[0])}</h1><p class="muted">${fmtDate(t, { weekday: 'long', month: 'long', day: 'numeric' })} · ${monthName(m)}</p></div></header>
    ${tray.html}
    ${state.today < state.settings.start_month + '-01' ? `<div class="callout">Your budget starts in <b>${monthName(state.settings.start_month)}</b>. Showing that month.</div>` : ''}
    <div class="tiles">
      <a class="tile ${ltb === 0 ? 'good' : ltb < 0 ? 'badt' : 'warnt'}" href="#/budget/${m}"><span class="lbl">Left to budget</span><b>${money(ltb)}</b><span class="sub">${ltb === 0 ? '✓ Every dollar has a job' : ltb > 0 ? 'Give these dollars a job' : 'You budgeted more than you make'}</span></a>
      <a class="tile" href="#/budget/${m}"><span class="lbl">Spent this month</span><b>${money0(s.spent)}</b><span class="sub">of ${money0(s.planned)} planned</span>${bar(s.planned ? s.spent / s.planned * 100 : 0, s.spent > s.planned ? 'over' : '')}${pace < 1 ? `<span class="pace" style="left:calc(16px + (100% - 32px) * ${pace})" title="Today"></span>` : ''}</a>
      <a class="tile" href="#/calendar"><span class="lbl">Cash on hand</span><b>${money0(cash)}</b><span class="sub ${cf.low && cf.low.balance < 0 ? 'neg' : ''}">${cf.low ? `Lowest ahead: ${money0(cf.low.balance)} on ${fmtDate(cf.low.date)}` : ''}</span></a>
      <a class="tile" href="#/debts"><span class="lbl">Debt remaining</span><b>${money0(debts.total)}</b><span class="sub">${debts.order.length ? (debts.plan.debtFree ? `Debt-free ${monthName(debts.plan.debtFree, 'short')}` : 'Add to the snowball') : debts.debts.length ? '🎉 Debt-free!' : 'No debts added'}</span>${debts.original ? bar(debts.paidTotal / debts.original * 100, 'good') : ''}</a>
    </div>
    <div class="cols">
      <section class="card"><h2>Coming up <a class="more" href="#/calendar">Calendar ›</a></h2>
        ${up.length ? `<ul class="list">${up.slice(0, 10).map((b) => upRow(b)).join('')}</ul>` : '<p class="muted">No bills or paydays in the next two weeks. <a href="#/bills">Add your bills</a> to see them here and on the calendar.</p>'}</section>
      <section class="card"><h2>Envelopes to watch <a class="more" href="#/budget/${m}">Budget ›</a></h2>
        ${watch.length ? `<ul class="list">${watch.map((i) => `<li><span class="ic">${esc(i.emoji || '•')}</span><span class="grow">${esc(i.name)}${bar(i.planned + i.carry > 0 ? i.spent / (i.planned + i.carry) * 100 : 100, i.available < 0 ? 'over' : 'low')}</span><b class="${i.available < 0 ? 'neg' : 'warn'}">${money(i.available)}</b></li>`).join('')}</ul>` : '<p class="muted">Nothing is low or overspent. 👍</p>'}</section>
    </div>
    ${ins}
    <section class="card"><h2>Recent <a class="more" href="#/txns">All transactions ›</a></h2>${recent.length ? `<ul class="list txlist">${recent.map(txRow).join('')}</ul>` : '<p class="muted">No transactions yet. Tap <b>＋</b> to log one – it takes 3 seconds.</p>'}</section>
  </div>`;
  bindTxRows(main);
  bindUpRows(main);
  if ($('.intray', main)) tray.bind($('.intray', main));
}
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
export const upRow = (b) => `<li class="up ${b.status.replace(' ', '')}" data-type="${b.type}" data-id="${b.id}" data-date="${b.date}"><span class="date"><b>${fmtDate(b.date, { day: 'numeric' })}</b>${weekday(b.date)}</span>
  <span class="grow">${b.kind === 'income' ? '💵' : b.type === 'debt' ? '⛓️' : b.kind === 'transfer' ? '🔁' : '🧾'} ${esc(b.name)}<span class="muted small"> · ${esc(b.status)}${b.autopay ? ' · autopay' : ''}</span></span>
  <b class="${b.kind === 'income' ? 'pos' : ''}">${b.kind === 'income' ? '+' : ''}${money(b.amount)}</b>${b.status !== 'paid' && b.status !== 'skipped' ? `<button class="btn sm pay">${b.kind === 'income' ? 'Received' : 'Paid'}</button>` : '<span class="paid">✓</span>'}</li>`;
export function bindUpRows(root) {
  $$('.up .pay', root).forEach((btn) => (btn.onclick = async (e) => {
    e.stopPropagation();
    const li = btn.closest('li');
    if (li.dataset.type === 'debt') { const { payDebt } = await import('./debts.js'); return payDebt(+li.dataset.id); }
    payBill(+li.dataset.id, li.dataset.date);
  }));
}

// ------------------------------------------------------------------ transactions
export const txRow = (t) => {
  const cat = t.kind === 'transfer' ? `🔁 ${esc(t.account_name || '')} → ${esc(t.to_account_name || '')}` : t.lines.map((l) => l.item_id ? esc(`${l.emoji ? l.emoji + ' ' : ''}${l.item_name}`) : '<span class="tag warn">Needs category</span>').join(', ');
  return `<li class="tx" data-id="${t.id}"><span class="grow"><b>${esc(t.payee || (t.kind === 'transfer' ? 'Transfer' : '(no payee)'))}</b>${t.recurring_id ? ' <span class="tag">bill</span>' : ''}${t.note ? ` <span class="muted small">· ${esc(t.note)}</span>` : ''}<br><span class="muted small">${cat}${t.account_name && t.kind !== 'transfer' ? ` · ${esc(t.account_name)}` : ''}${state.users.length > 1 && t.user_name ? ` · ${esc(t.user_name)}` : ''}</span></span>
    <span class="amt"><b class="${t.kind === 'income' ? 'pos' : ''}">${t.kind === 'income' ? '+' : t.kind === 'transfer' ? '' : '−'}${money(t.amount)}</b><span class="muted small">${fmtDate(t.date)}</span></span></li>`;
};
export const bindTxRows = (root) => $$('li.tx', root).forEach((li) => (li.onclick = async (e) => { if (e.target.closest('input,select,button')) return; txnEditor(await api('GET', `/api/txns/${li.dataset.id}`)); }));

async function txnsView(main) {
  const f = LS.get('ledger.txfilter', {});
  const s = state.settings;
  main.innerHTML = `<div class="page"><header class="phead"><h1>Transactions</h1><span class="sp"></span>
      <button class="btn" id="imp">⬆ Import CSV</button><a class="btn" href="/api/export/csv" download>⬇ Export</a><button class="btn primary" id="add">＋ Add</button></header>
    <div class="filters">
      <input type="search" id="q" placeholder="Search payee, note, amount…" value="${esc(f.q || '')}">
      <select id="fm"><option value="">All dates</option>${B.monthsBetween(B.addMonths(s.start_month, -2), s.end_month).reverse().map((m) => `<option value="${m}" ${f.m === m ? 'selected' : ''}>${monthName(m)}</option>`).join('')}</select>
      <select id="fi">${itemOptions(f.i, { none: 'All categories' })}</select>
      <select id="fa"><option value="">All accounts</option>${accountOptions(f.a)}</select>
      ${state.users.length > 1 ? `<select id="fu"><option value="">Everyone</option>${state.users.map((u) => `<option value="${u.id}" ${+f.u === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}
      <label class="check"><input type="checkbox" id="fn" ${f.n ? 'checked' : ''}> Needs category</label>
    </div>
    <div id="bulk" class="bulk" hidden><span id="bn"></span><select id="bcat">${itemOptions('', { none: 'Categorize as…' })}</select><button class="btn sm" id="bclr">Mark cleared</button><button class="btn sm danger" id="bdel">Delete</button></div>
    <div id="list"></div></div>`;
  const load = async () => {
    const st = { q: $('#q').value, m: $('#fm').value, i: $('#fi').value, a: $('#fa').value, u: $('#fu')?.value || '', n: $('#fn').checked };
    LS.set('ledger.txfilter', st);
    const p = new URLSearchParams();
    if (st.q) p.set('search', st.q); if (st.m) { p.set('from', `${st.m}-01`); p.set('to', B.lastDay(st.m)); }
    if (st.i) p.set('item', st.i); if (st.a) p.set('account', st.a); if (st.u) p.set('user', st.u); if (st.n) p.set('uncategorized', '1');
    const rows = await api('GET', `/api/txns?${p}`);
    const byDate = new Map(); for (const t of rows) (byDate.get(t.date) || byDate.set(t.date, []).get(t.date)).push(t);
    const out = rows.filter((t) => t.kind === 'expense').reduce((a, t) => a + t.amount, 0), inc = rows.filter((t) => t.kind === 'income').reduce((a, t) => a + t.amount, 0);
    $('#list').innerHTML = rows.length ? `<p class="muted small">${rows.length} transaction${rows.length > 1 ? 's' : ''} · out ${money(out)} · in ${money(inc)}</p>` + [...byDate].map(([d, ts]) => `<h4 class="dhead">${fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}</h4><ul class="list txlist sel">${ts.map((t) => txRow(t).replace('<li class="tx"', `<li class="tx"`).replace('<span class="grow">', `<input type="checkbox" class="pick" value="${t.id}"><span class="grow">`)).join('')}</ul>`).join('')
      : '<div class="empty"><p>No transactions match.</p></div>';
    bindTxRows($('#list'));
    const sync = () => { const n = $$('.pick:checked').length; $('#bulk').hidden = !n; $('#bn').textContent = `${n} selected`; };
    $$('.pick').forEach((c) => (c.onchange = sync));
  };
  for (const id of ['q', 'fm', 'fi', 'fa', 'fu', 'fn']) { const el = $('#' + id); if (el) el.addEventListener(id === 'q' ? 'input' : 'change', debounce(load, id === 'q' ? 250 : 0)); }
  const picked = () => $$('.pick:checked').map((c) => +c.value);
  $('#bcat').onchange = async () => { await api('POST', '/api/txns/bulk', { ids: picked(), action: 'categorize', item_id: +$('#bcat').value || null }); toast('Updated'); load(); };
  $('#bclr').onclick = async () => { await api('POST', '/api/txns/bulk', { ids: picked(), action: 'clear', cleared: true }); toast('Marked cleared'); load(); };
  $('#bdel').onclick = async () => { const ids = picked(); if (await confirmBox('Delete transactions', `Delete ${ids.length} transaction(s)? This can't be undone.`, 'Delete', true)) { await api('POST', '/api/txns/bulk', { ids, action: 'delete' }); load(); } };
  $('#add').onclick = () => txnEditor();
  $('#imp').onclick = importCsv;
  await load();
}

// Full editor: kind, amount, payee, category or split, date, account, note, cleared.
export async function txnEditor(t = null, defaults = {}) {
  const payees = await api('GET', '/api/payees').catch(() => []);
  const d = t || { kind: 'expense', date: state.today, amount: 0, payee: '', note: '', account_id: state.accounts.find((a) => a.kind === 'checking')?.id ?? state.accounts[0]?.id, lines: [], cleared: 0, ...defaults };
  let kind = d.kind === 'income' && d.lines?.some((l) => itemById(l.item_id)?.kind === 'expense') ? 'refund' : d.kind;
  let lines = d.lines?.length ? d.lines.map((l) => ({ item_id: l.item_id, amount: l.amount })) : [{ item_id: defaults.item_id ?? null, amount: d.amount }];
  modal(t ? 'Edit transaction' : 'Add transaction', `<form class="txform">
    <div class="seg full" id="kind">${[['expense', 'Expense'], ['income', 'Income'], ['refund', 'Refund'], ['transfer', 'Transfer']].map(([k, l]) => `<button type="button" data-k="${k}">${l}</button>`).join('')}</div>
    <label class="amount"><span>$</span><input name="amount" inputmode="decimal" placeholder="0.00" value="${toInput(d.amount)}" autofocus required></label>
    <div class="grid2">
      <label class="nottr">Payee<input name="payee" list="payees" value="${esc(d.payee)}" placeholder="Where / who" autocomplete="off"></label>
      <label>Date<input name="date" type="date" value="${d.date}" required></label>
      <label>${'Account'}<select name="account_id">${accountOptions(d.account_id, { blank: true })}</select></label>
      <label class="tr">To account<select name="to_account_id">${accountOptions(d.to_account_id, { blank: true })}</select></label>
    </div>
    <div class="nottr" id="cats"></div>
    <label>Note<input name="note" value="${esc(d.note)}" placeholder="Optional"></label>
    <label class="check"><input type="checkbox" name="cleared" ${d.cleared ? 'checked' : ''}> Cleared (shows on the bank statement)</label>
    ${t ? `<p class="muted small">Entered ${t.user_name ? `by ${esc(t.user_name)} ` : ''}via ${esc(t.source)}${t.recurring_name ? ` · paid bill <b>${esc(t.recurring_name)}</b> (${t.occ_date})` : ''}</p>` : ''}
    <div class="row end">${t ? '<button type="button" class="btn danger" id="del">Delete</button><span class="sp"></span><button type="button" class="btn" id="dup">Duplicate</button>' : ''}<button class="btn primary">Save</button></div>
    <datalist id="payees">${payees.map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist></form>`, (m, close) => {
    const f = $('form', m);
    const setKind = (k) => {
      kind = k;
      $$('#kind button', m).forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      f.classList.toggle('transfer', k === 'transfer');
      renderCats();
    };
    const renderCats = () => {
      const amt = fromInput(f.amount.value);
      const opts = (sel) => itemOptions(sel, { income: kind === 'income', expense: kind !== 'income' || true });
      if (lines.length <= 1) {
        $('#cats', m).innerHTML = `<label>Category<select name="item">${opts(lines[0]?.item_id)}</select></label><button type="button" class="linkbtn" id="split">Split across categories</button>`;
        $('[name=item]', m).onchange = (e) => { lines = [{ item_id: +e.target.value || null, amount: amt }]; };
        $('#split', m).onclick = () => { lines = [{ item_id: +$('[name=item]', m).value || null, amount: amt }, { item_id: null, amount: 0 }]; renderCats(); };
      } else {
        const sum = lines.reduce((a, l) => a + l.amount, 0);
        $('#cats', m).innerHTML = `<div class="splits">${lines.map((l, i) => `<div class="srow" data-i="${i}"><select>${opts(l.item_id)}</select><input inputmode="decimal" value="${toInput(l.amount)}" placeholder="0.00"><button type="button" class="iconbtn rm">✕</button></div>`).join('')}
          <div class="row"><button type="button" class="linkbtn" id="addl">＋ Add line</button><span class="sp"></span><span class="${sum === amt ? 'muted' : 'neg'} small">${sum === amt ? 'Split adds up ✓' : `${money(amt - sum)} left to assign`}</span></div></div>`;
        $$('.srow', m).forEach((r) => {
          const i = +r.dataset.i;
          $('select', r).onchange = (e) => { lines[i].item_id = +e.target.value || null; };
          $('input', r).onchange = (e) => { lines[i].amount = fromInput(e.target.value); renderCats(); };
          $('.rm', r).onclick = () => { lines.splice(i, 1); if (lines.length === 1) lines[0].amount = amt; renderCats(); };
        });
        $('#addl', m).onclick = () => { lines.push({ item_id: null, amount: Math.max(0, amt - sum) }); renderCats(); };
      }
    };
    $$('#kind button', m).forEach((b) => (b.onclick = () => setKind(b.dataset.k)));
    f.amount.oninput = () => { if (lines.length === 1) lines[0].amount = fromInput(f.amount.value); };
    f.amount.onchange = () => renderCats();
    f.payee.onchange = () => {
      const p = payees.find((x) => x.name.toLowerCase() === f.payee.value.toLowerCase().trim());
      if (p?.item_id && lines.length === 1 && !lines[0].item_id && kind === 'expense') { lines[0].item_id = p.item_id; renderCats(); }
    };
    setKind(kind);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const amount = fromInput(f.amount.value);
      if (!(amount > 0)) return toast('Enter an amount', 'err');
      if (lines.length === 1) lines[0].amount = amount;
      const body = { kind: kind === 'refund' ? 'income' : kind, amount, payee: f.payee.value, date: f.date.value, account_id: +f.account_id.value || null, to_account_id: +f.to_account_id.value || null, note: f.note.value, cleared: f.cleared.checked, lines };
      try {
        const r = await api(t ? 'PUT' : 'POST', t ? `/api/txns/${t.id}` : '/api/txns', body);
        close(); toast(t ? 'Saved' : `Added ${money(r.amount)}${r.lines[0]?.item_name ? ` → ${r.lines[0].item_name}` : ''}`);
        refresh();
      } catch (err) { toast(err.message, 'err'); }
    };
    if (t) {
      $('#del', m).onclick = async () => {
        const r = await api('DELETE', `/api/txns/${t.id}`); close(); refresh();
        toast(`Deleted ${money(r.amount)} ${r.payee}`, '', { label: 'Undo', run: async () => { await api('POST', '/api/txns', { ...r, lines: r.lines.map((l) => ({ item_id: l.item_id, amount: l.amount })), autolink: false }); refresh(); } });
      };
      $('#dup', m).onclick = () => { close(); txnEditor(null, { ...t, id: undefined, date: state.today, recurring_id: null, occ_date: null }); };
    }
  });
}

// ------------------------------------------------------------------ quick add (phone-first)
const QUEUE = 'ledger.queue';
async function flushQueue() {
  const q = LS.get(QUEUE, []);
  if (!q.length || !navigator.onLine) return;
  const left = [];
  for (const body of q) { try { await api('POST', '/api/txns', body); } catch (e) { if (!e.status || e.status >= 500) left.push(body); } }
  LS.set(QUEUE, left);
  if (q.length > left.length) { toast(`Synced ${q.length - left.length} offline entr${q.length - left.length > 1 ? 'ies' : 'y'}`); refresh(); }
}
export async function quickAdd(prefill = {}) {
  const m = clampMonth(curMonth());
  let view = null, payees = [];
  try { [view, payees] = await Promise.all([api('GET', `/api/budget/${m}`), api('GET', '/api/payees')]); } catch {}
  const usage = LS.get('ledger.usage', {});
  const allItems = view ? view.groups.flatMap((g) => g.items.map((i) => ({ ...i, kind: g.kind, color: g.color }))) : state.layout.items.filter((i) => !i.archived);
  let kind = prefill.kind || 'expense', itemId = prefill.item_id ?? null, date = state.today;
  modal('Add transaction', `<form class="quick">
    <div class="seg full" id="qk"><button type="button" data-k="expense">Spent</button><button type="button" data-k="income">Received</button><button type="button" data-k="refund">Refund</button></div>
    <label class="amount huge"><span>$</span><input name="amount" inputmode="decimal" placeholder="0" autofocus autocomplete="off" value="${prefill.amount ? toInput(prefill.amount) : ''}"></label>
    <input name="payee" list="qpayees" placeholder="Where? (e.g. Costco)" autocomplete="off" value="${esc(prefill.payee || '')}">
    <input name="search" type="search" placeholder="Find a category…" autocomplete="off">
    <div class="chips" id="chips"></div>
    <div class="row wrap qopts"><div class="seg" id="qd"><button type="button" data-d="${state.today}">Today</button><button type="button" data-d="${B.addDays(state.today, -1)}">Yesterday</button></div><input type="date" name="date" value="${date}">
      <select name="account_id">${accountOptions(state.accounts.find((a) => a.kind === 'checking')?.id)}</select></div>
    <input name="note" placeholder="Note (optional)">
    <button class="btn primary big full" id="qsave">Save</button>
    <p class="muted small center"><button type="button" class="linkbtn" id="full">More options (split, transfer)…</button></p>
    <datalist id="qpayees">${payees.slice(0, 200).map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist></form>`, (mm, close) => {
    const f = $('form', mm);
    const chips = () => {
      const qs = f.search.value.toLowerCase().trim();
      const list = allItems.filter((i) => (kind === 'income' ? i.kind === 'income' : i.kind !== 'income') && (!qs || i.name.toLowerCase().includes(qs)))
        .sort((a, b) => (b.id === itemId) - (a.id === itemId) || (usage[b.id] || 0) - (usage[a.id] || 0));
      $('#chips', mm).innerHTML = list.map((i) => `<button type="button" class="chip ${i.id === itemId ? 'on' : ''}" data-id="${i.id}" style="--gc:${i.color || 'var(--acc)'}"><span>${esc(i.emoji || '•')} ${esc(i.name)}</span>${view && i.kind !== 'income' ? `<small class="${i.available < 0 ? 'neg' : ''}">${money0(i.available)}</small>` : ''}</button>`).join('') || '<p class="muted small">No match.</p>';
      $$('.chip', mm).forEach((c) => (c.onclick = () => { itemId = itemId === +c.dataset.id ? null : +c.dataset.id; chips(); }));
    };
    const setKind = (k) => { kind = k; $$('#qk button', mm).forEach((b) => b.classList.toggle('on', b.dataset.k === k)); if (itemId && (allItems.find((i) => i.id === itemId)?.kind === 'income') !== (k === 'income')) itemId = null; chips(); };
    const setDate = (d) => { date = d; f.date.value = d; $$('#qd button', mm).forEach((b) => b.classList.toggle('on', b.dataset.d === d)); };
    $$('#qk button', mm).forEach((b) => (b.onclick = () => setKind(b.dataset.k)));
    $$('#qd button', mm).forEach((b) => (b.onclick = () => setDate(b.dataset.d)));
    f.date.onchange = () => setDate(f.date.value);
    f.search.oninput = chips;
    f.payee.onchange = () => { const p = payees.find((x) => x.name.toLowerCase() === f.payee.value.toLowerCase().trim()); if (p?.item_id && !itemId && kind === 'expense') { itemId = p.item_id; chips(); } };
    // Typing "42.50 costco groceries" into the amount box fills everything in.
    f.amount.oninput = () => {
      const v = f.amount.value;
      if (/[a-z]/i.test(v)) {
        const r = B.parseQuick(v, allItems.filter((i) => !i.archived), (p) => { const x = payees.find((y) => y.name.toLowerCase() === p.toLowerCase()); return x ? allItems.find((i) => i.id === x.item_id) : null; }, state.today);
        if (r.amount > 0) { f.amount.value = toInput(r.amount); if (r.payee) f.payee.value = r.payee; if (r.item) itemId = r.item.id; if (r.date) setDate(r.date); setKind(r.kind === 'refund' ? 'refund' : r.kind); }
      }
    };
    $('#full', mm).onclick = () => { close(); txnEditor(null, { amount: fromInput(f.amount.value), payee: f.payee.value, date, kind: kind === 'refund' ? 'income' : kind, item_id: itemId }); };
    setKind(kind); setDate(date);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const amount = fromInput(f.amount.value);
      if (!(amount > 0)) return toast('Enter an amount', 'err');
      const body = { kind: kind === 'refund' ? 'income' : kind, amount, payee: f.payee.value.trim(), date, account_id: +f.account_id.value || null, note: f.note.value, lines: [{ item_id: itemId, amount }], source: 'quick' };
      if (itemId) { usage[itemId] = (usage[itemId] || 0) + 1; LS.set('ledger.usage', usage); }
      close();
      if (!navigator.onLine) { LS.set(QUEUE, [...LS.get(QUEUE, []), body]); return toast('Offline – saved on this phone, will sync automatically'); }
      try {
        const r = await api('POST', '/api/txns', body);
        const it = allItems.find((i) => i.id === itemId);
        let msg = `${money(amount)} → ${it ? it.name : 'Needs category'}`;
        if (it && it.kind !== 'income') { const left = (it.available ?? 0) - (kind === 'refund' ? -amount : amount); msg += left < 0 ? ` · ⚠️ ${money(-left)} over` : ` · ${money(left)} left`; }
        toast(msg, '', { label: 'Undo', run: async () => { await api('DELETE', `/api/txns/${r.id}`); refresh(); } });
        refresh();
      } catch (err) {
        if (!err.status) { LS.set(QUEUE, [...LS.get(QUEUE, []), body]); toast('Couldn’t reach the server – saved on this phone, will sync'); }
        else toast(err.message, 'err');
      }
    };
  }, 'quickm');
}

// ------------------------------------------------------------------ CSV import
function importCsv() {
  modal('Import bank CSV', `<p class="muted small">Download transactions from your bank as CSV and pick the file. Duplicates are skipped automatically, and known payees are categorized for you. Bills get matched and marked paid.</p>
    <input type="file" accept=".csv,text/csv" id="file"><div id="map"></div>`, (m, close) => {
    $('#file', m).onchange = async (e) => {
      const rows = B.parseCSV(await e.target.files[0].text());
      if (rows.length < 2) return toast('That file has no rows', 'err');
      const g = B.guessColumns(rows[0]);
      const opt = (sel) => `<option value="-1">—</option>${rows[0].map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('')}`;
      $('#map', m).innerHTML = `<div class="grid2"><label>Date<select id="cd">${opt(g.date)}</select></label><label>Description / payee<select id="cp">${opt(g.payee)}</select></label>
        <label>Amount<select id="ca">${opt(g.amount)}</select></label><label>…or Debit (money out)<select id="cdb">${opt(g.amount >= 0 ? -1 : g.debit)}</select></label>
        <label>Credit (money in)<select id="ccr">${opt(g.amount >= 0 ? -1 : g.credit)}</select></label><label>Into account<select id="acc">${accountOptions()}</select></label></div>
        <label class="check"><input type="checkbox" id="inv"> Flip signs (my bank shows spending as positive numbers)</label><div id="prev"></div><div class="row end"><button class="btn primary" id="go">Import</button></div>`;
      const build = () => {
        const c = (id) => +$(id, m).value, inv = $('#inv', m).checked;
        return rows.slice(1).map((r) => {
          let amt = c('#ca') >= 0 ? B.parseMoney(r[c('#ca')]) : (c('#ccr') >= 0 ? Math.abs(B.parseMoney(r[c('#ccr')]) || 0) : 0) - (c('#cdb') >= 0 ? Math.abs(B.parseMoney(r[c('#cdb')]) || 0) : 0);
          if (inv) amt = -amt;
          return { date: B.parseDate(r[c('#cd')]), payee: (r[c('#cp')] || '').replace(/\s+/g, ' ').trim(), amount: amt };
        }).filter((r) => r.date && r.amount);
      };
      const preview = () => { const b = build(); $('#prev', m).innerHTML = `<p class="muted small">${b.length} rows. First few:</p><ul class="list compact">${b.slice(0, 6).map((r) => `<li><span class="muted small">${r.date}</span><span class="grow">${esc(r.payee)}</span><b class="${r.amount > 0 ? 'pos' : ''}">${money(r.amount, { sign: true })}</b></li>`).join('')}</ul>`; };
      $$('select, #inv', $('#map', m)).forEach((s) => (s.onchange = preview)); preview();
      $('#go', m).onclick = async () => {
        const r = await api('POST', '/api/import', { rows: build(), account_id: +$('#acc', m).value });
        close(); toast(`Imported ${r.added} (${r.categorized} auto-categorized, ${r.skipped} skipped)`); refresh();
      };
    };
  });
}

// ------------------------------------------------------------------ accounts
async function accountsView(main) {
  const [accts, debts, bank] = await Promise.all([api('GET', '/api/accounts?all=1'), api('GET', '/api/debts'), api('GET', '/api/bank')]);
  const bankOf = (id) => bank.accounts.find((b) => b.enabled && b.account_id === id);
  state.accounts = accts.filter((a) => !a.archived);
  const assets = accts.filter((a) => !a.archived && a.kind !== 'credit').reduce((s, a) => s + a.balance, 0);
  const cards = accts.filter((a) => !a.archived && a.kind === 'credit').reduce((s, a) => s + a.balance, 0);
  const kinds = { checking: '🏦 Checking', savings: '🐖 Savings', cash: '💵 Cash', credit: '💳 Credit card' };
  main.innerHTML = `<div class="page"><header class="phead"><h1>Accounts</h1><span class="sp"></span><button class="btn primary" id="add">＋ Add account</button></header>
    <div class="tiles"><div class="tile"><span class="lbl">Cash & savings</span><b>${money0(assets)}</b></div><div class="tile"><span class="lbl">Credit cards</span><b class="${cards < 0 ? 'neg' : ''}">${money0(cards)}</b></div>
      <div class="tile"><span class="lbl">Snowball debts</span><b class="neg">${money0(-debts.total)}</b></div><div class="tile"><span class="lbl">Net worth (tracked)</span><b>${money0(assets + cards - debts.total)}</b></div></div>
    <section class="card"><ul class="list">${accts.map((a) => `<li data-id="${a.id}" class="${a.archived ? 'archived' : ''}"><span class="grow"><b>${esc(a.name)}</b><br><span class="muted small">${kinds[a.kind]}${bankOf(a.id) ? ` · 🔗 ${esc(bankOf(a.id).org || 'bank')}${bankOf(a.id).balance != null && bankOf(a.id).balance !== a.balance ? ` · <span class="warn">bank says ${money(bankOf(a.id).balance)}</span>` : ' · matches bank ✓'}` : ''}${a.uncleared ? ` · ${a.uncleared} uncleared` : ''}${a.archived ? ' · archived' : ''}</span></span><b class="${a.balance < 0 ? 'neg' : ''}">${money(a.balance)}</b>
      <button class="btn sm rec">Reconcile</button><button class="btn sm ed">Edit</button></li>`).join('')}</ul></section>
    <section class="card"><h2>📈 Net worth over time</h2><div id="nw"></div><p class="muted small">Cash and savings, minus credit cards and snowball debts, at the end of each month.</p></section>
    <p class="muted small">Balances = starting balance + every transaction on the account. Bank-linked accounts are checked against the bank's balance after every sync. <b>Reconcile</b> when you check your bank: enter the balance it shows and Ledger adjusts to match and marks everything cleared.</p></div>`;
  const edit = (a = {}) => modal(a.id ? 'Edit account' : 'Add account', `<form><label>Name<input name="name" value="${esc(a.name || '')}" required autofocus></label>
    <label>Type<select name="kind">${Object.entries(kinds).map(([k, l]) => `<option value="${k}" ${a.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Starting balance<input name="start_balance" inputmode="decimal" value="${toInput(a.start_balance || 0)}" placeholder="0.00"><small class="muted">For credit cards enter what you owe as a negative number.</small></label>
    <label>Count transactions from<input name="start_date" type="date" value="${a.start_date || ''}"><small class="muted">Optional – older imported transactions won't change the balance.</small></label>
    <div class="row end">${a.id ? `<button type="button" class="btn danger" id="del">${'Archive / delete'}</button><span class="sp"></span>` : ''}<button class="btn primary">Save</button></div></form>`, (m, close) => {
    const f = $('form', m);
    f.onsubmit = async (e) => { e.preventDefault(); const b = { name: f.name.value, kind: f.kind.value, start_balance: fromInput(f.start_balance.value), start_date: f.start_date.value || null };
      await api(a.id ? 'PATCH' : 'POST', a.id ? `/api/accounts/${a.id}` : '/api/accounts', b); close(); await loadLayout(); route(); };
    if (a.id) $('#del', m).onclick = async () => { const r = await api('DELETE', `/api/accounts/${a.id}`); close(); toast(r.archived ? 'Archived (it has transactions)' : 'Deleted'); await loadLayout(); route(); };
  });
  netWorthChart($('#nw'));
  $('#add').onclick = () => edit();
  $$('li[data-id]', main).forEach((li) => {
    const a = accts.find((x) => x.id === +li.dataset.id);
    $('.ed', li).onclick = () => edit(a);
    $('.rec', li).onclick = () => modal(`Reconcile ${a.name}`, `<form><p>Ledger says <b>${money(a.balance)}</b>. What does your bank show right now?</p><label class="amount"><span>$</span><input name="v" inputmode="decimal" value="${toInput(a.balance)}" autofocus></label><div class="row end"><button class="btn primary">Reconcile</button></div></form>`, (m, close) => {
      $('form', m).onsubmit = async (e) => { e.preventDefault(); await api('PATCH', `/api/accounts/${a.id}`, { reconcile: fromInput($('[name=v]', m).value) }); close(); toast('Reconciled ✓'); route(); };
    }, 'small');
  });
}

// ------------------------------------------------------------------ settings
async function settingsView(main) {
  const [me, notify, tokens, backup] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/notify'), api('GET', '/api/tokens'), api('GET', '/api/backup')]);
  const s = me.settings, base = me.publicUrl || location.origin, p = notify.prefs, n = p.notify || {};
  const icsUrl = `${base}/ics/${me.user.ics_token}.ics`;
  const monthsOpt = (sel) => B.monthsBetween('2025-01', '2030-12').map((m) => `<option value="${m}" ${m === sel ? 'selected' : ''}>${monthName(m)}</option>`).join('');
  main.innerHTML = `<div class="page settings"><h1>Settings</h1>
    <section class="card"><h2>Budget</h2><form id="fs" class="grid2">
      <label>Budget name<input name="household" value="${esc(s.household)}"></label>
      <label>Week starts on<select name="week_start"><option value="0">Sunday</option><option value="1" ${s.week_start ? 'selected' : ''}>Monday</option></select></label>
      <label>First month<select name="start_month">${monthsOpt(s.start_month)}</select></label>
      <label>Last month<select name="end_month">${monthsOpt(s.end_month)}</select></label>
      <label>Alert on a single charge over<input name="large_charge" inputmode="decimal" value="${toInput(s.large_charge)}" placeholder="500"></label>
      <label>Alert when a bank balance drops below<input name="low_balance" inputmode="decimal" value="${toInput(s.low_balance)}" placeholder="100"></label>
      <label>“Running low” alert at<select name="low_pct">${[75, 80, 85, 90, 95].map((v) => `<option value="${v}" ${s.low_pct === v ? 'selected' : ''}>${v}% spent</option>`).join('')}</select></label>
      <div class="row end"><button class="btn primary">Save</button></div></form>
      <p class="muted small">Months outside this range are hidden. Extend the last month whenever you're ready for the next year – everything carries over.</p></section>

    <section class="card" id="banksec"><h2>🏦 Bank sync</h2><p class="muted">Loading…</p></section>

    <section class="card"><h2>📱 Phone & Claude app</h2>
      <p><b>1. Install the app:</b> open <code>${esc(base)}</code> on your phone → Share → <b>Add to Home Screen</b>. The big <b>＋</b> logs a purchase in seconds, even offline.</p>
      <p><b>2. Tell Claude:</b> add Ledger as a custom connector in the Claude app (claude.ai → Settings → Connectors → Add custom connector) with the URL <code>${esc(base)}/mcp</code>. Then say <i>“I spent $42 at Costco on groceries”</i> or <i>“how much is left for restaurants?”</i>.</p>
      ${tokens.apps.length ? `<ul class="list compact">${tokens.apps.map((a) => `<li><span class="grow">🔗 ${esc(a.name || 'App')} <span class="muted small">connected</span></span><button class="btn sm danger" data-app="${esc(a.client_id)}">Disconnect</button></li>`).join('')}</ul>` : ''}
      <h3 class="sub">3. “Log Spending” form on your iPhone (no browser)</h3>
      <p class="small">A native pop-up form: <b>amount → category (with what's left) → where</b>, and Ledger confirms with a notification. Run it from your Home Screen, the Action Button, Back Tap or Siri. Build it once in the <b>Shortcuts</b> app (about 3 minutes):</p>
      <div class="row wrap"><button class="btn primary" id="mktok">Create my phone token</button><span class="muted small">Copy it – it's shown only once.</span></div><div id="newtok"></div>
      <ol class="sc">
        <li>Shortcuts app → <b>＋</b> → name it <b>Log Spending</b>.</li>
        <li><b>Ask for Input</b> – Input: <i>Number</i>, Prompt: <i>How much?</i> (turn on Allow Decimals). Then <b>Set Variable</b> → name it <b>Amount</b>.</li>
        <li><b>Get Contents of URL</b> – URL: ${copyField(`${base}/api/spend/categories`)} Show More → Headers → add <code>Authorization</code> = <code>Bearer</code> + space + your token.</li>
        <li><b>Choose from List</b> – List: <i>Contents of URL</i>, Prompt: <i>Which category?</i>. Then <b>Set Variable</b> → <b>Category</b>.</li>
        <li><b>Ask for Input</b> – Input: <i>Text</i>, Prompt: <i>Where?</i> (you can leave it blank when you log). Then <b>Set Variable</b> → <b>Where</b>.</li>
        <li><b>Get Contents of URL</b> – URL: ${copyField(`${base}/api/spend?format=text`)} Method: <b>POST</b>, same <code>Authorization</code> header, Request Body: <b>JSON</b> with three fields:
          <code>amount</code> (Number) = <i>Amount</i>, <code>category</code> (Text) = <i>Category</i>, <code>payee</code> (Text) = <i>Where</i>.</li>
        <li><b>Show Notification</b> – <i>Contents of URL</i>. You'll see e.g. <i>“✓ $18.40 Chick-fil-A → Restaurants · $38.11 left of $225.00”</i>.</li>
      </ol>
      <p class="small"><b>Make it one tap:</b> in the shortcut tap ⓘ → <b>Add to Home Screen</b>; or Settings → <b>Action Button</b> → Shortcut; or Settings → Accessibility → Touch → <b>Back Tap</b> → Double Tap; or add the Shortcuts widget to your Lock Screen. “Hey Siri, Log Spending” works too.</p>
      <p class="muted small">Categories are listed most-used first. “Not sure – sort it later” puts it in New transactions (Ledger still guesses from the store name). With bank sync on, the bank's copy of the purchase is matched to what you logged – it's never counted twice. Want a second one for income? Duplicate it, add <code>?kind=income</code> to the categories URL and a <code>kind</code> = <code>income</code> field to the JSON.</p>
      <details class="small"><summary>Android</summary><p>Use the free <b>HTTP Shortcuts</b> app: create a shortcut that POSTs JSON to ${copyField(`${base}/api/spend?format=text`)} with the same Authorization header and body <code>{"amount": "{amount}", "category": "{category}", "payee": "{where}"}</code>, using a Number variable, a Select variable (your category names) and a Text variable; set the response to show as a toast.</p></details>
      <h3 class="sub">Tokens</h3>
      <ul class="list compact">${tokens.tokens.map((t) => `<li><span class="grow">🔑 ${esc(t.name)} <span class="muted small">${t.last_used ? 'last used ' + new Date(t.last_used).toLocaleDateString() : 'never used'}</span></span><button class="btn sm danger" data-tok="${t.id}">Revoke</button></li>`).join('')}</ul>
      </section>

    <section class="card"><h2>📅 Calendar feed</h2><p>Bills, paydays and debt due dates as a calendar you can subscribe to – in iPhone/Google/Outlook calendar, or in <b>Nexus</b> (Settings → Calendars → Subscribe to ICS URL).</p>
      <div class="copy"><input readonly value="${esc(icsUrl)}"><button class="btn sm" data-copy="${esc(icsUrl)}">Copy</button></div><button class="linkbtn small" id="rot">Make a new private link (old one stops working)</button></section>

    <section class="card"><h2>🔔 Notifications</h2><form id="fn" class="grid2">
      <label>ntfy topic URL<input name="ntfy" value="${esc(n.ntfy || '')}" placeholder="https://ntfy.sh/your-secret-topic"></label>
      <label>ntfy access token (optional)<input name="ntfyToken" value="${esc(n.ntfyToken || '')}"></label>
      ${notify.pushover ? `<label>Pushover user key<input name="pushover" value="${esc(n.pushover || '')}"></label>` : ''}
      ${notify.smtp ? `<label>Email<input name="email" type="email" value="${esc(n.email || '')}"></label>` : ''}
      <label class="check"><input type="checkbox" name="digest" ${p.digest.on ? 'checked' : ''}> Daily bill reminder at <input name="time" type="time" value="${esc(p.digest.time)}" style="width:auto"></label>
      <label class="check"><input type="checkbox" name="alerts" ${p.alerts ? 'checked' : ''}> Alert when a category runs low or goes over</label>
      <label class="check"><input type="checkbox" name="bank" ${p.bank ? 'checked' : ''}> Bank alerts: large or unusual charges, double charges, price increases, low balance</label>
      <label class="check"><input type="checkbox" name="insights" ${p.insights ? 'checked' : ''}> Weekly spending insights (Sunday evening)</label>
      <label class="check"><input type="checkbox" name="planReminder" ${p.planReminder ? 'checked' : ''}> Remind me to plan next month (around the 25th)</label>
      <div class="row end"><button type="button" class="btn" id="test">Send test</button><button class="btn primary">Save</button></div></form>
      <p class="muted small">ntfy is a free push-notification app – install it, subscribe to a hard-to-guess topic name, and paste that topic's address here.</p></section>

    <section class="card"><h2>👥 Household</h2><ul class="list compact">${me.users.map((u) => `<li><span class="dot" style="background:${esc(u.color)}"></span><span class="grow">${esc(u.name)}${u.id === me.user.id ? ' (you)' : ''}</span></li>`).join('')}</ul>
      <form id="fu" class="grid2"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>Temporary password<input name="password" type="password" minlength="8" required></label><div class="row end"><button class="btn">Add member</button></div></form></section>

    <section class="card"><h2>👤 You</h2><form id="fme" class="grid2"><label>Name<input name="name" value="${esc(me.user.name)}"></label><label>Color<input name="color" type="color" value="${esc(me.user.color)}"></label>
      <label>Theme<select name="theme">${['auto', 'light', 'dark'].map((t) => `<option ${LS.get('ledger.theme', 'auto') === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Current password<input name="current" type="password" autocomplete="current-password"></label><label>New password<input name="password" type="password" minlength="8" autocomplete="new-password"></label>
      <div class="row end"><button class="btn primary">Save</button></div></form>
      <p>Two-step sign-in: <b>${me.security.totp ? `on (${me.security.recoveryLeft} recovery codes left)` : 'off'}</b> <button class="btn sm" id="tfa">${me.security.totp ? 'Turn off' : 'Turn on'}</button></p></section>

    <section class="card"><h2>💾 Backups & export</h2>
      <p>Nightly snapshots: ${backup.local.length ? backup.local.map(esc).join(', ') : 'none yet (first one runs a minute after start)'}.</p>
      <p>Off-server copy: ${backup.offsite.configured ? (backup.offsite.status ? (backup.offsite.status.ok ? `✓ ${new Date(backup.offsite.status.at).toLocaleString()} → ${esc(backup.offsite.status.targets.join(', '))}` : `⚠️ ${esc(backup.offsite.status.error)}`) : 'configured, not run yet') : 'not set up (see README – Backblaze B2 / another disk)'}</p>
      <div class="row wrap"><button class="btn" id="bk">Back up now</button><a class="btn" href="/api/export/csv" download>Transactions (CSV)</a><a class="btn" href="/api/export" download>Everything (JSON)</a><button class="btn" id="act">Activity log</button></div></section>
    <p class="center"><button class="btn danger" id="out">Sign out</button></p></div>`;
  const form = (id, fn) => { $(id).onsubmit = async (e) => { e.preventDefault(); try { await fn(Object.fromEntries(new FormData(e.target)), e.target); } catch (err) { toast(err.message, 'err'); } }; };
  form('#fs', async (b) => { state.settings = await api('PUT', '/api/settings', { ...b, low_pct: +b.low_pct, large_charge: fromInput(b.large_charge), low_balance: fromInput(b.low_balance) }); toast('Saved'); shell(); route(); });
  bankSettings($('#banksec'));
  form('#fn', async (b, f) => { await api('PUT', '/api/notify', { notify: { ntfy: b.ntfy, ntfyToken: b.ntfyToken, pushover: b.pushover, email: b.email }, digest: { on: f.digest.checked, time: b.time }, alerts: f.alerts.checked, planReminder: f.planReminder.checked, bank: f.bank.checked, insights: f.insights.checked }); toast('Saved'); });
  $('#test').onclick = async () => { try { $('#fn').requestSubmit(); const r = await api('POST', '/api/notify/test'); toast(r.results.map((x) => `${x.channel}: ${x.ok ? 'sent ✓' : x.error}`).join(' · ')); } catch (e) { toast(e.message, 'err'); } };
  form('#fu', async (b, f) => { await api('POST', '/api/users', b); toast(`Added ${b.name}. They can sign in with that email and password.`); f.reset(); route(); });
  form('#fme', async (b) => { LS.set('ledger.theme', b.theme); applyTheme(); const body = { name: b.name, color: b.color }; if (b.password) Object.assign(body, { password: b.password, current: b.current }); await api('PATCH', '/api/users/me', body); toast('Saved'); });
  $('#mktok').onclick = async () => { const r = await api('POST', '/api/tokens', { name: 'iPhone Shortcut' }); $('#newtok').innerHTML = `<p class="callout">Your token – copy it now, it won't be shown again. In the Shortcut the header value is <code>Bearer</code>, a space, then this:</p><div class="copy"><input readonly value="${r.token}"><button class="btn sm" data-copy="${r.token}">Copy</button></div>`; bindCopy(); };
  $$('[data-tok]').forEach((b) => (b.onclick = async () => { await api('DELETE', `/api/tokens/${b.dataset.tok}`); route(); }));
  $$('[data-app]').forEach((b) => (b.onclick = async () => { await api('DELETE', `/api/apps/${encodeURIComponent(b.dataset.app)}`); route(); }));
  $('#rot').onclick = async () => { if (await confirmBox('New calendar link', 'Calendars subscribed to the old link will stop updating. Continue?', 'Make new link')) { await api('PATCH', '/api/users/me', { rotateIcs: true }); route(); } };
  $('#bk').onclick = async () => { const r = await api('POST', '/api/backup/run'); toast(r.offsite && !r.offsite.ok ? `Local ✓, off-server failed: ${r.offsite.error}` : 'Backed up ✓'); route(); };
  $('#act').onclick = async () => { const a = await api('GET', '/api/activity'); modal('Activity log', `<ul class="list compact">${a.map((x) => `<li><span class="muted small">${new Date(x.at).toLocaleString()}</span><span class="grow">${esc(x.text)}${x.user_name ? ` <span class="muted small">· ${esc(x.user_name)}</span>` : ''}</span></li>`).join('') || '<li>Nothing yet</li>'}</ul>`); };
  $('#out').onclick = async () => { await api('POST', '/api/logout'); location.reload(); };
  $('#tfa').onclick = () => (me.security.totp ? tfaOff() : tfaOn(me.user.email));
  bindCopy();
}
const copyField = (v) => `<span class="copy inl"><input readonly value="${esc(v)}"><button class="btn sm" data-copy="${esc(v)}">Copy</button></span>`;
const bindCopy = () => $$('[data-copy]').forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { b.previousElementSibling?.select(); } }));
async function tfaOn() {
  const r = await api('POST', '/api/2fa/setup');
  let qr = '';
  try { await import('/vendor/qrcode.js'); const g = window.qrcode(0, 'M'); g.addData(r.uri); g.make(); qr = g.createSvgTag({ cellSize: 4, margin: 2 }); } catch {}
  modal('Turn on two-step sign-in', `<p>Scan with an authenticator app (Google Authenticator, 1Password, Authy…)${qr ? '' : ' or enter the key'}:</p><div class="qr">${qr}</div><p class="small">Key: <code>${r.secret}</code></p>
    <form><input name="code" inputmode="numeric" placeholder="6-digit code" autofocus required><div class="row end"><button class="btn primary">Turn on</button></div></form>`, (m, close) => {
    $('form', m).onsubmit = async (e) => { e.preventDefault(); try { const x = await api('POST', '/api/2fa/enable', { code: $('[name=code]', m).value }); close(); modal('Recovery codes', `<p>Save these somewhere safe. Each works once if you lose your phone.</p><pre class="codes">${x.codes.join('\n')}</pre>`); route(); } catch (err) { toast(err.message, 'err'); } };
  });
}
function tfaOff() {
  modal('Turn off two-step sign-in', '<form><input name="password" type="password" placeholder="Your password" required autofocus><div class="row end"><button class="btn danger">Turn off</button></div></form>', (m, close) => {
    $('form', m).onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/2fa/disable', { password: $('[name=password]', m).value }); close(); route(); } catch (err) { toast(err.message, 'err'); } };
  }, 'small');
}

// ------------------------------------------------------------------ boot
async function boot() {
  let me;
  try { me = await api('GET', '/api/me'); } catch (e) { if (e.message === 'Signed out') return; document.body.innerHTML = `<div class="boot err">Can't reach Ledger: ${esc(e.message)}</div>`; return; }
  Object.assign(state, { me: me.user, users: me.users, settings: me.settings, today: me.today, publicUrl: me.publicUrl });
  await loadLayout();
  shell();
  addEventListener('hashchange', route);
  await route();
  // Live updates from the other person's phone.
  const es = new EventSource('/api/stream');
  es.addEventListener('change', (e) => { const d = JSON.parse(e.data); if (d.origin !== clientId) refresh(); });
  const net = () => { state.online = navigator.onLine; $('.net')?.classList.toggle('offline', !navigator.onLine); if (navigator.onLine) flushQueue(); };
  addEventListener('online', net); addEventListener('offline', net);
  flushQueue();
  // Re-sync "today" when the app is reopened on a new day.
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible') { const m2 = await api('GET', '/api/me').catch(() => null); if (m2 && m2.today !== state.today) { state.today = m2.today; route(); } flushQueue(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
export { refresh, route };
boot();
