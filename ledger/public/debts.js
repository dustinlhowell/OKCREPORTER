// Debt snowball: smallest balance first, no interest. Minimums of paid-off debts roll onto the next one.
import { $, $$, esc, api, state, toast, modal, confirmBox, money, money0, toInput, fromInput, accountOptions, bar, monthName, shortMonth, curMonth, B } from './core.js';
import { refresh } from './app.js';
import { lineChart } from './charts.js';

const KINDS = ['credit card', 'medical', 'personal loan', 'student loan', 'car loan', 'family / friend', 'other'];

export async function debtsView(main) {
  const s = await api('GET', '/api/debts');
  const open = s.order, done = s.debts.filter((d) => d.current <= 0);
  const mins = open.reduce((a, d) => a + d.min_payment, 0);
  const p = s.plan;
  const thisMonth = p.months[0]?.payments || {};
  main.innerHTML = `<div class="page debts"><header class="phead"><h1>Debt snowball</h1><span class="sp"></span><button class="btn primary" id="add">＋ Add debt</button></header>
    ${s.debts.length ? `
    <div class="hero">
      <div><span class="lbl">Debt-free</span><b class="big">${p.debtFree ? monthName(p.debtFree) : open.length ? '—' : '🎉 Now!'}</b><span class="sub">${p.debtFree ? `${p.totalMonths} month${p.totalMonths === 1 ? '' : 's'} to go` : open.length ? 'Increase the snowball to get a date' : 'Every debt is paid off'}</span></div>
      <div><span class="lbl">Remaining</span><b class="big">${money0(s.total)}</b><span class="sub">${money0(s.paidTotal)} paid off of ${money0(s.original)}</span>${bar(s.original ? s.paidTotal / s.original * 100 : 0, 'good')}</div>
      <div><span class="lbl">Snowball each month</span><b class="big">${money0(p.budget)}</b><span class="sub">${money0(mins)} minimums${s.freed ? ` + ${money0(s.freed)} freed up` : ''} + ${money0(s.extra)} extra</span></div>
    </div>
    <section class="card whatif"><h2>Extra toward debt each month</h2>
      <div class="row wrap"><label class="amount sm"><span>$</span><input id="extra" inputmode="decimal" value="${toInput(s.extra)}" placeholder="0"></label>
        <input type="range" id="slider" min="0" max="${Math.max(200000, s.extra * 2)}" step="2500" value="${s.extra}"><span id="wi" class="muted"></span><span class="sp"></span><button class="btn primary" id="saveExtra">Save</button></div>
      <p class="muted small">Drag to see how extra money changes your debt-free date. Everything above the minimums goes to the smallest balance.</p></section>
    <div class="row wrap"><h2 class="grow">Your snowball <span class="muted small">smallest → largest</span></h2><button class="btn" id="apply">Put plan in budget…</button></div>
    <div class="dlist">${open.map((d, i) => debtCard(d, i, s, thisMonth)).join('')}</div>
    ${done.length ? `<section class="card"><h2>✅ Paid off</h2><ul class="list">${done.map((d) => `<li data-id="${d.id}"><span class="grow"><b>${esc(d.name)}</b> <span class="muted small">${esc(d.kind)}${d.paid_off ? ` · paid off ${new Date(d.paid_off + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}` : ''}</span></span><b class="pos">${money(d.original)}</b><button class="btn sm ed">Edit</button></li>`).join('')}</ul></section>` : ''}
    ${open.length ? `<section class="card"><h2>Payoff timeline</h2><div id="chart"></div>
      <div class="tablewrap"><table class="sched"><thead><tr><th>Month</th>${B.snowballOrder(open.map((d) => ({ ...d, balance: d.current, min: d.min_payment }))).map((d) => `<th>${esc(d.name)}</th>`).join('')}<th>Left</th></tr></thead><tbody>
      ${p.months.slice(0, 36).map((r) => `<tr><td>${shortMonth(r.month)} ${r.month.slice(2, 4)}</td>${open.map((d) => { const v = (r.payments[d.id] || 0) + (r.already?.[d.id] || 0), fin = r.balances[d.id] === 0 && v; return `<td class="${fin ? 'pos' : ''}">${v ? money0(v) : '<span class="muted">–</span>'}${fin ? ' 🎉' : ''}</td>`; }).join('')}<td>${money0(Object.values(r.balances).reduce((a, b) => a + b, 0))}</td></tr>`).join('')}
      </tbody></table>${p.months.length > 36 ? `<p class="muted small">…${p.months.length - 36} more months</p>` : ''}</div></section>` : ''}
    ` : `<div class="empty card"><h2>Start your debt snowball</h2><p>List every debt with its balance and minimum payment. Ledger orders them <b>smallest balance to largest</b> (interest ignored), tells you exactly what to pay each month, and rolls each paid-off minimum into the next debt.</p><button class="btn primary big" id="add2">＋ Add your first debt</button></div>`}
  </div>`;
  ($('#add') || {}).onclick = () => debtEditor();
  ($('#add2') || {}).onclick = () => debtEditor();
  if (!s.debts.length) return;
  $$('.dcard, .debts li[data-id]').forEach((el) => {
    const d = s.debts.find((x) => x.id === +el.dataset.id);
    $('.pay', el) && ($('.pay', el).onclick = () => payDebt(d.id, thisMonth[d.id]));
    $('.ed', el) && ($('.ed', el).onclick = () => debtEditor(d));
    $('.bal', el) && ($('.bal', el).onclick = () => updateBalance(d));
    $('.chg', el) && ($('.chg', el).onclick = () => addCharge(d));
  });
  const ex = $('#extra'), sl = $('#slider');
  const whatIf = () => {
    const extra = fromInput(ex.value);
    const sim = B.snowball(open.map((d) => ({ id: d.id, name: d.name, balance: d.current, min: d.min_payment })), extra + (s.freed || 0), s.month);
    const diff = p.totalMonths && sim.totalMonths ? p.totalMonths - sim.totalMonths : 0;
    $('#wi').innerHTML = sim.debtFree ? `Debt-free <b>${monthName(sim.debtFree)}</b>${diff > 0 ? ` · <span class="pos">${diff} month${diff > 1 ? 's' : ''} sooner</span>` : diff < 0 ? ` · <span class="neg">${-diff} month${diff < -1 ? 's' : ''} later</span>` : ''}` : open.length ? '<span class="neg">Not paid off – raise the snowball</span>' : '';
  };
  ex.oninput = () => { sl.value = fromInput(ex.value); whatIf(); };
  sl.oninput = () => { ex.value = toInput(+sl.value); whatIf(); };
  whatIf();
  $('#saveExtra').onclick = async () => { await api('PUT', '/api/settings', { snowball_extra: fromInput(ex.value) }); toast('Snowball updated'); refresh(); };
  $('#apply').onclick = () => applyPlan(s);
  if (open.length) {
    const pts = s.history.filter((h) => h.total > 0 || h.month >= s.month).map((h) => ({ label: `${shortMonth(h.month)} ${h.month.slice(2, 4)}`, value: h.total, note: 'actual' }));
    const split = pts.length - 1;
    for (const r of p.months.slice(1)) pts.push({ label: `${shortMonth(r.month)} ${r.month.slice(2, 4)}`, value: Object.values(r.balances).reduce((a, b) => a + b, 0), note: 'projected' });
    lineChart($('#chart'), pts, { splitAt: split, full: (v) => money(v), height: 190, color: 'var(--series-2)' });
  }
}

