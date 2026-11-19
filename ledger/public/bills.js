// Bills, paydays and scheduled transfers.
import { $, $$, esc, api, state, toast, modal, confirmBox, money, money0, toInput, fromInput, itemOptions, accountOptions, fmtDate, B } from './core.js';
import { refresh } from './app.js';

export async function billsView(main) {
  const list = await api('GET', '/api/recurring');
  const t = state.today, m = t.slice(0, 7);
  const monthly = (r) => {
    const n = B.occurrences(r.rule, `${m}-01`, B.lastDay(m)).length || (r.rule.freq === 'yearly' ? 1 / 12 : r.rule.freq === 'once' ? 0 : 0);
    return r.active ? n * r.amount : 0;
  };
  const sum = (k) => list.filter((r) => r.kind === k).reduce((a, r) => a + monthly(r), 0);
  const sec = (k, title, emptyText) => {
    const rows = list.filter((r) => r.kind === k);
    return `<section class="card"><h2>${title}</h2>${rows.length ? `<ul class="list">${rows.map((r) => `<li data-id="${r.id}" class="${r.active ? '' : 'archived'}"><span class="grow"><b>${esc(r.name)}</b>${r.autopay ? ' <span class="tag">autopay</span>' : ''}${r.active ? '' : ' <span class="tag">paused</span>'}<br>
      <span class="muted small">${esc(r.describe)}${r.item_name ? ` · ${esc(r.item_name)}` : ''}${r.account_name ? ` · ${esc(r.account_name)}` : ''}${r.next ? ` · next ${fmtDate(r.next)}` : ''}</span></span><b class="${k === 'income' ? 'pos' : ''}">${money(r.amount)}</b></li>`).join('')}</ul>` : `<p class="muted">${emptyText}</p>`}</section>`;
  };
  main.innerHTML = `<div class="page"><header class="phead"><h1>Bills & income</h1><span class="sp"></span><button class="btn primary" id="add">＋ Add</button></header>
    <div class="tiles"><div class="tile"><span class="lbl">Bills this month</span><b>${money0(sum('expense'))}</b></div><div class="tile"><span class="lbl">Paydays this month</span><b class="pos">${money0(sum('income'))}</b></div>
      <div class="tile"><span class="lbl">Scheduled items</span><b>${list.filter((r) => r.active).length}</b></div></div>
    ${sec('expense', '🧾 Bills', 'Add rent, utilities, subscriptions, insurance… They show on the calendar, remind you before they’re due and can post themselves (autopay).')}
    ${sec('income', '💵 Paydays & income', 'Add your paychecks so the calendar can forecast your cash.')}
    ${list.some((r) => r.kind === 'transfer') ? sec('transfer', '🔁 Transfers', '') : ''}
    <p class="muted small">Debt minimum payments come from the <a href="#/debts">Debt snowball</a> automatically – no need to add them here.</p></div>`;
  $('#add').onclick = () => billEditor();
  $$('li[data-id]', main).forEach((li) => (li.onclick = () => billEditor(list.find((r) => r.id === +li.dataset.id))));
}

