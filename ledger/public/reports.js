// Reports: income vs spending, where the money went, planned vs actual, top payees, savings rate.
import { $, $$, esc, api, state, money, money0, LS, monthName, shortMonth, curMonth, B } from './core.js';
import { barChart, hbars } from './charts.js';

export async function reportsView(main) {
  const s = state.settings;
  const months = B.monthsBetween(s.start_month, s.end_month);
  const range = LS.get('ledger.rrange', 'all');
  const cm = curMonth() > s.end_month ? s.end_month : curMonth() < s.start_month ? s.start_month : curMonth();
  const [from, to] = range === 'month' ? [cm, cm] : range === 'last' ? [B.addMonths(cm, -1), B.addMonths(cm, -1)] : range === '3' ? [B.addMonths(cm, -2), cm] : [s.start_month, s.end_month];
  const r = await api('GET', `/api/reports?from=${from}&to=${to}`);
  const all = await api('GET', `/api/reports?from=${s.start_month}&to=${s.end_month}`);
  const groups = new Map(r.groups.map((g) => [g.id, g]));
  const tot = r.byGroup.reduce((a, m) => ({ income: a.income + m.income, spent: a.spent + m.spent, planned: a.planned + (m.month <= curMonth() ? m.planned : 0) }), { income: 0, spent: 0, planned: 0 });
  const gsum = new Map();
  for (const m of r.byGroup) for (const [gid, v] of Object.entries(m.groups)) { const x = gsum.get(+gid) || { spent: 0, planned: 0 }; x.spent += v.spent; x.planned += v.planned; gsum.set(+gid, x); }
  const unc = r.byGroup.reduce((a, m) => a + m.uncategorized, 0);
  const items = new Map(state.layout.items.map((i) => [i.id, i]));
  const saved = tot.income - tot.spent;
  main.innerHTML = `<div class="page reports viz-root"><header class="phead"><h1>Reports</h1><span class="sp"></span>
    <div class="seg" id="rr">${[['month', 'This month'], ['last', 'Last month'], ['3', '3 months'], ['all', 'Whole budget']].map(([k, l]) => `<button data-k="${k}" class="${range === k ? 'on' : ''}">${l}</button>`).join('')}</div></header>
    <p class="muted">${from === to ? monthName(from) : `${monthName(from)} – ${monthName(to)}`}</p>
    <div class="tiles"><div class="tile"><span class="lbl">Income</span><b class="pos">${money0(tot.income)}</b></div><div class="tile"><span class="lbl">Spent (incl. debt & savings)</span><b>${money0(tot.spent)}</b></div>
      <div class="tile"><span class="lbl">Difference</span><b class="${saved < 0 ? 'neg' : 'pos'}">${money0(saved)}</b><span class="sub">${tot.income ? `${Math.round(saved / tot.income * 100)}% of income` : ''}</span></div>
      <div class="tile"><span class="lbl">vs plan</span><b class="${tot.spent > tot.planned ? 'neg' : ''}">${money0(tot.planned - tot.spent)}</b><span class="sub">${tot.spent > tot.planned ? 'over' : 'under'} the ${money0(tot.planned)} planned</span></div></div>
    <section class="card"><h2>Income vs spending by month</h2><div id="ivs"></div></section>
    <div class="cols"><section class="card"><h2>Where the money went</h2>${hbars([...gsum].filter(([, v]) => v.spent > 0).sort((a, b) => b[1].spent - a[1].spent).map(([gid, v]) => ({ label: esc(`${groups.get(gid)?.emoji || ''} ${groups.get(gid)?.name || '?'}`), value: v.spent, color: groups.get(gid)?.color, sub: tot.spent ? `${Math.round(v.spent / tot.spent * 100)}%` : '' })).concat(unc ? [{ label: '🗂️ Needs category', value: unc, color: 'var(--mute)' }] : []), { fmt: money0 }) || '<p class="muted">No spending yet.</p>'}</section>
      <section class="card"><h2>Planned vs actual</h2><table class="pva"><thead><tr><th>Group</th><th>Planned</th><th>Actual</th><th>Diff</th></tr></thead><tbody>${[...gsum].sort((a, b) => (groups.get(a[0])?.sort ?? 0) - (groups.get(b[0])?.sort ?? 0)).map(([gid, v]) => `<tr><td>${esc(`${groups.get(gid)?.emoji || ''} ${groups.get(gid)?.name || ''}`)}</td><td>${money0(v.planned)}</td><td>${money0(v.spent)}</td><td class="${v.spent > v.planned ? 'neg' : 'pos'}">${money0(v.planned - v.spent)}</td></tr>`).join('')}</tbody></table></section></div>
    <div class="cols"><section class="card"><h2>Top categories</h2>${hbars(r.byItem.slice(0, 12).map((x) => { const it = items.get(x.item_id); return { label: esc(`${it?.emoji || ''} ${it?.name || '?'}`), value: x.v, color: groups.get(it?.group_id)?.color }; }), { fmt: money0 }) || '<p class="muted">Nothing yet.</p>'}</section>
      <section class="card"><h2>Top payees</h2>${r.payees.length ? `<ul class="list compact">${r.payees.map((p) => `<li><span class="grow">${esc(p.payee)} <span class="muted small">${p.n}×</span></span><b>${money(p.v)}</b></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</section></div>
    <p class="muted small">Spending includes debt payments and money moved to savings categories, so “Difference” is what's left unassigned or still in the bank. Refunds reduce spending.</p></div>`;
  $$('#rr button').forEach((b) => (b.onclick = () => { LS.set('ledger.rrange', b.dataset.k); reportsView(main); }));
  barChart($('#ivs'), all.byGroup.map((m) => `${shortMonth(m.month)} ${m.month.slice(2, 4)}`), [
    { name: 'Income', cls: 's1', values: all.byGroup.map((m) => m.income) },
    { name: 'Spending', cls: 's2', values: all.byGroup.map((m) => m.spent) },
  ], { full: (v) => money(v), titles: all.byGroup.map((m) => monthName(m.month)) });
}