function debtCard(d, i, s, thisMonth) {
  const paid = s.paidThisMonth[d.id] || 0, target = (thisMonth[d.id] || 0) + paid;
  return `<section class="dcard card ${i === 0 ? 'focus' : ''}" data-id="${d.id}">
    <div class="drow"><span class="rank">${i + 1}</span><div class="grow"><b>${esc(d.name)}</b> <span class="muted small">${esc(d.kind)}${d.due_day ? ` · due the ${d.due_day}${['th', 'st', 'nd', 'rd'][(d.due_day % 100 > 10 && d.due_day % 100 < 14) ? 0 : d.due_day % 10] || 'th'}` : ''}</span>
      ${i === 0 ? '<div class="focuslbl">🎯 Focus debt – every extra dollar goes here</div>' : ''}</div><b class="big">${money(d.current)}</b></div>
    ${bar(d.progress * 100, 'good')}<div class="row small muted"><span>${Math.round(d.progress * 100)}% paid of ${money0(d.original)}</span><span class="sp"></span><span>Min ${money0(d.min_payment)}</span><span>· Paid off <b>${d.payoff ? monthName(d.payoff, 'short') : '—'}</b></span></div>
    <div class="row small"><span>This month: paid <b>${money0(paid)}</b> of <b>${money0(target)}</b> planned</span>${bar(target ? paid / target * 100 : 0, paid >= target && target ? 'good' : '')}</div>
    <div class="row wrap"><button class="btn primary sm pay">Log payment</button><button class="btn sm bal">Update balance</button><button class="btn sm chg">Add charge</button><button class="btn sm ed">Edit</button></div></section>`;
}