export function billEditor(r = null) {
  const d = r || { kind: 'expense', amount: 0, rule: { freq: 'monthly', start: state.today, interval: 1 }, remind_days: 2, active: true };
  modal(r ? `Edit ${r.name}` : 'Add bill or income', `<form class="grid2">
    <div class="seg full" id="bk">${[['expense', 'Bill'], ['income', 'Income'], ['transfer', 'Transfer']].map(([k, l]) => `<button type="button" data-k="${k}" class="${d.kind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <label>Name<input name="name" value="${esc(d.name || '')}" placeholder="e.g. Rent, Netflix, Paycheck" required autofocus></label>
    <label>Amount<input name="amount" inputmode="decimal" value="${toInput(d.amount)}" placeholder="0.00" required></label>
    <label>Repeats<select name="freq">${[['monthly', 'Monthly'], ['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['semimonthly', 'Twice a month'], ['yearly', 'Yearly'], ['once', 'Once']].map(([k, l]) => `<option value="${k}" ${(d.rule.freq === 'weekly' && +d.rule.interval === 2 ? 'biweekly' : d.rule.freq) === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>First / next date<input name="start" type="date" value="${d.rule.start}" required></label>
    <label class="f-month">Day of month<input name="day" type="number" min="1" max="31" value="${d.rule.day || +d.rule.start.slice(8)}"><small class="muted">31 = last day</small></label>
    <label class="f-semi">Second day<input name="day2" type="number" min="1" max="31" value="${d.rule.day2 || 15}"></label>
    <label class="f-cat">Budget category<select name="item_id">${itemOptions(d.item_id, { none: '— none —', income: d.kind === 'income', expense: d.kind !== 'income' })}</select></label>
    <label>${d.kind === 'transfer' ? 'From account' : 'Account'}<select name="account_id">${accountOptions(d.account_id, { blank: true })}</select></label>
    <label class="f-tr">To account<select name="to_account_id">${accountOptions(d.to_account_id, { blank: true })}</select></label>
    <label>Ends (optional)<input name="end" type="date" value="${d.rule.end || ''}"></label>
    <label>Remind me<select name="remind_days">${[0, 1, 2, 3, 5, 7].map((n) => `<option value="${n}" ${+d.remind_days === n ? 'selected' : ''}>${n ? `${n} day${n > 1 ? 's' : ''} before` : 'on the day'}</option>`).join('')}</select></label>
    <label class="check full"><input type="checkbox" name="autopay" ${d.autopay ? 'checked' : ''}> <span><b>Autopay</b> – record it automatically on the date (otherwise tap “Paid” when you pay it)</span></label>
    ${r ? `<label class="check full"><input type="checkbox" name="active" ${d.active ? 'checked' : ''}> Active</label>` : '<label class="check full"><input type="checkbox" name="set_plan" checked> Plan this amount in the budget category for every month it falls in (where nothing is planned yet)</label>'}
    <p class="muted small full" id="desc"></p>
    <div class="row end full">${r ? '<button type="button" class="btn danger" id="del">Delete</button><span class="sp"></span>' : ''}<button class="btn primary">Save</button></div></form>`, (m, close) => {
    const f = $('form', m);
    let kind = d.kind;
    const sync = () => {
      const fq = f.freq.value;
      $('.f-month', m).hidden = fq !== 'monthly'; $('.f-semi', m).hidden = fq !== 'semimonthly';
      $('.f-cat', m).hidden = kind === 'transfer'; $('.f-tr', m).hidden = kind !== 'transfer';
      if (fq === 'semimonthly' && !r) f.day.value = f.day.value || 1;
      const rule = buildRule();
      $('#desc', m).textContent = rule.start ? `${B.describeRule(rule)} · next: ${B.occurrences(rule, state.today, B.addDays(state.today, 800)).slice(0, 3).map((x) => fmtDate(x)).join(', ') || '—'}` : '';
    };
    const buildRule = () => { const fq = f.freq.value; return { freq: fq === 'biweekly' ? 'weekly' : fq, interval: fq === 'biweekly' ? 2 : 1, start: f.start.value, day: +f.day.value || undefined, day2: +f.day2.value || undefined, end: f.end.value || undefined }; };
    $$('#bk button', m).forEach((b) => (b.onclick = () => { kind = b.dataset.k; $$('#bk button', m).forEach((x) => x.classList.toggle('on', x === b)); f.item_id.innerHTML = itemOptions(f.item_id.value, { none: '— none —', income: kind === 'income', expense: kind !== 'income' }); sync(); }));
    f.addEventListener('input', sync); sync();
    f.start.onchange = () => { if (f.freq.value === 'monthly') f.day.value = +f.start.value.slice(8); sync(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const b = { name: f.name.value, kind, amount: fromInput(f.amount.value), rule: buildRule(), item_id: +f.item_id.value || null, account_id: +f.account_id.value || null, to_account_id: +f.to_account_id.value || null,
        remind_days: +f.remind_days.value, autopay: f.autopay.checked, active: r ? f.active.checked : true, set_plan: !r && f.set_plan?.checked, note: d.note || '' };
      try { await api(r ? 'PUT' : 'POST', r ? `/api/recurring/${r.id}` : '/api/recurring', b); close(); toast('Saved'); refresh(); } catch (err) { toast(err.message, 'err'); }
    };
    if (r) $('#del', m).onclick = async () => { if (await confirmBox('Delete', `Delete “${esc(r.name)}”? Past payments stay in your transactions.`, 'Delete', true)) { await api('DELETE', `/api/recurring/${r.id}`); close(); refresh(); } };
  });
}

// "Paid" / "Received" on a scheduled occurrence: confirm the amount (bills vary) and record it.
export async function payBill(id, occ) {
  const r = (await api('GET', '/api/recurring')).find((x) => x.id === id);
  if (!r) return;
  modal(`${r.kind === 'income' ? 'Received' : 'Paid'}: ${r.name}`, `<form><p class="muted">Due ${fmtDate(occ, { weekday: 'short', month: 'short', day: 'numeric' })}${r.item_name ? ` · goes to ${esc(r.item_name)}` : ''}</p>
    <label class="amount"><span>$</span><input name="amount" inputmode="decimal" value="${toInput(r.amount)}" autofocus></label>
    <div class="grid2"><label>Date ${r.kind === 'income' ? 'received' : 'paid'}<input name="date" type="date" value="${occ <= state.today ? occ : state.today}"></label><label>Account<select name="account_id">${accountOptions(r.account_id, { blank: true })}</select></label></div>
    <div class="row end"><button type="button" class="btn" id="skip">Skip this one</button><span class="sp"></span><button class="btn primary">Mark ${r.kind === 'income' ? 'received' : 'paid'}</button></div></form>`, (m, close) => {
    const f = $('form', m);
    f.onsubmit = async (e) => { e.preventDefault(); try { await api('POST', `/api/recurring/${id}/pay`, { occ_date: occ, amount: fromInput(f.amount.value), date: f.date.value, account_id: +f.account_id.value || null }); close(); toast(`${r.name} ✓`); refresh(); } catch (err) { toast(err.message, 'err'); } };
    $('#skip', m).onclick = async () => { await api('POST', `/api/recurring/${id}/skip`, { occ_date: occ }); close(); toast('Skipped', '', { label: 'Undo', run: async () => { await api('POST', `/api/recurring/${id}/skip`, { occ_date: occ, undo: true }); refresh(); } }); refresh(); };
  }, 'small');
}
