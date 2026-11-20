// Monthly zero-based budget (envelopes) and the whole-year planning grid.
import { $, $$, esc, api, state, toast, modal, confirmBox, money, money0, toInput, fromInput, LS, itemOptions, loadLayout, bar, go, monthName, shortMonth, fmtDate, curMonth, clampMonth, isPhone, B } from './core.js';
import { txnEditor, txRow, bindTxRows, refresh, quickAdd } from './app.js';

const plainMoney = (c) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SWATCH = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#52514e', '#d95926'];

export async function budgetView(main, [m]) {
  const s = state.settings;
  const month = clampMonth(B.isMonth(m) ? m : curMonth());
  const v = await api('GET', `/api/budget/${month}`);
  const sm = v.summary, ltb = sm.leftToBudget;
  const editing = LS.get('ledger.editLayout', false);
  const col = LS.get('ledger.col', 'available');
  const months = B.monthsBetween(s.start_month, s.end_month);
  main.innerHTML = `<div class="page budget ${editing ? 'editing' : ''} col-${col}">
    <header class="phead monthbar">
      <button class="iconbtn big" id="prev" ${month <= s.start_month ? 'disabled' : ''} aria-label="Previous month">‹</button>
      <h1 class="mtitle"><select id="msel">${months.map((x) => `<option value="${x}" ${x === month ? 'selected' : ''}>${monthName(x)}</option>`).join('')}</select></h1>
      <button class="iconbtn big" id="next" ${month >= s.end_month ? 'disabled' : ''} aria-label="Next month">›</button>
      <span class="sp"></span>
      <div class="menuwrap"><button class="btn" id="tools">Plan tools ▾</button></div>
      <button class="btn ${editing ? 'on' : ''}" id="edit">${editing ? '✓ Done' : '✎ Customize'}</button>
    </header>
    <div class="mstrip">${months.map((x) => `<a href="#/budget/${x}" class="${x === month ? 'on' : ''} ${x === curMonth() ? 'now' : ''}">${shortMonth(x)}<small>${x.slice(2, 4)}</small></a>`).join('')}</div>
    <div class="summary">
      <div class="ltb ${ltb === 0 ? 'good' : ltb < 0 ? 'badt' : 'warnt'}"><span class="lbl">Left to budget</span><b>${money(ltb)}</b><span class="sub">${ltb === 0 ? '✓ Every dollar has a job' : ltb > 0 ? 'Assign it to a category' : 'Over-budgeted – trim somewhere'}</span></div>
      <div><span class="lbl">Income planned</span><b>${money0(sm.incomePlanned)}</b><span class="sub">received ${money0(sm.incomeReceived)}</span></div>
      <div><span class="lbl">Budgeted</span><b>${money0(sm.planned)}</b><span class="sub">${sm.carry ? `+ ${money0(sm.carry)} carried in` : '&nbsp;'}</span></div>
      <div><span class="lbl">Spent</span><b>${money0(sm.spent)}</b>${bar(sm.planned + sm.carry ? sm.spent / (sm.planned + sm.carry) * 100 : 0, sm.spent > sm.planned + sm.carry ? 'over' : '')}</div>
      <div><span class="lbl">Remaining</span><b class="${sm.available < 0 ? 'neg' : ''}">${money0(sm.available)}</b><span class="sub ${sm.overspent ? 'neg' : ''}">${sm.overspent ? `${money0(sm.overspent)} overspent` : '&nbsp;'}</span></div>
    </div>
    ${v.uncategorized.count ? `<a class="callout warn" href="#/inbox">🗂️ ${v.uncategorized.count} transaction${v.uncategorized.count > 1 ? 's' : ''} this month (${money(v.uncategorized.amount)}) need a category – they aren't counted in any envelope yet.</a>` : ''}
    ${sm.planned === 0 && sm.incomePlanned === 0 ? `<div class="callout"><b>${monthName(month)} is empty.</b> Start by entering your expected income, then give every dollar a job. ${month > s.start_month ? '<button class="btn sm" id="copyLast">Copy last month’s plan</button>' : ''}</div>` : ''}
    <div class="colpick seg"><button data-c="planned">Planned</button><button data-c="spent">Spent</button><button data-c="available">Remaining</button></div>
    <div class="groups">${v.groups.map((g) => groupCard(g, month)).join('')}</div>
    <div class="row center"><button class="btn" id="addGroup">＋ Add group</button>${editing ? '<button class="btn" id="archived">Archived items…</button>' : ''}</div>
  </div>`;

  const goMonth = (x) => go(`/budget/${x}`);
  $('#prev').onclick = () => goMonth(B.addMonths(month, -1));
  $('#next').onclick = () => goMonth(B.addMonths(month, 1));
  $('#msel').onchange = (e) => goMonth(e.target.value);
  $('.mstrip .on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  $('#edit').onclick = () => { LS.set('ledger.editLayout', !editing); budgetView(main, [month]); };
  $$('.colpick button').forEach((b) => { b.classList.toggle('on', b.dataset.c === col); b.onclick = () => { LS.set('ledger.col', b.dataset.c); budgetView(main, [month]); }; });
  $('#tools').onclick = () => planTools(month);
  $('#copyLast') && ($('#copyLast').onclick = () => fill(month, 'last', true));
  $('#addGroup').onclick = () => groupEditor();
  $('#archived') && ($('#archived').onclick = archivedItems);

  // Inline planned-amount editing (Enter / Tab moves to the next line).
  $$('input.plan').forEach((inp) => {
    const save = async () => {
      const c = fromInput(inp.value);
      if (c === +inp.dataset.v) return;
      inp.dataset.v = c;
      inp.classList.add('saving');
      try { await api('PUT', '/api/plans', { month, item_id: +inp.dataset.id, amount: c }); await budgetView(main, [month]); const n = $(`input.plan[data-id="${inp.dataset.id}"]`); if (document.activeElement === document.body && n && inp.dataset.next) $(`input.plan[data-id="${inp.dataset.next}"]`)?.focus(); }
      catch (e) { toast(e.message, 'err'); }
    };
    inp.onfocus = () => { inp.select(); setTimeout(() => inp.select(), 0); };
    inp.onblur = () => { save(); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const all = $$('input.plan'); const nx = all[all.indexOf(inp) + 1]; inp.dataset.next = nx?.dataset.id || ''; nx ? nx.focus() : inp.blur(); } if (e.key === 'Escape') { inp.value = plainMoney(+inp.dataset.v); inp.blur(); } };
  });
  $$('.irow .iname').forEach((el) => (el.onclick = () => itemDetail(+el.closest('.irow').dataset.id, month, v)));
  $$('.irow .avail').forEach((el) => (el.onclick = () => itemDetail(+el.closest('.irow').dataset.id, month, v)));
  $$('.addItem').forEach((b) => (b.onclick = () => itemEditor({ group_id: +b.dataset.g }, month)));
  $$('.gmenu').forEach((b) => (b.onclick = () => groupEditor(state.layout.groups.find((g) => g.id === +b.dataset.g))));
  $$('.mv').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); moveMoney(month, v, b.dataset.dir === 'from' ? +b.dataset.id : null, b.dataset.dir === 'to' ? +b.dataset.id : null); }));
  // Customize mode: reorder groups and items.
  $$('.gup, .gdown').forEach((b) => (b.onclick = async () => {
    const ids = v.groups.map((g) => g.id), i = ids.indexOf(+b.dataset.g), j = i + (b.classList.contains('gup') ? -1 : 1);
    if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('POST', '/api/groups/reorder', { ids }); await loadLayout(); budgetView(main, [month]);
  }));
  $$('.iup, .idown').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const g = v.groups.find((x) => x.items.some((i) => i.id === +b.dataset.id)), ids = g.items.map((i) => i.id), i = ids.indexOf(+b.dataset.id), j = i + (b.classList.contains('iup') ? -1 : 1);
    if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('POST', '/api/items/reorder', { ids }); await loadLayout(); budgetView(main, [month]);
  }));
}

function groupCard(g, month) {
  const inc = g.kind === 'income';
  const t = g.totals;
  return `<section class="group card ${inc ? 'income' : ''}" style="--gc:${esc(g.color)}">
    <div class="ghead"><span class="gname">${esc(g.emoji)} ${esc(g.name)}${g.is_debt ? ' <a class="tag" href="#/debts">snowball ›</a>' : ''}</span>
      <span class="edit-only"><button class="iconbtn gup" data-g="${g.id}" title="Move up">↑</button><button class="iconbtn gdown" data-g="${g.id}" title="Move down">↓</button></span>
      <span class="sp"></span><button class="iconbtn gmenu" data-g="${g.id}" title="Group settings">⋯</button></div>
    <div class="irow head"><span class="iname">${inc ? 'Source' : 'Category'}</span><span class="c-planned">Planned</span><span class="c-spent">${inc ? 'Received' : 'Spent'}</span><span class="c-available">${inc ? 'Still expected' : 'Remaining'}</span></div>
    ${g.items.map((i) => itemRow(i, inc)).join('')}
    <div class="irow foot"><span class="iname"><button class="linkbtn addItem" data-g="${g.id}">＋ Add ${inc ? 'income' : 'item'}</button></span><span class="c-planned">${money0(t.planned)}</span><span class="c-spent">${money0(t.spent)}</span><span class="c-available ${!inc && t.available < 0 ? 'neg' : ''}">${money0(inc ? t.planned - t.spent : t.available)}</span></div>
  </section>`;
}
function itemRow(i, inc) {
  const budget = i.planned + i.carry;
  const pct = inc ? (i.planned ? i.spent / i.planned * 100 : 0) : budget > 0 ? i.spent / budget * 100 : i.spent > 0 ? 100 : 0;
  const cls = inc ? 'good' : i.available < 0 ? 'over' : i.available === 0 && i.spent > 0 ? 'done' : pct >= 85 ? 'low' : '';
  const remaining = inc ? i.planned - i.spent : i.available;
  const meta = [
    i.rollover ? `<span title="Rolls over: leftovers carry to next month">↻${i.carry ? ` ${money0(i.carry)}` : ''}</span>` : '',
    i.bills.length ? `<span>📅 ${i.bills.map((b) => b.dates.map((d) => fmtDate(d, { day: 'numeric' })).join(', ')).join(' · ')}${i.bills.some((b) => b.autopay) ? ' auto' : ''}</span>` : i.due_day ? `<span>📅 ${i.due_day}</span>` : '',
    i.debt ? `<span>⛓️ ${money0(i.debt.current)} owed</span>` : '',
    i.goal ? `<span>🎯 ${i.goal.pct}% of ${money0(i.goal.amount)}${i.goal.monthly ? ` · ${money0(i.goal.monthly)}/mo` : ''}</span>` : '',
  ].filter(Boolean).join('');
  return `<div class="irow ${cls}" data-id="${i.id}">
    <span class="iname"><span class="edit-only"><button class="iconbtn sm iup" data-id="${i.id}">↑</button><button class="iconbtn sm idown" data-id="${i.id}">↓</button></span><span class="em">${esc(i.emoji || '•')}</span><span class="nm">${esc(i.name)}${meta ? `<small class="meta">${meta}</small>` : ''}</span></span>
    <span class="c-planned"><input class="plan" inputmode="decimal" data-id="${i.id}" data-v="${i.planned}" value="${plainMoney(i.planned)}" aria-label="Planned for ${esc(i.name)}"></span>
    <span class="c-spent">${money(i.spent)}</span>
    <span class="c-available avail"><b class="${!inc && remaining < 0 ? 'neg' : ''}">${money(remaining)}</b>${bar(pct, cls)}</span>
  </div>`;
}

// ---- plan tools
function planTools(month) {
  const s = state.settings;
  const rest = B.monthsBetween(B.addMonths(month, 1), s.end_month);
  modal(`Plan tools · ${monthName(month)}`, `<div class="tools">
    <button class="tool" data-mode="last"><b>📋 Copy last month's plan</b><span>Fill ${monthName(month, 'short')} with what you planned in ${monthName(B.addMonths(month, -1), 'short')}.</span></button>
    <button class="tool" data-mode="spent"><b>🧾 Use last month's actual spending</b><span>Plan each category at what you really spent last month.</span></button>
    <button class="tool" data-mode="average"><b>📊 3-month average</b><span>Plan each category at its average spending over the last 3 months.</span></button>
    <button class="tool" data-mode="default"><b>⭐ Default amounts</b><span>Each category's default (set in its details).</span></button>
    <button class="tool" data-mode="goal"><b>🎯 Fund savings goals</b><span>Set categories with a goal date to the monthly amount needed.</span></button>
    <label class="check"><input type="checkbox" id="onlyEmpty" checked> Only fill lines that are still $0</label>
    <hr>
    <button class="tool" data-copyfwd="1"><b>⏩ Copy ${monthName(month, 'short')} to the rest of the year</b><span>Put this month's plan into ${rest.length ? `${monthName(rest[0], 'short')} – ${monthName(rest.at(-1), 'short')}` : 'later months'} (${rest.length} month${rest.length === 1 ? '' : 's'}).</span></button>
    <button class="tool" data-move="1"><b>🔀 Move money between categories</b><span>Cover overspending or shift a surplus.</span></button>
    <button class="tool danger" data-mode="zero"><b>🧹 Clear this month's plan</b><span>Reset every planned amount to $0.</span></button></div>`, (m, close) => {
    $$('[data-mode]', m).forEach((b) => (b.onclick = async () => {
      if (b.dataset.mode === 'zero' && !(await confirmBox('Clear plan', `Set every planned amount in ${monthName(month)} to $0?`, 'Clear', true))) return;
      close(); fill(month, b.dataset.mode, b.dataset.mode === 'zero' ? false : $('#onlyEmpty', m).checked);
    }));
    $('[data-copyfwd]', m).onclick = async () => {
      if (!rest.length) return toast('This is the last month in your budget range');
      const only = $('#onlyEmpty', m).checked;
      if (!(await confirmBox('Copy forward', `Copy ${monthName(month)}'s plan into ${rest.length} later month(s)${only ? ' (only lines that are still $0)' : ' (overwrites them)'}?`, 'Copy'))) return;
      close();
      const v = await api('GET', `/api/budget/${month}`);
      const items = v.groups.flatMap((g) => g.items.map((i) => ({ item_id: i.id, amount: i.planned })));
      if (only) await api('POST', '/api/plans/fill', { months: rest, mode: 'last', only_empty: true });
      else await api('PUT', '/api/plans', { months: rest, items });
      toast(`Copied to ${rest.length} month(s)`); refresh();
    };
    $('[data-move]', m).onclick = async () => { close(); moveMoney(month, await api('GET', `/api/budget/${month}`)); };
  });
}
async function fill(month, mode, only) {
  const r = await api('POST', '/api/plans/fill', { month, mode, only_empty: only });
  toast(r.changed ? `Updated ${r.changed} line${r.changed > 1 ? 's' : ''}` : 'Nothing to change'); refresh();
}