export async function payDebt(id, suggested) {
  const s = await api('GET', '/api/debts');
  const d = s.debts.find((x) => x.id === id); if (!d) return;
  const sug = suggested ?? Math.max(0, ((s.plan.months[0]?.payments || {})[id] || 0));
  modal(`Pay ${d.name}`, `<form><p class="muted">Balance ${money(d.current)}. ${sug ? `This month's snowball says pay <b>${money(sug)}</b> more.` : ''}</p>
    <label class="amount"><span>$</span><input name="amount" inputmode="decimal" value="${toInput(sug || d.min_payment)}" autofocus required></label>
    <div class="grid2"><label>Date<input name="date" type="date" value="${state.today}"></label><label>From account<select name="account_id">${accountOptions(state.accounts.find((a) => a.kind === 'checking')?.id)}</select></label></div>
    <p class="muted small">Recorded as spending in the <b>${esc(d.item_name || d.name)}</b> budget line and taken off the balance.</p>
    <div class="row end"><button class="btn primary">Log payment</button></div></form>`, (m, close) => {
    const f = $('form', m);
    f.onsubmit = async (e) => { e.preventDefault(); try { await api('POST', `/api/debts/${id}/pay`, { amount: fromInput(f.amount.value), date: f.date.value, account_id: +f.account_id.value || null }); close(); toast(`Payment logged – ${d.name}`); refresh(); } catch (err) { toast(err.message, 'err'); } };
  }, 'small');
}

function debtEditor(d = null) {
  modal(d ? `Edit ${d.name}` : 'Add debt', `<form class="grid2">
    <label>Name<input name="name" value="${esc(d?.name || '')}" placeholder="e.g. Capital One" required autofocus></label>
    <label>Type<select name="kind">${KINDS.map((k) => `<option ${d?.kind === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
    ${d ? '' : '<label>Current balance<input name="balance" inputmode="decimal" placeholder="0.00" required></label>'}
    <label>Minimum payment<input name="min_payment" inputmode="decimal" value="${toInput(d?.min_payment || 0)}" placeholder="0.00"></label>
    <label>Due day of month<input name="due_day" type="number" min="1" max="31" value="${d?.due_day || ''}"></label>
    <label>Original amount (for progress)<input name="original" inputmode="decimal" value="${toInput(d?.original || 0)}" placeholder="same as balance"></label>
    <label class="full">Notes<input name="note" value="${esc(d?.note || '')}" placeholder="Account #, website, phone…"></label>
    <div class="row end full">${d ? '<button type="button" class="btn danger" id="del">Delete</button><span class="sp"></span>' : ''}<button class="btn primary">Save</button></div></form>
    ${d ? '' : '<p class="muted small">A matching line is added to the Debt group of your budget – payments logged there come off the balance automatically.</p>'}`, (m, close) => {
    const f = $('form', m);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const b = { name: f.name.value, kind: f.kind.value, min_payment: fromInput(f.min_payment.value), due_day: +f.due_day.value || null, note: f.note.value };
      if (f.original.value) b.original = fromInput(f.original.value);
      if (!d) b.balance = fromInput(f.balance.value);
      try { await api(d ? 'PATCH' : 'POST', d ? `/api/debts/${d.id}` : '/api/debts', b); close(); toast('Saved'); refresh(); } catch (err) { toast(err.message, 'err'); }
    };
    if (d) $('#del', m).onclick = async () => { if (await confirmBox('Delete debt', `Delete “${esc(d.name)}”? Its payments stay in your transactions.`, 'Delete', true)) { await api('DELETE', `/api/debts/${d.id}`); close(); refresh(); } };
  });
}
function updateBalance(d) {
  modal(`Update ${d.name} balance`, `<form><p class="muted">Ledger tracks ${money(d.current)}. Enter the balance from your latest statement (e.g. after interest or fees) – it will continue from there.</p>
    <label class="amount"><span>$</span><input name="v" inputmode="decimal" value="${toInput(d.current)}" autofocus></label><div class="row end"><button class="btn primary">Update</button></div></form>`, (m, close) => {
    $('form', m).onsubmit = async (e) => { e.preventDefault(); await api('PATCH', `/api/debts/${d.id}`, { balance: fromInput($('[name=v]', m).value) }); close(); toast('Balance updated'); refresh(); };
  }, 'small');
}
function addCharge(d) {
  modal(`Add a charge to ${d.name}`, `<form><p class="muted">New purchases, fees or interest added to this debt.</p><label class="amount"><span>$</span><input name="v" inputmode="decimal" autofocus required></label>
    <label>Note<input name="note" placeholder="e.g. late fee"></label><div class="row end"><button class="btn primary">Add</button></div></form>`, (m, close) => {
    $('form', m).onsubmit = async (e) => { e.preventDefault(); await api('POST', `/api/debts/${d.id}/adjust`, { amount: fromInput($('[name=v]', m).value), note: $('[name=note]', m).value }); close(); refresh(); };
  }, 'small');
}
function applyPlan(s) {
  const cur = s.month, end = state.settings.end_month;
  const months = B.monthsBetween(cur, end);
  modal('Put the snowball plan in your budget', `<p>Sets each debt's budget line to the snowball payment for the months you pick (overwrites what's planned there).</p>
    <div class="tools"><button class="tool" data-n="1"><b>This month</b><span>${monthName(cur)}</span></button><button class="tool" data-n="3"><b>Next 3 months</b><span>${monthName(cur, 'short')} – ${monthName(months[Math.min(2, months.length - 1)], 'short')}</span></button>
    <button class="tool" data-n="${months.length}"><b>Rest of the budget year</b><span>through ${monthName(end)}</span></button></div>`, (m, close) => {
    $$('[data-n]', m).forEach((b) => (b.onclick = async () => { const r = await api('POST', '/api/debts/apply', { months: months.slice(0, +b.dataset.n) }); close(); toast(`Budget updated (${r.changed} lines)`); refresh(); }));
  }, 'small');
}
