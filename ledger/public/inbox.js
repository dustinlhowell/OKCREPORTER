// Bank sync screens: the review tray ("New transactions"), subscriptions, bank settings, insights and net worth.
import { $, $$, esc, api, state, toast, modal, confirmBox, money, money0, itemOptions, accountOptions, itemById, fmtDate, monthName, shortMonth, B } from './core.js';
import { txnEditor, refresh } from './app.js';
import { billEditor } from './bills.js';
import { lineChart } from './charts.js';

const ago = (ms) => { if (!ms) return 'never'; const s = (Date.now() - ms) / 1000; return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

// ================================================================= review tray
export async function inboxView(main) {
  const [list, bank] = await Promise.all([api('GET', '/api/inbox'), api('GET', '/api/bank')]);
  const link = bank.links[0];
  const suggested = list.filter((t) => !t.reviewed && t.kind !== 'transfer' && !t.lines.some((l) => l.item_id) && t.suggest_item_id);
  main.innerHTML = `<div class="page inbox"><header class="phead"><h1>New transactions</h1>${list.length ? `<span class="badge">${list.length}</span>` : ''}<span class="sp"></span>
      ${link ? `<span class="muted small">Bank synced ${ago(link.last_ok)}</span><button class="btn" id="sync">↻ Sync</button>` : ''}
      ${suggested.length ? `<button class="btn primary" id="all">✓ Approve ${suggested.length} suggested</button>` : ''}</header>
    ${link?.last_error ? `<div class="callout warn">⚠️ Bank sync: ${esc(link.last_error)} <a href="#/settings">Settings ›</a></div>` : ''}
    ${!link ? `<div class="callout">Connect your bank in <a href="#/settings">Settings → Bank sync</a> and new purchases will show up here automatically for you to file into your budget.</div>` : ''}
    ${list.length ? `<p class="muted small">Tap the suggestion or pick a category to file each one. Ledger remembers your choices, so suggestions get better over time.</p><div class="tray">${list.map(card).join('')}</div>`
      : `<div class="empty card"><h2>All caught up 🎉</h2><p>Every transaction has a home in your budget.</p></div>`}</div>`;
  $('#sync') && ($('#sync').onclick = () => syncNow($('#sync')));
  $('#all') && ($('#all').onclick = async () => { const r = await api('POST', '/api/inbox/approve-suggested'); toast(`Filed ${r.approved}`); refresh(); });
  bindTray(main, list);
}
const card = (t) => {
  const inc = t.kind === 'income', tr = t.kind === 'transfer', cat = t.lines.find((l) => l.item_id);
  const sug = t.suggest_item_id && !cat ? itemById(t.suggest_item_id) : null;
  return `<div class="tcard" data-id="${t.id}"><div class="trow"><div class="grow"><b class="pn">${esc(t.payee || '(no payee)')}</b> <button class="iconbtn sm ren" title="Rename">✎</button>
      <div class="muted small">${fmtDate(t.date, { weekday: 'short', month: 'short', day: 'numeric' })}${t.account_name ? ` · ${esc(t.account_name)}` : ''}${t.raw_payee && t.raw_payee !== t.payee ? ` · <span class="raw">${esc(t.raw_payee)}</span>` : ''}</div></div>
      <b class="amt ${inc ? 'pos' : ''}">${inc ? '+' : tr ? '' : '−'}${money(t.amount)}</b></div>
    <div class="row wrap tacts">${tr ? `<span class="grow">⇄ Transfer: ${esc(t.account_name || '')} → ${esc(t.to_account_name || '')}</span><button class="btn primary sm ok">✓ Looks right</button>`
      : `${sug ? `<button class="btn primary sm sug" data-item="${sug.id}">✓ ${esc(`${sug.emoji ? sug.emoji + ' ' : ''}${sug.name}`)}</button>` : ''}${cat ? `<button class="btn primary sm ok">✓ ${esc(cat.item_name)}</button>` : ''}
        <select class="pick">${itemOptions('', { none: sug || cat ? 'Something else…' : 'Pick a category…', income: inc, expense: true })}</select>`}
      <span class="sp"></span><button class="iconbtn split" title="Split or edit">✂︎</button><button class="iconbtn del" title="Ignore (won’t come back)">🗑</button></div></div>`;
};
function bindTray(root, list) {
  const done = (el) => { el.classList.add('gone'); setTimeout(() => { el.remove(); if (!$('.tcard', root)) refresh(); }, 250); };
  const approve = async (el, body) => { await api('POST', '/api/inbox/approve', { items: [{ id: +el.dataset.id, ...body }] }); done(el); };
  $$('.tcard', root).forEach((el) => {
    const t = list.find((x) => x.id === +el.dataset.id);
    $('.sug', el) && ($('.sug', el).onclick = () => approve(el, { item_id: +$('.sug', el).dataset.item }));
    $('.ok', el) && ($('.ok', el).onclick = () => approve(el, {}));
    $('.pick', el) && ($('.pick', el).onchange = (e) => e.target.value && approve(el, { item_id: +e.target.value }));
    $('.split', el).onclick = () => txnEditor(t);
    $('.del', el).onclick = async () => { if (await confirmBox('Ignore transaction', `Remove ${esc(t.payee)} ${money(t.amount)}? ${t.bank_id ? 'It won’t be imported again.' : ''}`, 'Remove', true)) { await api('DELETE', `/api/txns/${t.id}`); done(el); } };
    $('.ren', el).onclick = () => modal('Rename payee', `<form><input name="p" value="${esc(t.payee)}" autofocus><p class="muted small">${t.raw_payee ? `The bank calls it “${esc(t.raw_payee)}”. ` : ''}Ledger will use this name for future transactions from them too.</p><div class="row end"><button class="btn primary">Save</button></div></form>`, (m, close) => {
      $('form', m).onsubmit = async (e) => { e.preventDefault(); const p = $('[name=p]', m).value.trim(); if (!p) return; await api('PUT', `/api/txns/${t.id}`, { payee: p, reviewed: !!t.reviewed }); t.payee = p; $('.pn', el).textContent = p; close(); };
    }, 'small');
  });
}
async function syncNow(btn) {
  btn.disabled = true; btn.textContent = 'Syncing…';
  try {
    const r = await api('POST', '/api/bank/sync');
    toast(r.busy ? 'A sync is already running' : r.errors?.length ? `Sync problem: ${r.errors[0]}` : `Synced: ${r.added} new${r.matched ? `, ${r.matched} matched` : ''}${r.transfers ? `, ${r.transfers} transfer${r.transfers > 1 ? 's' : ''}` : ''}`, r.errors?.length ? 'err' : '');
    refresh();
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = '↻ Sync'; }
}

// Compact tray for Home.
export async function inboxCard() {
  const list = await api('GET', '/api/inbox').catch(() => []);
  if (!list.length) return { html: '', bind: () => {} };
  return {
    html: `<section class="card intray"><h2>📥 New transactions <span class="badge">${list.length}</span><a class="more" href="#/inbox">Review all ›</a></h2><div class="tray">${list.slice(0, 4).map(card).join('')}</div>
      ${list.length > 4 ? `<p class="center"><a class="btn" href="#/inbox">See ${list.length - 4} more</a></p>` : ''}</section>`,
    bind: (root) => bindTray(root, list),
  };
}

// ================================================================= subscriptions
export async function subsView(main) {
  const s = await api('GET', '/api/subscriptions');
  const active = s.list.filter((x) => x.active), gone = s.list.filter((x) => !x.active);
  const subs = active.filter((x) => x.is_sub), bills = active.filter((x) => !x.is_sub);
  const row = (x) => `<li data-id="${x.id}"><span class="grow"><b>${esc(x.name)}</b>${x.change ? ` <span class="tag ${x.change.to > x.change.from ? 'warn' : ''}">${x.change.to > x.change.from ? '📈' : '📉'} ${money(x.change.from)} → ${money(x.change.to)}</span>` : ''}<br>
      <span class="muted small">${esc(x.describe)}${x.next ? ` · next ${fmtDate(x.next)}` : ''}${x.last ? ` · last ${fmtDate(x.last.date)} ${money(x.last.amount)}` : ''}${x.item_name ? ` · ${esc(x.item_name)}` : ''}</span></span>
      <span class="amt"><b>${money(x.amount)}</b><span class="muted small">${money0(x.yearly)}/yr</span></span><button class="btn sm cx">Cancel…</button><button class="iconbtn ed" title="Edit">✎</button></li>`;
  main.innerHTML = `<div class="page subs"><header class="phead"><h1>Subscriptions</h1><span class="sp"></span><a class="btn" href="#/bills">All bills ›</a></header>
    <div class="tiles"><div class="tile"><span class="lbl">Subscriptions</span><b>${money0(s.totals.subsMonthly)}<small>/mo</small></b><span class="sub">${money0(s.totals.subsYearly)} a year</span></div>
      <div class="tile"><span class="lbl">All recurring bills</span><b>${money0(s.totals.billsMonthly)}<small>/mo</small></b><span class="sub">${active.length} active</span></div>
      <div class="tile ${s.totals.savedYearly ? 'good' : ''}"><span class="lbl">Saved by cancelling</span><b>${money0(s.totals.savedYearly)}<small>/yr</small></b><span class="sub">${gone.length} cancelled</span></div>
      <div class="tile"><span class="lbl">Found in bank data</span><b>${s.detected.length}</b><span class="sub">recurring charges not tracked</span></div></div>
    ${s.detected.length ? `<section class="card"><h2>🔎 Recurring charges we found</h2><p class="muted small">From your bank history. Track them to get reminders, price-change alerts and calendar entries.</p><ul class="list">${s.detected.map((d, i) => `<li data-i="${i}"><span class="grow"><b>${esc(d.payee)}</b>${d.subscription ? ' <span class="tag">subscription</span>' : ''}${d.change ? ` <span class="tag warn">${money(d.change.from)} → ${money(d.change.to)}</span>` : ''}<br><span class="muted small">${esc(d.label)} · ${d.count} charges since ${fmtDate(d.first)} · next about ${fmtDate(d.next)}</span></span>
      <span class="amt"><b>${money(d.amount)}</b><span class="muted small">${money0(d.yearly)}/yr</span></span><button class="btn sm primary trk">Track</button><button class="iconbtn dis" title="Not recurring">✕</button></li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>🔔 Subscriptions</h2>${subs.length ? `<ul class="list">${subs.map(row).join('')}</ul>` : '<p class="muted">None tracked yet. Track one from the list above, or add it under Bills & income and tick “Subscription”.</p>'}</section>
    <section class="card"><h2>🧾 Other recurring bills</h2>${bills.length ? `<ul class="list">${bills.map(row).join('')}</ul>` : '<p class="muted">None.</p>'}</section>
    ${gone.length ? `<section class="card"><h2>🚫 Cancelled</h2><ul class="list">${gone.map((x) => `<li data-id="${x.id}"><span class="grow"><s>${esc(x.name)}</s> <span class="muted small">cancelled ${fmtDate(x.cancelled_on)} · saves ${money0(x.yearly)}/yr</span></span><button class="btn sm undo">Undo</button></li>`).join('')}</ul><p class="muted small">If a cancelled service charges you again, Ledger alerts you.</p></section>` : ''}</div>`;
  const recs = await api('GET', '/api/recurring');
  $$('li[data-id]', main).forEach((li) => {
    const x = s.list.find((y) => y.id === +li.dataset.id);
    $('.ed', li) && ($('.ed', li).onclick = () => billEditor(recs.find((r) => r.id === x.id)));
    $('.undo', li) && ($('.undo', li).onclick = async () => { await api('POST', `/api/recurring/${x.id}/cancel`, { undo: true }); refresh(); });
    $('.cx', li) && ($('.cx', li).onclick = () => modal(`Cancel ${x.name}`, `<p>Cancelling saves <b>${money(x.yearly)}</b> a year.</p>
      <ol><li><a href="${esc(x.cancel_url)}" target="_blank" rel="noopener">Open ${esc(x.name)}'s cancel page ↗</a> (or call them).</li><li>Come back and tap <b>I cancelled it</b>. Ledger stops expecting it and warns you if they charge again.</li></ol>
      <div class="row end"><button class="btn primary" id="did">I cancelled it</button></div>`, (m, close) => {
      $('#did', m).onclick = async () => { await api('POST', `/api/recurring/${x.id}/cancel`, {}); close(); toast(`${x.name} marked cancelled – ${money0(x.yearly)}/yr saved`); refresh(); };
    }, 'small'));
  });
  $$('li[data-i]', main).forEach((li) => {
    const d = s.detected[+li.dataset.i];
    $('.dis', li).onclick = async () => { await api('POST', '/api/subscriptions/dismiss', { key: d.key }); li.remove(); };
    $('.trk', li).onclick = () => modal(`Track ${d.payee}`, `<form class="grid2"><label>Name<input name="name" value="${esc(d.payee)}" required></label><label>Amount<input name="amount" inputmode="decimal" value="${(d.amount / 100).toFixed(2)}"></label>
      <label>Next charge<input name="next" type="date" value="${d.next}"></label><label>Budget category<select name="item_id">${itemOptions(d.item_id, { none: '— none —', income: false })}</select></label>
      <label class="check full"><input type="checkbox" name="sub" ${d.subscription ? 'checked' : ''}> It's a subscription (shows in subscription totals, alerts on price changes)</label>
      <p class="muted small full">Repeats ${esc(d.label)}. You'll see it on the calendar and get a reminder before it charges.</p><div class="row end full"><button class="btn primary">Track</button></div></form>`, (m, close) => {
      const f = $('form', m);
      f.onsubmit = async (e) => { e.preventDefault(); await api('POST', '/api/subscriptions/track', { name: f.name.value, payee: d.payee, amount: f.amount.value, next: f.next.value, freq: d.freq, interval: d.interval, item_id: +f.item_id.value || null, is_sub: f.sub.checked }); close(); toast('Tracking'); refresh(); };
    });
  });
}

// ================================================================= settings: bank sync
export async function bankSettings(el) {
  const b = await api('GET', '/api/bank');
  const link = b.links[0];
  if (!link) {
    const from = `${B.addMonths(state.settings.start_month, -3)}-01`;
    el.innerHTML = `<h2>🏦 Bank sync</h2>
      <p>Pull in transactions from First Fidelity (and other banks) automatically, then file them into your budget from the <b>New transactions</b> tray – like EveryDollar. Ledger uses <a href="https://bridge.simplefin.org" target="_blank" rel="noopener">SimpleFIN Bridge</a>: you sign in to your bank on their site, and Ledger only gets read-only access. Your bank password never touches Ledger.</p>
      <ol class="small"><li>At <b>bridge.simplefin.org</b>, create an account and connect your bank.</li><li>Under <b>Apps</b>, choose <b>New connection</b> and copy the <b>setup token</b>.</li><li>Paste it below. (It works once – if connecting fails, make a new one.)</li></ol>
      <form id="bk" class="grid2"><label class="full">Setup token<textarea name="token" rows="3" placeholder="aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS8u…" required autocomplete="off" spellcheck="false"></textarea></label>
        <label>Import transactions from<input name="start_date" type="date" value="${from}"><small class="muted">Going back a few months helps find subscriptions. Anything before ${monthName(state.settings.start_month)} is history only – no review needed.</small></label>
        <label class="check"><input type="checkbox" name="auto"> Auto-file stores I've categorized twice before (skip the tray for them)</label>
        <div class="row end full"><button class="btn primary">Connect & import</button></div></form>`;
    $('#bk', el).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, btn = $('button', f);
      btn.disabled = true; btn.textContent = 'Connecting… (first import can take a minute)';
      try {
        const r = await api('POST', '/api/bank/connect', { token: f.token.value, start_date: f.start_date.value, auto_approve: f.auto.checked });
        toast(r.errors?.length ? `Connected, but: ${r.errors[0]}` : `Connected: ${r.accounts} account${r.accounts === 1 ? '' : 's'}, ${r.added} new transactions`);
        bankSettings(el); refresh();
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = 'Connect & import'; }
    };
    return;
  }
  el.innerHTML = `<h2>🏦 Bank sync <span class="tag">${link.last_error ? '⚠️ problem' : 'connected'}</span></h2>
    <p class="small">Last synced <b>${ago(link.last_ok)}</b>${link.last_error ? ` · <span class="neg">${esc(link.last_error)}</span>` : ''}. Ledger checks every few hours; banks usually post purchases within 1–2 days.</p>
    ${link.errors.length ? `<div class="callout warn small">From your bank via SimpleFIN: ${link.errors.map(esc).join(' · ')}</div>` : ''}
    <ul class="list">${b.accounts.map((a) => `<li data-id="${esc(a.id)}"><span class="grow"><b>${esc(a.name)}</b><br><span class="muted small">${esc(a.org)}${a.balance != null ? ` · bank balance ${money(a.balance)}` : ''}</span></span>
      <select class="map"><option value="">Don't import</option>${accountOptions(a.enabled ? a.account_id : '')}<option value="new">＋ New account</option></select></li>`).join('')}</ul>
    <form id="bko" class="grid2"><label>Import from<input name="start_date" type="date" value="${link.start_date}"></label>
      <label class="check"><input type="checkbox" name="auto" ${link.auto_approve ? 'checked' : ''}> Auto-file stores I've categorized twice before</label>
      <div class="row full"><button type="button" class="btn danger" id="disc">Disconnect</button><span class="sp"></span><button type="button" class="btn" id="snow">↻ Sync now</button><button class="btn primary">Save</button></div></form>`;
  $$('.map', el).forEach((s) => (s.onchange = async () => {
    const id = s.closest('li').dataset.id;
    await api('PATCH', `/api/bank/accounts/${encodeURIComponent(id)}`, s.value ? { enabled: true, account_id: s.value } : { enabled: false });
    toast('Saved'); bankSettings(el);
  }));
  $('#bko', el).onsubmit = async (e) => { e.preventDefault(); await api('PATCH', `/api/bank/links/${link.id}`, { start_date: e.target.start_date.value, auto_approve: e.target.auto.checked }); toast('Saved'); };
  $('#snow', el).onclick = () => syncNow($('#snow', el));
  $('#disc', el).onclick = async () => { if (await confirmBox('Disconnect bank', 'Stop syncing? Transactions already imported stay. To fully revoke access, also delete the Ledger connection at bridge.simplefin.org.', 'Disconnect', true)) { await api('DELETE', `/api/bank/links/${link.id}`); bankSettings(el); } };
}

// ================================================================= insights card (Home)
export async function insightsCard() {
  const i = await api('GET', '/api/insights').catch(() => null);
  if (!i || (!i.week && !i.mtd)) return '';
  const cmp = (a, b) => (b ? `<span class="${a > b ? 'neg' : 'pos'}">${a > b ? '▲' : '▼'} ${Math.round(Math.abs(a - b) / b * 100)}%</span>` : '');
  return `<section class="card"><h2>💡 Insights <a class="more" href="#/subs">Subscriptions ›</a></h2><ul class="list compact">
    <li><span class="grow">Spent this week</span><b>${money0(i.week)}</b><span class="small muted">typical ${money0(i.typicalWeek)} ${cmp(i.week, i.typicalWeek)}</span></li>
    <li><span class="grow">This month so far</span><b>${money0(i.mtd)}</b><span class="small muted">${esc(i.monthLabel)} by now ${money0(i.lastMtd)} ${cmp(i.mtd, i.lastMtd)}</span></li>
    ${i.up.map((x) => `<li><span class="grow">${esc(`${x.emoji || ''} ${x.name}`)} is up</span><b class="neg">+${money0(x.diff)}</b><span class="small muted">vs ${esc(i.monthLabel)}</span></li>`).join('')}
    ${i.renewals.map((r) => `<li><span class="grow">🔔 ${esc(r.name)} renews ${fmtDate(r.date, { weekday: 'short', month: 'short', day: 'numeric' })}</span><b>${money(r.amount)}</b></li>`).join('')}</ul></section>`;
}

// ================================================================= net worth chart (Accounts)
export async function netWorthChart(host) {
  const nw = await api('GET', '/api/networth');
  if (!host) return;
  lineChart(host, nw.map((m) => ({ label: `${shortMonth(m.month)} ${m.month.slice(2, 4)}`, title: monthName(m.month), value: m.net, note: `cash ${money0(m.assets)} · cards ${money0(m.cards)} · debts ${money0(-m.debts)}` })), { full: (v) => money(v), height: 180 });
}
