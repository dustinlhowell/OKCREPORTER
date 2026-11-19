// Money calendar: month grid (spending, bills, paydays, debt due dates, projected cash), agenda with cash-flow chart, and a year heatmap.
import { $, $$, esc, api, state, modal, money, money0, LS, go, monthName, fmtDate, weekday, curMonth, isPhone, B } from './core.js';
import { quickAdd, txnEditor, upRow, bindUpRows } from './app.js';
import { lineChart, heatLevel } from './charts.js';

const icon = (s) => (s.kind === 'income' ? '💵' : s.type === 'debt' ? '⛓️' : s.kind === 'transfer' ? '🔁' : '🧾');

export async function calendarView(main, [mode0, arg]) {
  const mode = ['month', 'agenda', 'year'].includes(mode0) ? mode0 : LS.get('ledger.calmode', isPhone() ? 'agenda' : 'month');
  LS.set('ledger.calmode', mode);
  main.innerHTML = `<div class="page cal"><header class="phead"><h1>Calendar</h1><span class="sp"></span>
    <div class="seg" id="cm">${[['month', 'Month'], ['agenda', 'Agenda'], ['year', 'Year']].map(([k, l]) => `<button data-k="${k}" class="${k === mode ? 'on' : ''}">${l}</button>`).join('')}</div></header><div id="cbody"></div></div>`;
  $$('#cm button').forEach((b) => (b.onclick = () => go(`/calendar/${b.dataset.k}`)));
  const body = $('#cbody');
  if (mode === 'month') return monthGrid(body, B.isMonth(arg) ? arg : curMonth());
  if (mode === 'agenda') return agenda(body);
  return yearHeat(body);
}

// ---------------------------------------------------------------- month grid
async function monthGrid(body, month) {
  const layers = LS.get('ledger.layers', { spend: true, bills: true, cash: true });
  const ws = state.settings.week_start;
  const first = `${month}-01`, last = B.lastDay(month);
  const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
  const gridFrom = B.addDays(first, -((dow(first) - ws + 7) % 7));
  const gridTo = B.addDays(last, (6 - (dow(last) - ws + 7) % 7));
  const data = await api('GET', `/api/calendar?from=${gridFrom}&to=${gridTo}`);
  const byDay = new Map();
  const day = (d) => byDay.get(d) || byDay.set(d, { txns: [], sched: [], spent: 0, income: 0 }).get(d);
  for (const t of data.txns) { const x = day(t.date); x.txns.push(t); if (t.kind === 'expense') x.spent += t.amount; else if (t.kind === 'income') x.income += t.amount; }
  for (const s of data.scheduled) day(s.date).sched.push(s);
  const cash = new Map(data.cashflow.days.map((d) => [d.date, d]));
  const monthSpent = data.txns.filter((t) => t.kind === 'expense' && t.date.startsWith(month)).reduce((a, t) => a + t.amount, 0);
  const monthIncome = data.txns.filter((t) => t.kind === 'income' && t.date.startsWith(month)).reduce((a, t) => a + t.amount, 0);
  const billsLeft = data.scheduled.filter((s) => s.date.startsWith(month) && s.kind !== 'income' && s.status !== 'paid' && s.status !== 'skipped').reduce((a, s) => a + s.amount, 0);
  const names = ws ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = []; for (let d = gridFrom; d <= gridTo; d = B.addDays(d, 1)) days.push(d);
  body.innerHTML = `<div class="calbar"><button class="iconbtn big" id="pm">‹</button><h2>${monthName(month)}</h2><button class="iconbtn big" id="nm">›</button><button class="btn sm" id="tm">Today</button><span class="sp"></span>
      <label class="check"><input type="checkbox" data-l="spend" ${layers.spend ? 'checked' : ''}> Spending</label><label class="check"><input type="checkbox" data-l="bills" ${layers.bills ? 'checked' : ''}> Bills & paydays</label><label class="check"><input type="checkbox" data-l="cash" ${layers.cash ? 'checked' : ''}> Cash balance</label></div>
    <div class="calsum"><span>Spent <b>${money0(monthSpent)}</b></span><span>Income <b class="pos">${money0(monthIncome)}</b></span><span>Bills still due <b>${money0(billsLeft)}</b></span>${data.cashflow.low && data.cashflow.low.date.startsWith(month) ? `<span>Lowest cash <b class="${data.cashflow.low.balance < 0 ? 'neg' : ''}">${money0(data.cashflow.low.balance)}</b> ${fmtDate(data.cashflow.low.date)}</span>` : ''}</div>
    <div class="mgrid">${names.map((n) => `<div class="dn">${n}</div>`).join('')}${days.map((d) => {
      const x = byDay.get(d) || { txns: [], sched: [], spent: 0, income: 0 }, c = cash.get(d);
      const out = d.slice(0, 7) !== month;
      return `<div class="dc ${out ? 'out' : ''} ${d === data.today ? 'today' : ''}" data-d="${d}"><div class="dnum">${+d.slice(8)}</div>
        ${layers.bills ? x.sched.slice(0, isPhone() ? 2 : 4).map((s) => `<div class="ev ${s.kind} ${s.status.replace(' ', '')}" title="${esc(`${s.name} ${money(s.amount)} – ${s.status}`)}">${s.status === 'paid' ? '✓' : icon(s)} <span>${esc(s.name)}</span> <b>${money0(s.amount)}</b></div>`).join('') + (x.sched.length > (isPhone() ? 2 : 4) ? `<div class="more">+${x.sched.length - (isPhone() ? 2 : 4)} more</div>` : '') : ''}
        ${layers.spend && (x.spent || x.income) ? `<div class="dtot">${x.income ? `<span class="pos">+${money0(x.income)}</span>` : ''}${x.spent ? `<span>−${money0(x.spent)}</span>` : ''}</div>` : ''}
        ${layers.cash && c ? `<div class="dbal ${c.balance < 0 ? 'neg' : ''} ${c.projected ? 'proj' : ''}" title="${c.projected ? 'Projected' : 'Actual'} cash at end of day">${money0(c.balance)}</div>` : ''}</div>`;
    }).join('')}</div>
    <p class="muted small">Cash balance = checking, savings & cash accounts at the end of each day. Future days (in italics) are projected from scheduled bills, paydays and debt minimums.</p>`;
  $('#pm', body).onclick = () => go(`/calendar/month/${B.addMonths(month, -1)}`);
  $('#nm', body).onclick = () => go(`/calendar/month/${B.addMonths(month, 1)}`);
  $('#tm', body).onclick = () => go(`/calendar/month/${curMonth()}`);
  $$('[data-l]', body).forEach((c) => (c.onchange = () => { layers[c.dataset.l] = c.checked; LS.set('ledger.layers', layers); monthGrid(body, month); }));
  $$('.dc', body).forEach((c) => (c.onclick = () => daySheet(c.dataset.d, byDay.get(c.dataset.d), cash.get(c.dataset.d))));
}

