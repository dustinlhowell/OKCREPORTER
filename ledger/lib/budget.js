// Pure budgeting logic: dates, recurrence, envelope math, debt snowball, quick-entry parsing, CSV.
// Money is always integer cents. Dates are 'YYYY-MM-DD' strings, months are 'YYYY-MM'.

// ---------------------------------------------------------------- dates
export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const monthOf = (date) => String(date).slice(0, 7);
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export function monthsBetween(a, b) { // inclusive list from a to b
  const out = [];
  for (let m = a; m <= b && out.length < 600; m = addMonths(m, 1)) out.push(m);
  return out;
}
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
export const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return ymd(y, m, daysIn(y, m)); };
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
export const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));
export const monthLabel = (ym, style = 'long') => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: style, year: 'numeric', timeZone: 'UTC' });
};

// ---------------------------------------------------------------- recurrence
// rule: { freq: 'once'|'weekly'|'monthly'|'semimonthly'|'yearly', start: date, interval?: n, day?: 1-31, day2?: 1-31, end?: date }
// "Every two weeks" is weekly with interval 2. Monthly day 31 means "last day of the month".
export function occurrences(rule, from, to) {
  const out = [];
  if (!rule || !isDate(rule.start)) return out;
  const end = rule.end && isDate(rule.end) && rule.end < to ? rule.end : to;
  const lo = from > rule.start ? from : rule.start;
  if (lo > end) return out;
  const iv = Math.max(1, Math.floor(+rule.interval || 1));
  const push = (d) => { if (d >= lo && d <= end && d >= rule.start) out.push(d); };
  const [sy, sm, sd] = rule.start.split('-').map(Number);
  switch (rule.freq) {
    case 'once': push(rule.start); break;
    case 'daily': {
      let k = Math.max(0, Math.floor(dayDiff(rule.start, lo) / iv));
      for (let d = addDays(rule.start, k * iv); d <= end; d = addDays(d, iv)) push(d);
      break;
    }
    case 'weekly': {
      const step = 7 * iv;
      let k = Math.max(0, Math.floor(dayDiff(rule.start, lo) / step));
      for (let d = addDays(rule.start, k * step); d <= end && out.length < 1000; d = addDays(d, step)) push(d);
      break;
    }
    case 'monthly': case 'semimonthly': {
      const days = rule.freq === 'semimonthly' ? [+rule.day || 1, +rule.day2 || 15].sort((a, b) => a - b) : [+rule.day || sd];
      let ym = `${sy}-${pad(sm)}`;
      const [ly, lm] = lo.split('-').map(Number);
      const skip = Math.max(0, (ly * 12 + lm) - (sy * 12 + sm));
      ym = addMonths(ym, Math.floor(skip / iv) * iv);
      for (; ym <= end.slice(0, 7); ym = addMonths(ym, iv)) {
        const [y, m] = ym.split('-').map(Number);
        for (const dd of days) push(ymd(y, m, Math.min(dd, daysIn(y, m))));
      }
      break;
    }
    case 'yearly': {
      for (let y = Math.max(sy, +lo.slice(0, 4)); y <= +end.slice(0, 4); y += 1) {
        if ((y - sy) % iv) continue;
        push(ymd(y, sm, Math.min(sd, daysIn(y, sm))));
      }
      break;
    }
  }
  return [...new Set(out)].sort();
}
export function describeRule(rule) {
  const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th');
  const iv = +rule.interval || 1;
  switch (rule.freq) {
    case 'once': return `once on ${rule.start}`;
    case 'daily': return iv === 1 ? 'every day' : `every ${iv} days`;
    case 'weekly': {
      const wd = new Date(rule.start + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
      return iv === 1 ? `every ${wd}` : iv === 2 ? `every other ${wd}` : `every ${iv} weeks on ${wd}`;
    }
    case 'monthly': { const d = +rule.day || +rule.start.slice(8); return `${iv === 1 ? 'monthly' : `every ${iv} months`} on the ${d >= 31 ? 'last day' : ord(d)}`; }
    case 'semimonthly': return `twice a month (${ord(+rule.day || 1)} & ${(+rule.day2 || 15) >= 31 ? 'last day' : ord(+rule.day2 || 15)})`;
    case 'yearly': return `yearly on ${new Date(rule.start + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
    default: return '';
  }
}

// ---------------------------------------------------------------- money
export function parseMoney(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  const s = String(v ?? '').trim().replace(/[$,\s]/g, '');
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const n = parseFloat(s.replace(/[()\-+]/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) * (neg ? -1 : 1);
}
export const fmtMoney = (c, { sign = false, cents = true } = {}) => {
  const n = Math.abs(c || 0) / 100;
  const s = n.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  return `${c < 0 ? '−' : sign && c > 0 ? '+' : ''}$${s}`;
};

// ---------------------------------------------------------------- envelopes
// items: [{ id, rollover, kind }]; plans/spent: Map(month -> Map(itemId -> cents)); months: ordered list.
// For each month and item: carry (previous available when rollover is on), planned, spent, available.
// Without rollover an item starts fresh every month (EveryDollar style); with rollover it's a true envelope:
// leftovers carry forward and overspending is taken out of next month.
export function envelopes(items, plans, spent, months, opening = new Map()) {
  const out = new Map();
  let prev = null;
  for (const m of months) {
    const row = new Map();
    for (const it of items) {
      const planned = plans.get(m)?.get(it.id) || 0;
      const sp = spent.get(m)?.get(it.id) || 0;
      const carry = it.rollover ? (prev ? prev.get(it.id).available : (opening.get(it.id) || 0)) : 0;
      row.set(it.id, { carry, planned, spent: sp, available: carry + planned - sp });
    }
    out.set(m, row);
    prev = row;
  }
  return out;
}

// Monthly totals from a month's envelope rows. Income items track "received" instead of spending.
export function summarize(items, row) {
  const s = { incomePlanned: 0, incomeReceived: 0, planned: 0, spent: 0, available: 0, carry: 0, overspent: 0, leftToBudget: 0 };
  for (const it of items) {
    const e = row.get(it.id);
    if (!e) continue;
    if (it.kind === 'income') { s.incomePlanned += e.planned; s.incomeReceived += e.spent; continue; }
    s.planned += e.planned; s.spent += e.spent; s.available += e.available; s.carry += e.carry;
    if (e.available < 0) s.overspent += -e.available;
  }
  s.leftToBudget = s.incomePlanned - s.planned;
  return s;
}

// ---------------------------------------------------------------- debt snowball (no interest, smallest balance first)
// debts: [{ id, name, balance (cents), min (cents) }]. Each month the same total is paid: every original
// minimum plus `extra`. As a debt is paid off its minimum "snowballs" onto the next-smallest balance.
export function snowballOrder(debts) {
  return [...debts].sort((a, b) => a.balance - b.balance || a.min - b.min || String(a.name).localeCompare(String(b.name)));
}
// paidFirst: { id: cents } already paid toward each debt in startMonth (balances already reflect it).
export function snowball(debts, extra, startMonth, maxMonths = 600, paidFirst = {}) {
  const active = snowballOrder(debts.filter((d) => d.balance > 0));
  const bal = new Map(active.map((d) => [d.id, d.balance]));
  const budget = active.reduce((s, d) => s + Math.max(0, d.min), 0) + Math.max(0, extra || 0);
  const months = [], payoff = {};
  if (!active.length) return { months, payoff, budget, debtFree: null, totalMonths: 0, stalled: false };
  if (budget <= 0) return { months, payoff, budget, debtFree: null, totalMonths: 0, stalled: true };
  let m = startMonth;
  for (let i = 0; i < maxMonths && [...bal.values()].some((b) => b > 0); i++, m = addMonths(m, 1)) {
    const already = i === 0 ? paidFirst : {};
    let pool = Math.max(0, budget - Object.values(already).reduce((a, v) => a + Math.max(0, v), 0));
    const pay = {};
    // 1) minimums (less anything already paid this month)
    for (const d of active) {
      const b = bal.get(d.id);
      if (b <= 0) continue;
      const p = Math.min(b, Math.max(0, d.min - Math.max(0, already[d.id] || 0)), pool);
      if (p > 0) { pay[d.id] = p; pool -= p; bal.set(d.id, b - p); }
    }
    // 2) everything left goes to the smallest remaining balance, cascading
    for (const d of active) {
      if (pool <= 0) break;
      const b = bal.get(d.id);
      if (b <= 0) continue;
      const p = Math.min(b, pool);
      pay[d.id] = (pay[d.id] || 0) + p; pool -= p; bal.set(d.id, b - p);
    }
    for (const d of active) if (bal.get(d.id) <= 0 && !payoff[d.id] && (pay[d.id] || already[d.id])) payoff[d.id] = m;
    months.push({ month: m, payments: pay, already, balances: Object.fromEntries(bal), total: [...Object.values(pay), ...Object.values(already)].reduce((a, b) => a + b, 0) });
  }
  const done = [...bal.values()].every((b) => b <= 0);
  return { months, payoff, budget, debtFree: done ? months.at(-1).month : null, totalMonths: months.length, stalled: !done };
}

// ---------------------------------------------------------------- quick entry ("42.50 costco groceries")
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
export function matchItem(text, items) { return matchTerm(text, items)?.item || null; }
// Best (longest) category name or alias found in the text: { item, term, alias }
export function matchTerm(text, items) {
  const t = ` ${norm(text)} `, ts = ` ${norm(text).split(' ').map(stem).join(' ')} `;
  let best = null;
  for (const it of items) {
    const names = [[it.name, false], ...(it.aliases ? String(it.aliases).split(',').map((a) => [a, true]) : [])].map(([n, a]) => [norm(n), a]).filter(([n]) => n);
    for (const [n, alias] of names) {
      const ns = n.split(' ').map(stem).join(' ');
      if ((t.includes(` ${n} `) || ts.includes(` ${ns} `)) && (!best || n.length > best.term.length)) best = { item: it, term: n, alias };
    }
  }
  return best;
}
// Returns { amount, kind, item, payee, note, date? }
export function parseQuick(text, items, payeeRule = () => null, today = null) {
  let s = String(text || '').trim();
  const r = { amount: NaN, kind: 'expense', item: null, payee: '', note: '', date: null };
  if (/^(\+|income\b|got paid\b|paycheck\b|payday\b|received\b|deposit\b)/i.test(s)) { r.kind = 'income'; s = s.replace(/^\+/, ''); }
  if (/^(refund|returned?)\b/i.test(s)) { r.kind = 'refund'; }
  const am = /(?:^|\s)\$?\s?(-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)(?:\s?(?:dollars|bucks))?(?=\s|$|[.,!?])/i.exec(s);
  if (am) { r.amount = Math.abs(parseMoney(am[1])); s = (s.slice(0, am.index) + ' ' + s.slice(am.index + am[0].length)).trim(); }
  if (today) {
    if (/\byesterday\b/i.test(s)) { r.date = addDays(today, -1); s = s.replace(/\byesterday\b/i, ''); }
    else if (/\btoday\b/i.test(s)) { r.date = today; s = s.replace(/\btoday\b/i, ''); }
  }
  const hit = matchTerm(s, items);
  r.item = hit?.item || null;
  const atM = /\b(?:at|from)\s+(.+?)(?=\s+(?:for|on|in|under)\b|$)/i.exec(s);
  if (atM) r.payee = atM[1].trim();
  let rest = s.replace(/^(i\s+)?(spent|paid|bought|got paid|paycheck|payday|income|received|deposit|refund|returned?)\b/i, '')
    .replace(/\b(at|from)\s+.+?(?=\s+(?:for|on|in|under)\b|$)/i, '');
  if (hit && !hit.alias) {
    const words = hit.term.split(' ').map((w) => stem(w).slice(0, Math.max(3, stem(w).length - 1)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*').join('\\s+');
    rest = rest.replace(new RegExp(`(?:\\b(?:for|on|in|under|to)\\s+)?(?:the\\s+)?\\b${words}\\b`, 'i'), ' ');
  }
  rest = rest.replace(/\b(for|on|in|under|my|the|a|an|budget|category|envelope)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!r.payee && rest) r.payee = rest.replace(/^./, (c) => c.toUpperCase());
  if (!r.item && r.payee) r.item = payeeRule(r.payee) || null;
  r.payee = r.payee.replace(/[.,!?]+$/, '');
  return r;
}

// ---------------------------------------------------------------- CSV
export function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else field += c;
  }
  row.push(field); if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}
export const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// Bank exports use many date formats: 2026-11-03, 11/03/2026, 11/3/26, 03.11.2026 (dmy only if day>12).
export function parseDate(s) {
  s = String(s || '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s))) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return ymd(y, +m[1], +m[2]); }
  if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s))) return ymd(+m[3], +m[2], +m[1]);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) { const d = new Date(t); return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  return null;
}
// Guess which columns of a bank CSV hold date / description / amount (or debit+credit).
export function guessColumns(header) {
  const h = header.map((x) => String(x).toLowerCase().trim());
  const find = (...re) => h.findIndex((x) => re.some((r) => r.test(x)));
  return {
    date: find(/^date$/, /posted|transaction date|trans\. date|^date/),
    payee: find(/description|payee|merchant|name|memo|details/),
    amount: find(/^amount$/, /amount/),
    debit: find(/debit|withdrawal|outflow/),
    credit: find(/credit|deposit|inflow/),
  };
}