function moveMoney(month, v, fromId = null, toId = null) {
  const list = v.groups.filter((g) => g.kind !== 'income').flatMap((g) => g.items);
  const opts = (sel) => list.map((i) => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(`${i.emoji} ${i.name}`)} (${money(i.available)})</option>`).join('');
  const over = list.find((i) => i.id === toId && i.available < 0);
  modal('Move money', `<form><label>From<select name="from"><option value="">Left to budget (${money(v.summary.leftToBudget)})</option>${opts(fromId)}</select></label>
    <label>To<select name="to" required><option value="">Pick…</option>${opts(toId)}</select></label>
    <label class="amount"><span>$</span><input name="amount" inputmode="decimal" value="${over ? toInput(-over.available) : ''}" autofocus required></label>
    <p class="muted small">This changes the planned amounts for ${monthName(month)} – the total budget stays the same.</p><div class="row end"><button class="btn primary">Move</button></div></form>`, (m, close) => {
    const f = $('form', m);
    f.onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/plans/move', { month, from: +f.from.value || null, to: +f.to.value, amount: fromInput(f.amount.value) }); close(); toast('Moved'); refresh(); } catch (err) { toast(err.message, 'err'); } };
  }, 'small');
}

// ---- item details & editor
async function itemDetail(id, month, v) {
  const it = v.groups.flatMap((g) => g.items.map((i) => ({ ...i, gkind: g.kind, gid: g.id }))).find((i) => i.id === id);
  if (!it) return;
  const txns = await api('GET', `/api/txns?item=${id}&from=${month}-01&to=${B.lastDay(month)}`);
  const inc = it.gkind === 'income';
  modal(`${it.emoji} ${it.name}`, `<div class="istats">
      ${it.rollover ? `<div><span class="lbl">Carried in</span><b>${money(it.carry)}</b></div>` : ''}
      <div><span class="lbl">Planned</span><b>${money(it.planned)}</b></div><div><span class="lbl">${inc ? 'Received' : 'Spent'}</span><b>${money(it.spent)}</b></div>
      <div><span class="lbl">${inc ? 'Still expected' : 'Remaining'}</span><b class="${!inc && it.available < 0 ? 'neg' : ''}">${money(inc ? it.planned - it.spent : it.available)}</b></div>
      <div><span class="lbl">Last month</span><b>${money(it.last)}</b></div><div><span class="lbl">3-mo avg</span><b>${money(it.avg)}</b></div></div>
    ${it.goal ? `<div class="goal"><b>🎯 Goal ${money(it.goal.amount)}${it.goal.date ? ` by ${fmtDate(it.goal.date, { month: 'short', year: 'numeric' })}` : ''}</b>${bar(it.goal.pct, 'good')}<span class="muted small">${money(it.goal.saved)} saved${it.goal.monthly ? ` · plan ${money(it.goal.monthly)}/month to stay on track` : ''}</span></div>` : ''}
    ${it.note ? `<p class="note">${esc(it.note)}</p>` : ''}
    <div class="row wrap"><button class="btn primary" id="addtx">＋ ${inc ? 'Record income' : 'Log spending'}</button>${inc ? '' : '<button class="btn" id="mv">🔀 Move money</button>'}<button class="btn" id="rest">Use ${money(it.planned)} for rest of year</button><button class="btn" id="ed">✎ Edit</button></div>
    <h4>${monthName(month)} · ${txns.length} transaction${txns.length === 1 ? '' : 's'}</h4>
    ${txns.length ? `<ul class="list txlist">${txns.map(txRow).join('')}</ul>` : '<p class="muted">None yet.</p>'}`, (m, close) => {
    bindTxRows(m);
    $('#addtx', m).onclick = () => { close(); quickAdd({ item_id: id, kind: inc ? 'income' : 'expense' }); };
    $('#mv', m) && ($('#mv', m).onclick = () => { close(); moveMoney(month, v, it.available > 0 ? id : null, it.available < 0 ? id : null); });
    $('#ed', m).onclick = () => { close(); itemEditor(it, month); };
    $('#rest', m).onclick = async () => {
      const months = B.monthsBetween(B.addMonths(month, 1), state.settings.end_month);
      if (!months.length) return toast('No later months in range');
      await api('PUT', '/api/plans', { months, item_id: id, amount: it.planned });
      close(); toast(`${it.name}: ${money(it.planned)} planned through ${monthName(months.at(-1), 'short')}`); refresh();
    };
  });
}
export function itemEditor(it, month) {
  const isNew = !it.id;
  const groups = state.layout.groups.filter((g) => !g.archived);
  modal(isNew ? 'Add budget item' : `Edit ${it.name}`, `<form class="grid2">
    <label>Name<input name="name" value="${esc(it.name || '')}" required autofocus></label>
    <label>Emoji<input name="emoji" value="${esc(it.emoji || '')}" maxlength="8" placeholder="🛒"></label>
    <label>Group<select name="group_id">${groups.map((g) => `<option value="${g.id}" ${(it.group_id || it.gid) === g.id ? 'selected' : ''}>${esc(`${g.emoji} ${g.name}`)}</option>`).join('')}</select></label>
    ${isNew ? `<label>Planned for ${monthName(month, 'short')}<input name="amount" inputmode="decimal" placeholder="0.00"></label>` : ''}
    <label>Default monthly amount<input name="default_amount" inputmode="decimal" value="${toInput(it.default_amount || 0)}" placeholder="0.00"></label>
    <label>Due day (bills)<input name="due_day" type="number" min="1" max="31" value="${it.due_day || ''}" placeholder="—"></label>
    <label class="check full"><input type="checkbox" name="rollover" ${it.rollover ? 'checked' : ''}> <span><b>Roll over</b> – leftovers carry into next month and overspending comes out of it (true envelope / sinking fund)</span></label>
    <label>Savings goal<input name="goal_amount" inputmode="decimal" value="${toInput(it.goal_amount || 0)}" placeholder="e.g. 1000"></label>
    <label>Goal date<input name="goal_date" type="date" value="${it.goal_date || ''}"></label>
    <label class="full">Other names for quick add<input name="aliases" value="${esc(it.aliases || '')}" placeholder="e.g. walmart, costco, heb"><small class="muted">Comma-separated. “42 walmart” will land here.</small></label>
    <label class="full">Notes<textarea name="note" rows="2">${esc(it.note || '')}</textarea></label>
    <div class="row end full">${isNew ? '' : '<button type="button" class="btn danger" id="del">Delete…</button><span class="sp"></span>'}<button class="btn primary">Save</button></div></form>`, (m, close) => {
    const f = $('form', m);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const b = { name: f.name.value, emoji: f.emoji.value, group_id: +f.group_id.value, default_amount: fromInput(f.default_amount.value), due_day: f.due_day.value || null, rollover: f.rollover.checked,
        goal_amount: f.goal_amount.value ? fromInput(f.goal_amount.value) : null, goal_date: f.goal_date.value || null, aliases: f.aliases.value, note: f.note.value };
      if (isNew) Object.assign(b, { month, amount: fromInput(f.amount.value) });
      try { await api(isNew ? 'POST' : 'PATCH', isNew ? '/api/items' : `/api/items/${it.id}`, b); close(); await loadLayout(); refresh(); } catch (err) { toast(err.message, 'err'); }
    };
    if (!isNew) $('#del', m).onclick = () => { close(); deleteItem(it); };
  });
}
function deleteItem(it) {
  modal(`Delete ${it.name}`, `<p>If it has transactions you can move them to another category, or archive it instead (keeps history, hides it from the budget).</p>
    <label>Move its transactions to<select id="to">${itemOptions('', { none: '— don’t move —' })}</select></label>
    <div class="row end"><button class="btn" id="arch">Archive</button><button class="btn danger solid" id="del">Delete</button></div>`, (m, close) => {
    $('#arch', m).onclick = async () => { await api('PATCH', `/api/items/${it.id}`, { archived: true }); close(); await loadLayout(); refresh(); toast('Archived'); };
    $('#del', m).onclick = async () => { const to = $('#to', m).value; const r = await api('DELETE', `/api/items/${it.id}${to ? `?to=${to}` : ''}`); close(); await loadLayout(); refresh(); toast(r.archived ? 'It has transactions, so it was archived instead' : 'Deleted'); };
  }, 'small');
}
function archivedItems() {
  const list = state.layout.items.filter((i) => i.archived || i.group_archived);
  modal('Archived', list.length ? `<ul class="list">${list.map((i) => `<li><span class="grow">${esc(`${i.emoji} ${i.name}`)} <span class="muted small">${esc(i.group_name)}</span></span><button class="btn sm" data-id="${i.id}" data-g="${i.group_archived ? i.group_id : ''}">Restore</button></li>`).join('')}</ul>` : '<p class="muted">Nothing archived.</p>', (m, close) => {
    $$('[data-id]', m).forEach((b) => (b.onclick = async () => { if (b.dataset.g) await api('PATCH', `/api/groups/${b.dataset.g}`, { archived: false }); await api('PATCH', `/api/items/${b.dataset.id}`, { archived: false }); close(); await loadLayout(); refresh(); }));
  });
}
function groupEditor(g = null) {
  modal(g ? `Edit ${g.name}` : 'Add group', `<form class="grid2"><label>Name<input name="name" value="${esc(g?.name || '')}" required autofocus></label><label>Emoji<input name="emoji" value="${esc(g?.emoji || '')}" maxlength="8"></label>
    ${g ? '' : '<label>Type<select name="kind"><option value="expense">Spending / saving</option><option value="income">Income</option></select></label>'}
    <div class="full"><span class="lbl">Color</span><div class="swatches">${SWATCH.map((c) => `<label><input type="radio" name="color" value="${c}" ${(g?.color || SWATCH[0]) === c ? 'checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div></div>
    <div class="row end full">${g ? `<button type="button" class="btn danger" id="del">Delete group</button><span class="sp"></span>` : ''}<button class="btn primary">Save</button></div></form>`, (m, close) => {
    const f = $('form', m);
    f.onsubmit = async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(f)); await api(g ? 'PATCH' : 'POST', g ? `/api/groups/${g.id}` : '/api/groups', b); close(); await loadLayout(); refresh(); };
    if (g) $('#del', m).onclick = async () => {
      if (!(await confirmBox('Delete group', `Delete “${esc(g.name)}” and its items? Groups with transactions are archived instead so history is kept.`, 'Delete', true))) return;
      const r = await api('DELETE', `/api/groups/${g.id}`); close(); await loadLayout(); refresh(); toast(r.archived ? 'Archived (it has transactions)' : 'Deleted');
    };
  }, 'small');
}