export async function daySheet(d, x, c) {
  x ||= { txns: [], sched: [] };
  modal(fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), `
    ${c ? `<p class="muted">${c.projected ? 'Projected' : 'Cash'} balance at end of day: <b class="${c.balance < 0 ? 'neg' : ''}">${money(c.balance)}</b></p>` : ''}
    ${x.sched.length ? `<h4>Scheduled</h4><ul class="list">${x.sched.map(upRow).join('')}</ul>` : ''}
    <h4>Transactions</h4>${x.txns.length ? `<ul class="list">${x.txns.map((t) => `<li class="dtx" data-id="${t.id}"><span class="grow"><b>${esc(t.payee || (t.kind === 'transfer' ? 'Transfer' : '(no payee)'))}</b><br><span class="muted small">${t.unc ? '<span class="tag warn">Needs category</span>' : esc(t.items || '')}${t.user_name && state.users.length > 1 ? ` · ${esc(t.user_name)}` : ''}</span></span><b class="${t.kind === 'income' ? 'pos' : ''}">${t.kind === 'income' ? '+' : t.kind === 'expense' ? '−' : ''}${money(t.amount)}</b></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}
    <div class="row end"><button class="btn primary" id="addday">＋ Add on this day</button></div>`, (m, close) => {
    bindUpRows(m);
    $$('.dtx', m).forEach((li) => (li.onclick = async () => { close(); txnEditor(await api('GET', `/api/txns/${li.dataset.id}`)); }));
    $('#addday', m).onclick = () => { close(); txnEditor(null, { date: d }); };
  });
}

// ---------------------------------------------------------------- agenda + cash-flow forecast
async function agenda(body) {
  const days = LS.get('ledger.agendaDays', 45);
  const t = state.today, to = B.addDays(t, days);
  const [data, past] = await Promise.all([api('GET', `/api/calendar?from=${B.addDays(t, -30)}&to=${to}`), api('GET', `/api/cashflow?from=${B.addDays(t, -30)}&to=${to}`)]);
  const sched = data.scheduled.filter((s) => s.date >= t || s.status === 'overdue');
  const byDate = new Map(); for (const s of sched) (byDate.get(s.date) || byDate.set(s.date, []).get(s.date)).push(s);
  const bal = new Map(past.days.map((d) => [d.date, d.balance]));
  const inc = sched.filter((s) => s.kind === 'income' && s.status !== 'paid').reduce((a, s) => a + s.amount, 0);
  const out = sched.filter((s) => s.kind === 'expense' && s.status !== 'paid' && s.status !== 'skipped').reduce((a, s) => a + (s.type === 'debt' ? Math.max(0, s.amount - (s.paid || 0)) : s.amount), 0);
  body.innerHTML = `<div class="calbar"><h2>Next ${days} days</h2><span class="sp"></span><div class="seg" id="ad">${[14, 30, 45, 90].map((n) => `<button data-n="${n}" class="${n === days ? 'on' : ''}">${n}d</button>`).join('')}</div></div>
    <div class="tiles"><div class="tile"><span class="lbl">Cash today</span><b>${money0(bal.get(t) ?? 0)}</b></div><div class="tile"><span class="lbl">Expected in</span><b class="pos">${money0(inc)}</b></div>
      <div class="tile"><span class="lbl">Bills & debt due</span><b>${money0(out)}</b></div><div class="tile ${past.low && past.low.balance < 0 ? 'badt' : ''}"><span class="lbl">Lowest point</span><b>${past.low ? money0(past.low.balance) : '–'}</b><span class="sub">${past.low ? fmtDate(past.low.date) : ''}</span></div></div>
    <section class="card"><h2>Cash-flow forecast</h2><div id="cfc"></div><p class="muted small">Solid = actual (last 30 days), dashed = projected from your scheduled bills and paydays.</p></section>
    <section class="card"><h2>Scheduled</h2>${byDate.size ? [...byDate].map(([d, list]) => `<h4 class="dhead">${d < t ? '❗ ' : ''}${fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' })}${bal.has(d) ? ` <span class="muted small">· cash after: <span class="${bal.get(d) < 0 ? 'neg' : ''}">${money0(bal.get(d))}</span></span>` : ''}</h4><ul class="list">${list.map(upRow).join('')}</ul>`).join('') : '<p class="muted">Nothing scheduled. <a href="#/bills">Add bills and paydays</a>.</p>'}</section>`;
  $$('#ad button', body).forEach((b) => (b.onclick = () => { LS.set('ledger.agendaDays', +b.dataset.n); agenda(body); }));
  bindUpRows(body);
  const pts = past.days.map((d) => ({ label: fmtDate(d.date), title: fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' }), value: d.balance, note: d.projected ? 'projected' : 'actual' }));
  lineChart($('#cfc', body), pts, { splitAt: past.days.findIndex((d) => d.date === t), full: (v) => money(v), height: 200 });
}

// ---------------------------------------------------------------- year heatmap
async function yearHeat(body) {
  const s = state.settings;
  const from = `${s.start_month}-01`, to = B.lastDay(s.end_month);
  const r = await api('GET', `/api/reports?from=${s.start_month}&to=${s.end_month}`);
  const daily = new Map(r.daily.map((d) => [d.date, d.v]));
  const vals = [...daily.values()].sort((a, b) => a - b);
  const max = vals.length ? vals[Math.floor(vals.length * 0.95)] || vals.at(-1) : 1;
  const sched = await api('GET', `/api/calendar?from=${state.today}&to=${B.addDays(state.today, 60) > to ? to : B.addDays(state.today, 60)}`).catch(() => ({ scheduled: [] }));
  const due = new Set(sched.scheduled.filter((x) => x.kind !== 'income' && x.status !== 'paid').map((x) => x.date));
  const months = B.monthsBetween(s.start_month, s.end_month);
  body.innerHTML = `<p class="muted">Daily spending across your budget year. Darker = more spent. Dots mark upcoming bills. Tap a day for details.</p>
    <div class="yheat">${months.map((m) => {
      const [y, mo] = m.split('-').map(Number), dim = B.daysIn(y, mo), lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() - s.week_start + 7) % 7;
      const tot = r.byGroup.find((g) => g.month === m)?.spent || 0;
      return `<div class="hm"><a href="#/calendar/month/${m}" class="hmt">${monthName(m)}</a><div class="hmg">${'<i class="pad"></i>'.repeat(lead)}${Array.from({ length: dim }, (_, k) => {
        const d = B.ymd(y, mo, k + 1), v = daily.get(d) || 0;
        return `<i class="l${heatLevel(v, max)} ${d === state.today ? 'today' : ''} ${due.has(d) ? 'due' : ''}" data-d="${d}" title="${esc(`${fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}: ${v ? money(v) + ' spent' : 'no spending'}${due.has(d) ? ' · bill due' : ''}`)}"></i>`;
      }).join('')}</div><div class="muted small">${money0(tot)} spent</div></div>`;
    }).join('')}</div>
    <div class="legend heatlegend">Less <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><i class="l5"></i> More</div>`;
  $$('.hmg i[data-d]', body).forEach((el) => (el.onclick = async () => {
    const d = el.dataset.d, c = await api('GET', `/api/calendar?from=${d}&to=${d}`);
    daySheet(d, { txns: c.txns, sched: c.scheduled }, c.cashflow.days[0]);
  }));
}