// ================================================================== Year plan grid
export async function yearView(main) {
  const mode = LS.get('ledger.ymode', 'planned');
  const y = await api('GET', '/api/year');
  const cm = curMonth();
  const cell = (c, inc) => mode === 'planned' ? c.planned : mode === 'spent' ? c.spent : inc ? c.planned - c.spent : c.available;
  main.innerHTML = `<div class="page yearpage"><header class="phead"><h1>Year plan</h1><span class="muted">${monthName(y.months[0])} – ${monthName(y.months.at(-1))}</span><span class="sp"></span>
    <div class="seg" id="ym">${[['planned', 'Planned'], ['spent', 'Actual'], ['available', 'Remaining']].map(([k, l]) => `<button data-k="${k}" class="${mode === k ? 'on' : ''}">${l}</button>`).join('')}</div></header>
    <p class="muted small">${mode === 'planned' ? 'Type to plan any month – Enter moves down, Tab moves right. Changes save instantly.' : mode === 'spent' ? 'What actually happened each month.' : 'Envelope balances at the end of each month (rollover categories carry forward).'}</p>
    <div class="yearwrap"><table class="year"><thead><tr><th class="sticky">Category</th>${y.months.map((m) => `<th class="${m === cm ? 'now' : ''}"><a href="#/budget/${m}">${shortMonth(m)} ${m.slice(2, 4)}</a></th>`).join('')}<th>Total</th></tr></thead><tbody>
    ${y.groups.map((g) => {
      const inc = g.kind === 'income';
      const sums = y.months.map((_, k) => g.items.reduce((s, i) => s + cell(i.months[k], inc), 0));
      return `<tr class="gr" style="--gc:${esc(g.color)}"><th class="sticky">${esc(g.emoji)} ${esc(g.name)}</th>${sums.map((v) => `<td>${money0(v)}</td>`).join('')}<td>${money0(sums.reduce((a, b) => a + b, 0))}</td></tr>` +
        g.items.map((i) => `<tr><th class="sticky sub">${esc(i.emoji)} ${esc(i.name)}${i.rollover ? ' <span class="muted">↻</span>' : ''}</th>${i.months.map((c, k) => {
          const v = cell(c, inc);
          return mode === 'planned' ? `<td><input class="yc" data-id="${i.id}" data-m="${y.months[k]}" data-v="${c.planned}" value="${c.planned ? toInput(c.planned) : ''}" placeholder="–" inputmode="decimal"></td>`
            : `<td class="${!inc && v < 0 ? 'neg' : ''}">${v ? money0(v) : '<span class="muted">–</span>'}</td>`;
        }).join('')}<td>${mode === 'available' ? '' : money0(i.months.reduce((s, c) => s + cell(c, inc), 0))}</td></tr>`).join('');
    }).join('')}
    </tbody><tfoot>
      <tr><th class="sticky">Income planned</th>${y.totals.map((t) => `<td>${money0(t.incomePlanned)}</td>`).join('')}<td>${money0(y.totals.reduce((a, t) => a + t.incomePlanned, 0))}</td></tr>
      <tr><th class="sticky">Budgeted</th>${y.totals.map((t) => `<td>${money0(t.planned)}</td>`).join('')}<td>${money0(y.totals.reduce((a, t) => a + t.planned, 0))}</td></tr>
      <tr class="ltbrow"><th class="sticky">Left to budget</th>${y.totals.map((t) => `<td class="${t.leftToBudget === 0 ? 'pos' : t.leftToBudget < 0 ? 'neg' : 'warn'}">${t.leftToBudget === 0 ? '✓' : money0(t.leftToBudget)}</td>`).join('')}<td></td></tr>
      <tr><th class="sticky">Spent</th>${y.totals.map((t) => `<td>${money0(t.spent)}</td>`).join('')}<td>${money0(y.totals.reduce((a, t) => a + t.spent, 0))}</td></tr>
      <tr><th class="sticky">Income received</th>${y.totals.map((t) => `<td>${money0(t.incomeReceived)}</td>`).join('')}<td>${money0(y.totals.reduce((a, t) => a + t.incomeReceived, 0))}</td></tr>
    </tfoot></table></div></div>`;
  $$('#ym button').forEach((b) => (b.onclick = () => { LS.set('ledger.ymode', b.dataset.k); yearView(main); }));
  const inputs = $$('input.yc');
  const cols = y.months.length;
  inputs.forEach((inp, idx) => {
    inp.onfocus = () => setTimeout(() => inp.select(), 0);
    inp.onchange = async () => {
      const c = fromInput(inp.value);
      try { await api('PUT', '/api/plans', { month: inp.dataset.m, item_id: +inp.dataset.id, amount: c }); inp.dataset.v = c; inp.classList.add('saved'); setTimeout(() => inp.classList.remove('saved'), 800); updateFooter(); }
      catch (e) { toast(e.message, 'err'); }
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.dispatchEvent(new Event('change')); inputs[idx + cols]?.focus(); } };
  });
  const updateFooter = async () => { const sc = $('.yearwrap').scrollLeft, st = window.scrollY, fid = document.activeElement?.dataset; await yearView(main); $('.yearwrap').scrollLeft = sc; window.scrollTo(0, st); if (fid?.id) $(`input.yc[data-id="${fid.id}"][data-m="${fid.m}"]`)?.focus(); };
  const now = $('th.now'); if (now) $('.yearwrap').scrollLeft = Math.max(0, now.offsetLeft - 220);
}
