// Ledger – self-hosted household budget: zero-based envelopes, debt snowball, bills calendar, phone quick-add.
import http from 'node:http';
import { readFileSync, readdirSync, mkdirSync, statSync, watch, unlinkSync, writeFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { openDb } from './lib/db.js';
import { GROUPS, ACCOUNTS } from './lib/seed.js';
import * as B from './lib/budget.js';
import { buildTools, validate } from './lib/tools.js';
import { deliver, hasChannel, smtpConfigured, pushoverConfigured } from './lib/notify.js';
import { encrypt, s3Client } from './lib/offsite.js';
import { newSecret, otpauthUri, verifyTotp, newRecoveryCodes, useRecoveryCode } from './lib/totp.js';
import * as SF from './lib/simplefin.js';
import * as INS from './lib/insights.js';

const { fmtMoney: $ } = B;
const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_DIR || join(ROOT, 'data');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const isHttps = (req) => process.env.COOKIE_SECURE === '1' || req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const SESSION_DAYS = 60, DAY = 86400000;

mkdirSync(DATA, { recursive: true });
const store = openDb(process.env.DB_FILE || join(DATA, 'ledger.db'));
const { q, tx } = store;
const kv = (k, d = null) => q('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? d;
const setKv = (k, v) => q('INSERT OR REPLACE INTO kv(k, v) VALUES (?, ?)').run(k, String(v));
const today = () => new Date().toLocaleDateString('sv', { timeZone: TZ });
const nowHHMM = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------- static assets (pre-compressed, in memory)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const assets = new Map();
const etagOf = (b) => `"${createHash('sha1').update(b).digest('base64url').slice(0, 20)}"`;
function addAsset(path, body, type) {
  const compressible = /text|json|svg|javascript|manifest/.test(type);
  assets.set(path, { body, type, etag: etagOf(body), gz: compressible ? gzipSync(body, { level: 9 }) : null,
    br: compressible ? brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }) : null });
}
function loadAssets(dir = join(ROOT, 'public'), prefix = '/') {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { loadAssets(p, `${prefix}${f}/`); continue; }
    addAsset(prefix + f, readFileSync(p), MIME[extname(f)] || 'application/octet-stream');
  }
}
function buildAssets() {
  assets.clear();
  loadAssets();
  addAsset('/budget.js', readFileSync(join(ROOT, 'lib/budget.js')), MIME['.js']); // shared with the browser
  try { addAsset('/vendor/qrcode.js', readFileSync(join(ROOT, 'node_modules/qrcode-generator/qrcode.js')), MIME['.js']); } catch {}
  const idx = assets.get('/index.html');
  const html = idx.body.toString().replace(/(src|href)="\/(app\.css|app\.js)"/g, (m, a, f) => `${a}="/${f}?v=${assets.get('/' + f).etag.slice(1, 9)}"`);
  addAsset('/index.html', Buffer.from(html), idx.type);
}
buildAssets();
if (process.env.NODE_ENV !== 'production') {
  let t; try { watch(join(ROOT, 'public'), { recursive: true }, () => { clearTimeout(t); t = setTimeout(() => { try { buildAssets(); } catch {} }, 100); }); } catch {}
}
function serveAsset(req, res, path, versioned = false) {
  const a = assets.get(path);
  if (!a) return false;
  const headers = { 'content-type': a.type, etag: a.etag, vary: 'accept-encoding', 'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache' };
  if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, headers); res.end(); return true; }
  const ae = req.headers['accept-encoding'] || '';
  let body = a.body;
  if (a.br && /\bbr\b/.test(ae)) { body = a.br; headers['content-encoding'] = 'br'; }
  else if (a.gz && /\bgzip\b/.test(ae)) { body = a.gz; headers['content-encoding'] = 'gzip'; }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

// ---------------------------------------------------------------- http helpers
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (msg = 'Not found') => { throw new HttpError(404, msg); };
function send(req, res, status, data, headers = {}) {
  let body = data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data);
  const h = { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers };
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = gzipSync(body, { level: 4 }); h['content-encoding'] = 'gzip'; }
  h['content-length'] = Buffer.byteLength(body);
  res.writeHead(status, h);
  res.end(body);
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!size) return resolve({});
      const raw = Buffer.concat(chunks).toString();
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      if (ct.startsWith('text/plain')) return resolve({ text: raw });
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const token = (n = 24) => randomBytes(n).toString('base64url');
const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const baseUrl = (req) => PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
const clientIp = (req) => String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress);
function hashPw(pw) { const salt = randomBytes(16); return `scrypt$${salt.toString('base64')}$${scryptSync(pw, salt, 64).toString('base64')}`; }
function checkPw(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  return timingSafeEqual(scryptSync(pw, Buffer.from(salt, 'base64'), 64), Buffer.from(hash, 'base64'));
}
// API convention: JSON numbers are cents, strings are dollars as typed ("42.50", "$1,200").
const cents = (v, name = 'amount') => { const c = v == null || v === '' ? 0 : typeof v === 'number' ? Math.round(v) : B.parseMoney(v); if (!Number.isFinite(c)) bad(`${name} must be a number`); return c; };
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// ---------------------------------------------------------------- live updates (Server-Sent Events)
const clients = new Set();
function broadcast(type, data = {}, origin) {
  const msg = `event: ${type}\ndata: ${JSON.stringify({ ...data, origin })}\n\n`;
  for (const c of clients) c.res.write(msg);
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();
const changed = (origin, what = 'all') => broadcast('change', { what }, origin);

// ================================================================= domain
const settings = () => ({
  start_month: kv('start_month', '2026-11'), end_month: kv('end_month', '2027-12'), week_start: +kv('week_start', 0),
  household: kv('household', 'Our budget'), snowball_extra: +kv('snowball_extra', 0), low_pct: +kv('low_pct', 90),
  large_charge: +kv('large_charge', 50000), low_balance: +kv('low_balance', 10000),
});
const budgetMonths = () => { const s = settings(); return B.monthsBetween(s.start_month, s.end_month); };
function log(uid, kind, text, data) { q('INSERT INTO activity(at, user_id, kind, text, data) VALUES (?, ?, ?, ?, ?)').run(Date.now(), uid ?? null, kind, text, data ? JSON.stringify(data) : null); }

function itemsFlat() {
  return q(`SELECT i.*, g.kind, g.is_debt, g.name AS group_name, g.color AS group_color, g.archived AS group_archived FROM items i JOIN groups g ON g.id = i.group_id ORDER BY g.sort, g.id, i.sort, i.id`).all();
}
function plansMap(from, to) {
  const m = new Map();
  for (const r of q('SELECT month, item_id, amount FROM plans WHERE month >= ? AND month <= ?').all(from, to)) {
    if (!m.has(r.month)) m.set(r.month, new Map());
    m.get(r.month).set(r.item_id, r.amount);
  }
  return m;
}
// Signed activity per month and item: spending for expense items (refunds subtract), money received for income items.
function activityMap(from, to, items) {
  const kindOf = new Map(items.map((i) => [i.id, i.kind]));
  const m = new Map();
  for (const r of q(`SELECT substr(t.date, 1, 7) AS m, l.item_id, SUM(CASE WHEN t.kind = 'income' THEN -l.amount ELSE l.amount END) AS v
      FROM lines l JOIN txns t ON t.id = l.txn_id WHERE l.item_id IS NOT NULL AND t.kind != 'transfer' AND t.date >= ? AND t.date <= ? GROUP BY m, l.item_id`).all(`${from}-01`, B.lastDay(to))) {
    if (!m.has(r.m)) m.set(r.m, new Map());
    m.get(r.m).set(r.item_id, kindOf.get(r.item_id) === 'income' ? -r.v : r.v);
  }
  return m;
}
// Envelope state for every month from the budget start through `through`.
function envState(through, items = itemsFlat()) {
  const s = settings();
  const start = through < s.start_month ? through : s.start_month;
  const months = B.monthsBetween(start, through);
  const from = B.addMonths(start, -3);
  const plans = plansMap(from, through), act = activityMap(from, through, items);
  return { months, items, plans, act, env: B.envelopes(items, plans, act, months) };
}
function monthView(month) {
  if (!B.isMonth(month)) bad('month must be YYYY-MM');
  const { items, env, act, plans } = envState(month);
  const row = env.get(month);
  const debts = new Map(debtList().map((d) => [d.item_id, d]));
  const recurringByItem = new Map();
  for (const r of q('SELECT id, name, item_id, amount, rule, autopay FROM recurring WHERE active = 1 AND item_id IS NOT NULL').all()) {
    const occ = B.occurrences(JSON.parse(r.rule), `${month}-01`, B.lastDay(month));
    if (occ.length) (recurringByItem.get(r.item_id) || recurringByItem.set(r.item_id, []).get(r.item_id)).push({ id: r.id, name: r.name, dates: occ, amount: r.amount, autopay: !!r.autopay });
  }
  const prevs = [1, 2, 3].map((n) => B.addMonths(month, -n));
  const groups = q('SELECT * FROM groups WHERE archived = 0 ORDER BY sort, id').all().map((g) => {
    const its = items.filter((i) => i.group_id === g.id && !i.archived).map((i) => {
      const e = row.get(i.id);
      const last = act.get(prevs[0])?.get(i.id) || 0;
      const avg = Math.round(prevs.reduce((s, p) => s + (act.get(p)?.get(i.id) || 0), 0) / 3);
      let goal = null;
      if (i.goal_amount) {
        const have = e.carry + e.planned;
        const left = B.monthsBetween(month, i.goal_date && B.isDate(i.goal_date) ? i.goal_date.slice(0, 7) : month).length || 1;
        goal = { amount: i.goal_amount, date: i.goal_date, saved: Math.max(0, e.available), pct: Math.min(100, Math.round(Math.max(0, e.available) / i.goal_amount * 100)),
          monthly: i.goal_date ? Math.max(0, Math.ceil((i.goal_amount - e.carry) / left)) : null, funded: have >= i.goal_amount };
      }
      return { id: i.id, name: i.name, emoji: i.emoji, rollover: !!i.rollover, note: i.note, aliases: i.aliases, due_day: i.due_day, default_amount: i.default_amount,
        goal_amount: i.goal_amount, goal_date: i.goal_date, ...e, last, avg, lastPlanned: plans.get(prevs[0])?.get(i.id) || 0, goal,
        debt: debts.get(i.id) ? { id: debts.get(i.id).id, current: debts.get(i.id).current, min: debts.get(i.id).min_payment } : null,
        bills: recurringByItem.get(i.id) || [] };
    });
    const t = its.reduce((a, i) => ({ planned: a.planned + i.planned, spent: a.spent + i.spent, available: a.available + i.available, carry: a.carry + i.carry }), { planned: 0, spent: 0, available: 0, carry: 0 });
    return { id: g.id, name: g.name, emoji: g.emoji, color: g.color, kind: g.kind, is_debt: !!g.is_debt, items: its, totals: t };
  });
  const visibleItems = items.filter((i) => !i.archived && !i.group_archived);
  const summary = B.summarize(visibleItems, row);
  const unc = q(`SELECT COUNT(DISTINCT t.id) c, COALESCE(SUM(l.amount), 0) a FROM lines l JOIN txns t ON t.id = l.txn_id WHERE l.item_id IS NULL AND t.kind != 'transfer' AND t.date >= ? AND t.date <= ?`).get(`${month}-01`, B.lastDay(month));
  const uncAll = q(`SELECT COUNT(DISTINCT t.id) c FROM lines l JOIN txns t ON t.id = l.txn_id WHERE l.item_id IS NULL AND t.kind != 'transfer'`).get().c;
  return { month, settings: settings(), summary, groups, uncategorized: { count: unc.c, amount: unc.a, all: uncAll } };
}

// ---- accounts
function accounts(asOf = '9999-12-31', { all = false } = {}) {
  return q(`SELECT a.*, a.start_balance
      + COALESCE((SELECT SUM(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END) FROM txns t WHERE t.account_id = a.id AND t.date <= :d AND (a.start_date IS NULL OR t.date >= a.start_date)), 0)
      + COALESCE((SELECT SUM(t.amount) FROM txns t WHERE t.kind = 'transfer' AND t.to_account_id = a.id AND t.date <= :d AND (a.start_date IS NULL OR t.date >= a.start_date)), 0) AS balance,
      (SELECT COUNT(*) FROM txns t WHERE t.account_id = a.id AND t.cleared = 0) AS uncleared
    FROM accounts a ${all ? '' : 'WHERE a.archived = 0'} ORDER BY a.archived, a.sort, a.id`).all({ d: asOf });
}
const defaultAccount = () => q("SELECT id FROM accounts WHERE archived = 0 ORDER BY CASE kind WHEN 'checking' THEN 0 ELSE 1 END, sort, id").get()?.id ?? null;

// ---- debts
function debtList({ archived = false } = {}) {
  return q(`SELECT d.*, i.name AS item_name,
      COALESCE((SELECT SUM(CASE WHEN t.kind = 'income' THEN -l.amount ELSE l.amount END) FROM lines l JOIN txns t ON t.id = l.txn_id WHERE l.item_id = d.item_id AND t.kind != 'transfer' AND t.date >= d.as_of), 0) AS paid,
      COALESCE((SELECT SUM(amount) FROM debt_adjust a WHERE a.debt_id = d.id AND a.date >= d.as_of), 0) AS added,
      COALESCE((SELECT SUM(t.amount) FROM txns t WHERE t.kind = 'transfer' AND d.account_id IS NOT NULL AND t.to_account_id = d.account_id AND t.date >= d.as_of), 0) AS paid_tr,
      (SELECT ba.balance FROM bank_accounts ba WHERE d.account_id IS NOT NULL AND ba.account_id = d.account_id AND ba.enabled = 1 AND ba.balance IS NOT NULL ORDER BY ba.balance_date DESC LIMIT 1) AS bank_balance,
      a.name AS account_name
    FROM debts d LEFT JOIN items i ON i.id = d.item_id LEFT JOIN accounts a ON a.id = d.account_id ${archived ? '' : 'WHERE d.archived = 0'} ORDER BY d.id`).all()
    .map((d) => {
      const synced = d.bank_balance != null;
      const current = synced ? Math.abs(d.bank_balance) : d.balance - d.paid - d.paid_tr + d.added;
      return { ...d, synced, current, progress: d.original > 0 ? Math.max(0, Math.min(1, (d.original - Math.max(0, current)) / d.original)) : 0 };
    });
}
function debtPaidIn(d, month) {
  const from = `${month}-01`, to = B.lastDay(month);
  return q(`SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN -l.amount ELSE l.amount END), 0) v FROM lines l JOIN txns t ON t.id = l.txn_id WHERE l.item_id = ? AND t.kind != 'transfer' AND t.date >= ? AND t.date <= ?`).get(d.item_id, from, to).v
    + (d.account_id ? q("SELECT COALESCE(SUM(amount), 0) v FROM txns WHERE kind = 'transfer' AND to_account_id = ? AND date >= ? AND date <= ?").get(d.account_id, from, to).v : 0);
}
function debtSummary() {
  const debts = debtList(), s = settings(), month = today().slice(0, 7);
  const open = debts.filter((d) => d.current > 0);
  // Minimums of debts already paid off keep rolling into the snowball – the monthly total never shrinks.
  const freed = debts.filter((d) => d.current <= 0).reduce((a, d) => a + d.min_payment, 0);
  // Payments already made this month count toward this month's snowball.
  const paidThisMonth = Object.fromEntries(debts.map((d) => [d.id, debtPaidIn(d, month)]));
  const plan = B.snowball(open.map((d) => ({ id: d.id, name: d.name, balance: d.current, min: d.min_payment })), s.snowball_extra + freed, month, 600,
    Object.fromEntries(open.map((d) => [d.id, paidThisMonth[d.id] || 0])));
  const order = B.snowballOrder(open.map((d) => ({ ...d, balance: d.current, min: d.min_payment }))).map((d, i) => ({ ...d, rank: i + 1, payoff: plan.payoff[d.id] || null }));
  const total = open.reduce((a, d) => a + d.current, 0), original = debts.reduce((a, d) => a + d.original, 0);
  return { debts, order, plan, extra: s.snowball_extra, freed, total, original, paidTotal: Math.max(0, original - total), paidThisMonth, month };
}
function ensureDebtGroup() {
  let g = q('SELECT id FROM groups WHERE is_debt = 1 ORDER BY archived, id LIMIT 1').get();
  if (!g) { const r = q("INSERT INTO groups(name, emoji, color, kind, is_debt, sort) VALUES ('Debt', '⛓️', '#d95926', 'expense', 1, (SELECT COALESCE(MAX(sort), 0) + 1 FROM groups))").run(); g = { id: Number(r.lastInsertRowid) }; }
  q('UPDATE groups SET archived = 0 WHERE id = ?').run(g.id);
  return g.id;
}
async function checkPaidOff() {
  for (const d of debtList()) {
    if (d.current <= 0 && !d.paid_off) {
      q('UPDATE debts SET paid_off = ? WHERE id = ?').run(today(), d.id);
      log(null, 'debt', `🎉 ${d.name} is paid off!`);
      const next = debtSummary().order[0];
      notifyAll('alerts', `🎉 ${d.name} is PAID OFF!`, `${$(d.original)} gone. ${next ? `Its ${$(d.min_payment)} minimum now snowballs onto ${next.name} (${$(next.current)} left).` : 'That was the last one – you are debt-free!'}`).catch(() => {});
    } else if (d.current > 0 && d.paid_off) q('UPDATE debts SET paid_off = NULL WHERE id = ?').run(d.id);
  }
}

// ---- recurring bills / paydays and their occurrences
const recurringList = () => q(`SELECT r.*, i.name AS item_name, a.name AS account_name FROM recurring r LEFT JOIN items i ON i.id = r.item_id LEFT JOIN accounts a ON a.id = r.account_id ORDER BY r.active DESC, r.name`).all()
  .map((r) => ({ ...r, rule: JSON.parse(r.rule), autopay: !!r.autopay, active: !!r.active }));
// Every scheduled thing (bills, paydays, transfers, debt minimums) between from and to with paid / skipped / overdue status.
function scheduled(from, to) {
  const t = today(), out = [];
  const paid = new Map(q('SELECT id, recurring_id, occ_date, amount, date FROM txns WHERE recurring_id IS NOT NULL AND occ_date >= ? AND occ_date <= ?').all(from, to).map((x) => [`${x.recurring_id}:${x.occ_date}`, x]));
  const skipped = new Set(q('SELECT recurring_id, occ_date FROM skips WHERE occ_date >= ? AND occ_date <= ?').all(from, to).map((x) => `${x.recurring_id}:${x.occ_date}`));
  const recs = recurringList().filter((r) => r.active);
  const recItems = new Set(recs.map((r) => r.item_id).filter(Boolean));
  for (const r of recs) for (const d of B.occurrences(r.rule, from, to)) {
    const key = `${r.id}:${d}`, p = paid.get(key);
    out.push({ type: 'bill', id: r.id, name: r.name, payee: r.payee, is_sub: !!r.is_sub, kind: r.kind, date: d, amount: p ? p.amount : r.amount, item_id: r.item_id, item_name: r.item_name, account_id: r.account_id,
      to_account_id: r.to_account_id, autopay: r.autopay, txn_id: p?.id || null, status: p ? 'paid' : skipped.has(key) ? 'skipped' : d < t ? 'overdue' : d === t ? 'due today' : 'upcoming' });
  }
  // Debt minimums with a due day (unless a recurring bill already covers that debt's category).
  for (const d of debtList()) {
    if (!d.due_day || d.current <= 0 || (d.item_id && recItems.has(d.item_id))) continue;
    for (const m of B.monthsBetween(from.slice(0, 7), to.slice(0, 7))) {
      const [y, mo] = m.split('-').map(Number), date = B.ymd(y, mo, Math.min(d.due_day, B.daysIn(y, mo)));
      if (date < from || date > to || date < new Date(d.created).toLocaleDateString('sv', { timeZone: TZ })) continue;
      const pd = debtPaidIn(d, m);
      out.push({ type: 'debt', id: d.id, name: d.name, kind: 'expense', date, amount: d.min_payment, paid: pd, item_id: d.item_id, item_name: d.item_name,
        status: pd >= d.min_payment && d.min_payment > 0 ? 'paid' : date < t ? 'overdue' : date === t ? 'due today' : 'upcoming' });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}
const upcoming = (days = 14) => { const t = today(); return scheduled(B.addDays(t, -31), B.addDays(t, days)).filter((x) => x.date >= t || x.status === 'overdue'); };

// ---- cash flow: actual end-of-day balance of cash accounts up to today, projected from scheduled items after that
function cashflow(from, to) {
  const t = today();
  const cash = new Set(accounts().filter((a) => a.kind !== 'credit').map((a) => a.id));
  const isCash = (id) => id == null || cash.has(id);
  const effect = (kind, acct, toAcct, amt) => kind === 'income' ? (isCash(acct) ? amt : 0) : kind === 'expense' ? (isCash(acct) ? -amt : 0)
    : (isCash(acct) ? -amt : 0) + (toAcct != null && cash.has(toAcct) ? amt : 0);
  const start = from < t ? from : t;
  const before = B.addDays(start, -1);
  let bal = accounts(before).filter((a) => cash.has(a.id)).reduce((s, a) => s + a.balance, 0)
    + q("SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE -amount END), 0) v FROM txns WHERE account_id IS NULL AND kind != 'transfer' AND date <= ?").get(before).v;
  const delta = new Map();
  const add = (d, v) => delta.set(d, (delta.get(d) || 0) + v);
  for (const x of q('SELECT date, kind, amount, account_id, to_account_id FROM txns WHERE date >= ? AND date <= ?').all(start, t < to ? t : to)) add(x.date, effect(x.kind, x.account_id, x.to_account_id, x.amount));
  const expected = new Map();
  if (to >= t) for (const s of scheduled(`${t.slice(0, 7)}-01`, to)) {
    if (s.status === 'paid' || s.status === 'skipped') continue;
    const amt = s.type === 'debt' ? Math.max(0, s.amount - (s.paid || 0)) : s.amount;
    const d = s.date < t ? t : s.date; // overdue items are still expected to leave the account
    if (d === t && s.date === t && s.autopay) continue; // autopay posts itself today
    expected.set(d, (expected.get(d) || 0) + effect(s.kind, s.account_id, s.to_account_id, amt));
  }
  const days = [];
  let low = null;
  for (let d = start; d <= to; d = B.addDays(d, 1)) {
    bal += (delta.get(d) || 0) + (d >= t ? (expected.get(d) || 0) : 0);
    if (d >= from) { days.push({ date: d, balance: bal, projected: d > t }); if (d >= t && (!low || bal < low.balance)) low = { date: d, balance: bal }; }
  }
  return { days, low, today: t };
}

// ---- transactions
function payeeItem(name, kind = null) {
  const k = String(name || '').toLowerCase().trim();
  if (!k) return null;
  if (kind) { const it = payeeItem(name); return it && (it.kind === 'income') === (kind === 'income') ? it : null; }
  const r = q('SELECT p.item_id FROM payees p JOIN items i ON i.id = p.item_id WHERE p.key = ? AND i.archived = 0').get(k)
    || q("SELECT p.item_id FROM payees p JOIN items i ON i.id = p.item_id WHERE i.archived = 0 AND (? LIKE p.key || '%' OR p.key LIKE ? || '%') AND length(p.key) >= 4 ORDER BY p.uses DESC LIMIT 1").get(k, k);
  return r ? itemsFlat().find((i) => i.id === r.item_id) || null : null;
}
function learnPayee(payee, itemId) {
  const k = String(payee || '').toLowerCase().trim();
  if (!k || !itemId) return;
  q('INSERT INTO payees(key, name, item_id, uses, last_used) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET item_id = excluded.item_id, name = excluded.name, uses = uses + 1, last_used = excluded.last_used').run(k, payee.trim(), itemId, Date.now());
}
function getTxn(id) {
  const t = q(`SELECT t.*, a.name AS account_name, ta.name AS to_account_name, u.name AS user_name, r.name AS recurring_name FROM txns t LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id LEFT JOIN users u ON u.id = t.user_id LEFT JOIN recurring r ON r.id = t.recurring_id WHERE t.id = ?`).get(id);
  if (!t) return null;
  t.lines = q('SELECT l.id, l.item_id, l.amount, l.note, i.name AS item_name, i.emoji FROM lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.txn_id = ? ORDER BY l.id').all(id);
  return t;
}
function listTxns({ from, to, item, account, search, uncategorized, inbox, user, kind, limit = 500, offset = 0 } = {}) {
  const w = [], p = {};
  if (inbox) { w.push("(t.reviewed = 0 OR (t.kind != 'transfer' AND t.date >= :bstart AND EXISTS (SELECT 1 FROM lines l WHERE l.txn_id = t.id AND l.item_id IS NULL)))"); p.bstart = `${settings().start_month}-01`; }
  if (from) { w.push('t.date >= :from'); p.from = from; }
  if (to) { w.push('t.date <= :to'); p.to = to; }
  if (item) { w.push('EXISTS (SELECT 1 FROM lines l WHERE l.txn_id = t.id AND l.item_id = :item)'); p.item = +item; }
  if (account) { w.push('(t.account_id = :acct OR t.to_account_id = :acct)'); p.acct = +account; }
  if (user) { w.push('t.user_id = :user'); p.user = +user; }
  if (kind) { w.push('t.kind = :kind'); p.kind = kind; }
  if (uncategorized) w.push("t.kind != 'transfer' AND EXISTS (SELECT 1 FROM lines l WHERE l.txn_id = t.id AND l.item_id IS NULL)");
  if (search) { w.push("(t.payee LIKE :s OR t.note LIKE :s OR EXISTS (SELECT 1 FROM lines l JOIN items i ON i.id = l.item_id WHERE l.txn_id = t.id AND i.name LIKE :s) OR printf('%.2f', t.amount / 100.0) LIKE :s)"); p.s = `%${search}%`; }
  const ids = q(`SELECT t.id FROM txns t ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY t.date DESC, t.id DESC LIMIT ${Math.min(5000, +limit || 500)} OFFSET ${+offset || 0}`).all(p);
  return ids.map((r) => getTxn(r.id));
}
// Create or update a transaction. body: { date, kind, amount, payee, note, account_id, to_account_id, lines:[{item_id, amount}], cleared, recurring_id, occ_date }
function saveTxn(uid, body, id = null, origin = null) {
  const prev = id ? getTxn(id) : null;
  if (id && !prev) notFound('Transaction not found');
  const date = body.date ?? prev?.date ?? today();
  if (!B.isDate(date)) bad('date must be YYYY-MM-DD');
  const kind = body.kind ?? prev?.kind ?? 'expense';
  if (!['expense', 'income', 'transfer'].includes(kind)) bad('kind must be expense, income or transfer');
  const amount = body.amount !== undefined ? Math.abs(cents(body.amount)) : prev?.amount;
  if (!(amount > 0)) bad('Enter an amount');
  const account_id = body.account_id !== undefined ? (body.account_id ? +body.account_id : null) : prev ? prev.account_id : defaultAccount();
  const to_account_id = kind === 'transfer' ? (body.to_account_id !== undefined ? (body.to_account_id ? +body.to_account_id : null) : prev?.to_account_id) : null;
  if (kind === 'transfer' && (!account_id || !to_account_id || account_id === to_account_id)) bad('Pick two different accounts for a transfer');
  let lines = body.lines !== undefined ? body.lines : body.item_id !== undefined ? [{ item_id: body.item_id, amount }] : prev?.lines;
  if (kind === 'transfer') lines = [];
  else {
    lines = (lines?.length ? lines : [{ item_id: null, amount }]).map((l) => ({ item_id: l.item_id ? +l.item_id : null, amount: Math.abs(cents(l.amount ?? amount)), note: str(l.note) })).filter((l) => l.amount > 0);
    if (lines.length === 1) lines[0].amount = amount;
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    if (sum !== amount) bad(`Split lines add up to ${$(sum)} but the transaction is ${$(amount)}`);
    for (const l of lines) if (l.item_id && !q('SELECT 1 FROM items WHERE id = ?').get(l.item_id)) bad('Unknown category');
  }
  const payee = str(body.payee ?? prev?.payee ?? '', 120), note = str(body.note ?? prev?.note ?? '', 500);
  let recurring_id = body.recurring_id !== undefined ? (body.recurring_id ? +body.recurring_id : null) : prev?.recurring_id ?? null;
  let occ_date = body.occ_date !== undefined ? body.occ_date || null : prev?.occ_date ?? null;
  const reviewed = body.reviewed !== undefined ? (body.reviewed ? 1 : 0) : 1;
  // Paying a scheduled bill: link it to the nearest unpaid occurrence of a bill in the same category (or with the same payee).
  if ((!id || (prev && !prev.reviewed)) && reviewed && !recurring_id && kind === 'expense' && lines.length === 1 && lines[0].item_id && body.autolink !== false) {
    const pk = SF.payeeKey(payee);
    const cand = scheduled(B.addDays(date, -12), B.addDays(date, 12)).filter((s) => s.type === 'bill' && (s.item_id === lines[0].item_id || (pk && SF.payeeKey(s.payee || s.name) === pk)) && s.status !== 'paid' && s.status !== 'skipped')
      .sort((a, b) => Math.abs(B.dayDiff(a.date, date)) - Math.abs(B.dayDiff(b.date, date)))[0];
    if (cand) { recurring_id = cand.id; occ_date = cand.date; }
  }
  const now = Date.now();
  const tid = tx(() => {
    let tid = id;
    const cleared = body.cleared !== undefined ? (body.cleared ? 1 : 0) : prev?.cleared ?? 0;
    const suggest = body.suggest_item_id !== undefined ? body.suggest_item_id : prev?.suggest_item_id ?? null;
    if (id) q('UPDATE txns SET date=?, kind=?, amount=?, payee=?, note=?, account_id=?, to_account_id=?, cleared=?, recurring_id=?, occ_date=?, reviewed=?, suggest_item_id=?, updated=? WHERE id=?')
      .run(date, kind, amount, payee, note, account_id, to_account_id, cleared, recurring_id, occ_date, reviewed, suggest, now, id);
    else tid = Number(q('INSERT INTO txns(date, kind, amount, payee, note, account_id, to_account_id, cleared, recurring_id, occ_date, import_hash, user_id, source, created, updated, bank_id, raw_payee, reviewed, suggest_item_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(date, kind, amount, payee, note, account_id, to_account_id, cleared, recurring_id, occ_date, body.import_hash || null, uid ?? null, str(body.source || 'web', 20), now, now, body.bank_id || null, str(body.raw_payee || '', 300), reviewed, suggest).lastInsertRowid);
    q('DELETE FROM lines WHERE txn_id = ?').run(tid);
    for (const l of lines) q('INSERT INTO lines(txn_id, item_id, amount, note) VALUES (?, ?, ?, ?)').run(tid, l.item_id, l.amount, l.note);
    if (reviewed && lines.length === 1 && lines[0].item_id && payee && kind !== 'transfer') learnPayee(payee, lines[0].item_id);
    // Renaming a bank payee teaches Ledger the name to use next time.
    if (prev?.raw_payee && payee && payee !== prev.payee) q('INSERT OR REPLACE INTO payee_names(key, name) VALUES (?, ?)').run(SF.payeeKey(SF.cleanPayee(prev.raw_payee)), payee);
    return tid;
  });
  const t = getTxn(tid);
  if (!body.quiet) {
    changed(origin, 'txns');
    setImmediate(() => { checkPaidOff().catch(() => {}); envelopeAlerts(t, uid).catch(() => {}); });
  }
  return t;
}
function deleteTxn(uid, id, origin) {
  const t = getTxn(id);
  if (!t) notFound();
  q('DELETE FROM txns WHERE id = ?').run(id);
  forgetBank(t);
  log(uid, 'delete', `Deleted ${t.kind} ${$(t.amount)} ${t.payee} on ${t.date}`, t);
  changed(origin, 'txns');
  setImmediate(() => checkPaidOff().catch(() => {}));
  return t;
}
function setPlan(month, itemId, amount) {
  if (!B.isMonth(month)) bad('month must be YYYY-MM');
  if (amount) q('INSERT INTO plans(month, item_id, amount) VALUES (?, ?, ?) ON CONFLICT(month, item_id) DO UPDATE SET amount = excluded.amount').run(month, itemId, amount);
  else q('DELETE FROM plans WHERE month = ? AND item_id = ?').run(month, itemId);
}
function moveMoney(uid, month, fromId, toId, amount, origin = null) {
  const items = new Map(itemsFlat().map((i) => [i.id, i]));
  if (fromId && !items.get(fromId)) bad('Unknown category');
  if (!items.get(toId)) bad('Unknown category');
  tx(() => {
    const cur = (id) => q('SELECT amount FROM plans WHERE month = ? AND item_id = ?').get(month, id)?.amount || 0;
    if (fromId) setPlan(month, fromId, cur(fromId) - amount);
    setPlan(month, toId, cur(toId) + amount);
    log(uid, 'move', `Moved ${$(amount)} from ${fromId ? items.get(fromId).name : 'Left to budget'} to ${items.get(toId).name} (${B.monthLabel(month)})`);
  });
  changed(origin, 'plans');
}

// ---- notifications
const DEFAULT_PREFS = { notify: {}, digest: { on: true, time: '08:00' }, alerts: true, planReminder: true, bank: true, insights: true };
const prefsOf = (u) => { const p = JSON.parse(u.prefs || '{}'); return { ...DEFAULT_PREFS, ...p, notify: { ...(p.notify || {}) }, digest: { ...DEFAULT_PREFS.digest, ...(p.digest || {}) } }; };
const link = (path) => (PUBLIC_URL ? `${PUBLIC_URL}/#${path}` : undefined);
const once = (key) => q('INSERT OR IGNORE INTO notify_log(key, at) VALUES (?, ?)').run(key, Date.now()).changes > 0;
async function notifyUser(u, msg) {
  const prefs = prefsOf(u);
  if (!hasChannel(prefs)) return [];
  const r = await deliver(prefs, msg);
  for (const x of r) if (!x.ok) console.warn(`[notify] ${u.name} via ${x.channel}: ${x.error}`);
  return r;
}
async function notifyAll(kind, title, body, extra = {}) {
  for (const u of q('SELECT * FROM users').all()) {
    const p = prefsOf(u);
    if ((kind === 'alerts' && !p.alerts) || (kind === 'plan' && !p.planReminder) || (kind === 'bank' && !p.bank) || (kind === 'insights' && !p.insights)) continue;
    await notifyUser(u, { title, body, url: link('/'), ...extra }).catch(() => {});
  }
}
// Warn the household when an envelope runs low or goes negative.
async function envelopeAlerts(t, uid) {
  if (!t || t.kind !== 'expense') return;
  const month = t.date.slice(0, 7), v = monthView(month), pct = settings().low_pct;
  for (const l of t.lines) {
    if (!l.item_id) continue;
    for (const g of v.groups) for (const it of g.items) {
      if (it.id !== l.item_id || g.kind === 'income') continue;
      const budget = it.planned + it.carry;
      if (it.available < 0 && once(`over:${month}:${it.id}`)) await notifyAll('alerts', `🔴 ${it.name} is overspent`, `${it.name} is ${$(-it.available)} over for ${B.monthLabel(month)} after ${t.payee || 'a purchase'} (${$(l.amount)}). Move money from another category to cover it.`, { tags: ['red_circle'], priority: 'high' });
      else if (budget > 0 && it.available >= 0 && it.spent >= budget * pct / 100 && once(`low:${month}:${it.id}`)) await notifyAll('alerts', `🟠 ${it.name}: ${$(it.available)} left`, `${Math.round(it.spent / budget * 100)}% of ${B.monthLabel(month)}'s ${it.name} budget is spent.`, { tags: ['warning'] });
    }
  }
}
function digest() {
  const t = today(), up = scheduled(B.addDays(t, -31), B.addDays(t, 7)).filter((s) => s.status !== 'paid' && s.status !== 'skipped' && s.kind !== 'income');
  const rem = new Map(q('SELECT id, remind_days FROM recurring').all().map((r) => [r.id, r.remind_days]));
  const due = up.filter((s) => s.status === 'overdue' || s.date === t || (s.type === 'bill' ? B.dayDiff(t, s.date) <= (rem.get(s.id) ?? 2) : B.dayDiff(t, s.date) <= 3));
  const v = monthView(t.slice(0, 7));
  const over = v.groups.flatMap((g) => (g.kind === 'income' ? [] : g.items.filter((i) => i.available < 0)));
  const lines = [];
  for (const s of due) lines.push(`${s.status === 'overdue' ? '❗ Overdue' : s.date === t ? '📅 Today' : `📅 ${new Date(s.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}`}: ${s.name} ${$(s.amount)}${s.autopay ? ' (autopay)' : ''}`);
  for (const i of over) lines.push(`🔴 ${i.name} overspent by ${$(-i.available)}`);
  if (v.uncategorized.all) lines.push(`🗂️ ${v.uncategorized.all} transaction(s) need a category`);
  const cf = cashflow(t, B.addDays(t, 14));
  if (cf.low && cf.low.balance < 0) lines.push(`⚠️ Cash dips to ${$(cf.low.balance)} on ${cf.low.date}`);
  return lines.length ? { title: `💰 Budget: ${due.length ? `${due.length} bill${due.length > 1 ? 's' : ''} due` : 'heads-up'}`, body: lines.join('\n'), url: link('/calendar'), tags: ['moneybag'] } : null;
}
async function notificationTick() {
  const t = today(), hhmm = nowHHMM();
  for (const u of q('SELECT * FROM users').all()) {
    const p = prefsOf(u);
    if (!hasChannel(p)) continue;
    if (p.digest.on && hhmm >= (p.digest.time || '08:00') && once(`digest:${u.id}:${t}`)) { const d = digest(); if (d) await notifyUser(u, d).catch(() => {}); }
  }
  // Around the 25th: nudge to plan next month if nothing is budgeted yet.
  const next = B.addMonths(t.slice(0, 7), 1), s = settings();
  if (+t.slice(8) >= 25 && next <= s.end_month && hhmm >= '18:00' && once(`plan:${next}`)) {
    const v = monthView(next);
    if (v.summary.planned === 0) await notifyAll('plan', `🗓️ Time to plan ${B.monthLabel(next)}`, `Next month's budget is empty. Open Ledger → Budget → ${B.monthLabel(next, 'short')} and use “Copy last month” to start.`);
  }
  // Sunday evening: weekly spending insights.
  if (new Date(t + 'T12:00:00Z').getUTCDay() === 0 && hhmm >= '18:00' && once(`insights:${t}`)) { const m = insightsMessage(); if (m) await notifyAll('insights', m.title, m.body, { url: link('/home'), tags: ['bar_chart'] }); }
  q("DELETE FROM notify_log WHERE at < ? AND key NOT LIKE 'over:%' AND key NOT LIKE 'low:%' AND key NOT LIKE 'plan:%'").run(Date.now() - 60 * DAY);
}
// Autopay: post scheduled transactions on their date.
function runAutopay() {
  const t = today();
  for (const r of recurringList().filter((r) => r.active && r.autopay)) {
    const created = new Date(r.created).toLocaleDateString('sv', { timeZone: TZ });
    const from = [r.rule.start, created, B.addDays(t, -45)].sort().at(-1);
    for (const d of B.occurrences(r.rule, from, t)) {
      if (q('SELECT 1 FROM txns WHERE recurring_id = ? AND occ_date = ?').get(r.id, d) || q('SELECT 1 FROM skips WHERE recurring_id = ? AND occ_date = ?').get(r.id, d)) continue;
      try {
        saveTxn(null, { date: d, kind: r.kind, amount: r.amount, payee: r.payee || r.name, account_id: r.account_id, to_account_id: r.to_account_id, lines: r.kind === 'transfer' ? [] : [{ item_id: r.item_id, amount: r.amount }], recurring_id: r.id, occ_date: d, source: 'autopay', note: 'Autopay' });
        log(null, 'autopay', `Autopay posted ${r.name} ${$(r.amount)} for ${d}`);
      } catch (e) { console.warn(`[autopay] ${r.name}: ${e.message}`); }
    }
  }
}

// ================================================================= routes
const routes = [];
const route = (method, path, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, ...opts });
};
const loginAttempts = new Map();
const throttle = (req) => { const a = loginAttempts.get(clientIp(req)) || { n: 0, until: 0 }; if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts – try again in a minute'); return a; };
const failed = (req, a) => { a.n++; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; } loginAttempts.set(clientIp(req), a); };

function createUser({ name, email, password, color }) {
  if (!name || !email || !password) bad('Name, email and password are required');
  if (String(password).length < 8) bad('Password must be at least 8 characters');
  if (q('SELECT 1 FROM users WHERE email = ?').get(String(email).trim())) bad('That email is already in use');
  return Number(q('INSERT INTO users(name, email, pw, color, ics_token, created) VALUES (?, ?, ?, ?, ?, ?)').run(str(name, 60), String(email).trim(), hashPw(String(password)), color || '#2a78d6', token(18), Date.now()).lastInsertRowid);
}
function newSession(req, res, uid) {
  const sid = token(32);
  q('INSERT INTO sessions(token, user_id, expires) VALUES (?, ?, ?)').run(sid, uid, Date.now() + SESSION_DAYS * DAY);
  res.setHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
}
function seedBudget(blank = false) {
  tx(() => {
    GROUPS.forEach((g, gi) => {
      if (blank && g.kind !== 'income' && !g.debt) return;
      const gid = Number(q('INSERT INTO groups(name, emoji, color, kind, is_debt, sort) VALUES (?, ?, ?, ?, ?, ?)').run(g.name, g.emoji, g.color, g.kind || 'expense', g.debt ? 1 : 0, gi).lastInsertRowid);
      (blank ? g.items.slice(0, 1) : g.items).forEach(([name, emoji, o = {}], ii) => q('INSERT INTO items(group_id, name, emoji, sort, rollover, goal_amount, due_day, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(gid, name, emoji, ii, o.rollover ? 1 : 0, o.goal ?? null, o.due ?? null, o.aliases || ''));
    });
    ACCOUNTS.forEach(([name, kind], i) => q('INSERT INTO accounts(name, kind, sort) VALUES (?, ?, ?)').run(name, kind, i));
    setKv('start_month', '2026-11'); setKv('end_month', '2027-12');
  });
}

route('GET', '/api/status', () => ({ setup: q('SELECT COUNT(*) c FROM users').get().c === 0 }), { public: true });
route('POST', '/api/setup', ({ body, req, res }) => {
  if (q('SELECT COUNT(*) c FROM users').get().c) throw new HttpError(403, 'Already set up');
  const uid = createUser(body);
  if (body.household) setKv('household', str(body.household, 60));
  seedBudget(!!body.blank);
  newSession(req, res, uid);
  return { ok: true };
}, { public: true });
route('POST', '/api/login', ({ body, res, req }) => {
  const a = throttle(req);
  const u = q('SELECT * FROM users WHERE email = ?').get(String(body.email || '').trim());
  if (!u || !checkPw(String(body.password || ''), u.pw)) { failed(req, a); throw new HttpError(401, 'Wrong email or password'); }
  if (u.totp_secret) {
    if (!body.code) return { totp: true };
    if (!checkSecondFactor(u, body.code)) { failed(req, a); throw new HttpError(401, 'That code didn’t work – use the current code from your authenticator app, or a recovery code'); }
  }
  loginAttempts.delete(clientIp(req));
  newSession(req, res, u.id);
  return { ok: true };
}, { public: true });
function checkSecondFactor(u, code) {
  const step = verifyTotp(u.totp_secret, code, u.totp_last);
  if (step) { q('UPDATE users SET totp_last = ? WHERE id = ?').run(step, u.id); return true; }
  const left = useRecoveryCode(JSON.parse(u.recovery || '[]'), code);
  if (left) { q('UPDATE users SET recovery = ? WHERE id = ?').run(JSON.stringify(left), u.id); return true; }
  return false;
}
const pendingTotp = new Map();
route('POST', '/api/2fa/setup', ({ user }) => { const secret = newSecret(); pendingTotp.set(user.id, { secret, exp: Date.now() + 15 * 60000 }); return { secret, uri: otpauthUri(secret, user.email) }; });
route('POST', '/api/2fa/enable', ({ user, body }) => {
  const p = pendingTotp.get(user.id);
  if (!p || p.exp < Date.now()) bad('Setup expired – start again');
  const step = verifyTotp(p.secret, body.code);
  if (!step) bad('That code didn’t match. Check the time on your phone is correct and try the newest code.');
  const { codes, hashes } = newRecoveryCodes();
  q('UPDATE users SET totp_secret = ?, totp_last = ?, recovery = ? WHERE id = ?').run(p.secret, step, JSON.stringify(hashes), user.id);
  pendingTotp.delete(user.id);
  return { codes };
});
route('POST', '/api/2fa/disable', ({ user, body }) => {
  if (!checkPw(String(body.password || ''), q('SELECT pw FROM users WHERE id = ?').get(user.id).pw)) bad('Password is wrong');
  q('UPDATE users SET totp_secret = NULL, totp_last = NULL, recovery = NULL WHERE id = ?').run(user.id);
  return { ok: true };
});
route('POST', '/api/logout', ({ req, res }) => { q('DELETE FROM sessions WHERE token = ?').run(cookies(req).sid || ''); res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0'); return { ok: true }; });
route('GET', '/api/me', ({ user }) => ({
  user, users: q('SELECT id, name, color FROM users ORDER BY id').all(), settings: settings(), today: today(), tz: TZ, publicUrl: PUBLIC_URL || null,
  security: (({ t, r }) => ({ totp: !!t, recoveryLeft: r ? JSON.parse(r).length : 0 }))(q('SELECT totp_secret AS t, recovery AS r FROM users WHERE id = ?').get(user.id)),
}));
route('POST', '/api/users', ({ body }) => ({ id: createUser(body) }));
route('PATCH', '/api/users/me', ({ user, body }) => {
  if (body.name) q('UPDATE users SET name = ? WHERE id = ?').run(str(body.name, 60), user.id);
  if (body.color) q('UPDATE users SET color = ? WHERE id = ?').run(str(body.color, 20), user.id);
  if (body.password) {
    if (!checkPw(String(body.current || ''), q('SELECT pw FROM users WHERE id = ?').get(user.id).pw)) bad('Current password is wrong');
    if (String(body.password).length < 8) bad('Password must be at least 8 characters');
    q('UPDATE users SET pw = ? WHERE id = ?').run(hashPw(body.password), user.id);
  }
  if (body.rotateIcs) q('UPDATE users SET ics_token = ? WHERE id = ?').run(token(18), user.id);
  return q('SELECT id, name, email, color, ics_token FROM users WHERE id = ?').get(user.id);
});
route('GET', '/api/stream', ({ req, res, user }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const c = { res, uid: user.id };
  clients.add(c);
  req.on('close', () => clients.delete(c));
}, { stream: true });

// ---- settings
route('GET', '/api/settings', () => settings());
route('PUT', '/api/settings', ({ body, user, origin }) => {
  if (body.start_month !== undefined) { if (!B.isMonth(body.start_month)) bad('start month must be YYYY-MM'); setKv('start_month', body.start_month); }
  if (body.end_month !== undefined) { if (!B.isMonth(body.end_month)) bad('end month must be YYYY-MM'); setKv('end_month', body.end_month); }
  const s = settings();
  if (s.end_month < s.start_month) { setKv('end_month', s.start_month); }
  if (body.week_start !== undefined) setKv('week_start', +body.week_start ? 1 : 0);
  if (body.household !== undefined) setKv('household', str(body.household, 60) || 'Our budget');
  if (body.low_pct !== undefined) setKv('low_pct', Math.max(50, Math.min(100, +body.low_pct || 90)));
  if (body.large_charge !== undefined) setKv('large_charge', Math.max(0, cents(body.large_charge)));
  if (body.low_balance !== undefined) setKv('low_balance', Math.max(0, cents(body.low_balance)));
  if (body.snowball_extra !== undefined) { const c = Math.max(0, cents(body.snowball_extra)); setKv('snowball_extra', c); log(user.id, 'debt', `Snowball extra set to ${$(c)}/month`); }
  changed(origin, 'settings');
  return settings();
});

// ---- budget
route('GET', '/api/budget/:month', ({ params }) => monthView(params.month));
route('PUT', '/api/plans', ({ body, origin }) => {
  const items = Array.isArray(body.items) ? body.items : [{ item_id: body.item_id, amount: body.amount }];
  const months = Array.isArray(body.months) ? body.months : [body.month];
  tx(() => { for (const m of months) for (const it of items) setPlan(m, +it.item_id, cents(it.amount ?? 0)); });
  changed(origin, 'plans');
  return { ok: true };
});
// Fill a month's plan: from last month's plan, last month's actual spending, 3-month average, each item's default, or zero.
route('POST', '/api/plans/fill', ({ body, user, origin }) => {
  const months = (Array.isArray(body.months) ? body.months : [body.month]).filter(B.isMonth);
  if (!months.length) bad('Pick a month');
  const mode = body.mode || 'last';
  const only = body.only_empty !== false;
  const ids = Array.isArray(body.item_ids) ? new Set(body.item_ids.map(Number)) : null;
  let n = 0;
  tx(() => {
    for (const m of months.sort()) {
      const prev = B.addMonths(m, -1);
      const items = itemsFlat().filter((i) => !i.archived && (!ids || ids.has(i.id)));
      const act = activityMap(B.addMonths(m, -3), prev, items);
      for (const i of items) {
        const cur = q('SELECT amount FROM plans WHERE month = ? AND item_id = ?').get(m, i.id)?.amount || 0;
        if (only && cur) continue;
        let v = 0;
        if (mode === 'last') v = q('SELECT amount FROM plans WHERE month = ? AND item_id = ?').get(prev, i.id)?.amount || 0;
        else if (mode === 'spent') v = Math.max(0, act.get(prev)?.get(i.id) || 0);
        else if (mode === 'average') v = Math.max(0, Math.round([1, 2, 3].reduce((s, k) => s + (act.get(B.addMonths(m, -k))?.get(i.id) || 0), 0) / 3));
        else if (mode === 'default') v = i.default_amount || 0;
        else if (mode === 'goal') { if (!i.goal_amount) continue; const mv = monthView(m).groups.flatMap((g) => g.items).find((x) => x.id === i.id); v = mv?.goal?.monthly ?? 0; if (!i.goal_date) continue; }
        else if (mode === 'zero') v = 0;
        if (v !== cur) { setPlan(m, i.id, v); n++; }
      }
    }
    log(user.id, 'plan', `Filled ${months.map((m) => B.monthLabel(m, 'short')).join(', ')} using ${mode}${only ? ' (empty lines only)' : ''}: ${n} line(s) changed`);
  });
  changed(origin, 'plans');
  return { changed: n };
});
route('POST', '/api/plans/move', ({ body, user, origin }) => {
  const amount = Math.abs(cents(body.amount));
  if (!amount) bad('Enter an amount');
  moveMoney(user.id, body.month, body.from ? +body.from : null, +body.to, amount, origin);
  return monthView(body.month);
});
// Whole-range grid (Year view): planned / spent / available per item per month.
route('GET', '/api/year', ({ query }) => {
  const s = settings(), from = B.isMonth(query.from) ? query.from : s.start_month, to = B.isMonth(query.to) ? query.to : s.end_month;
  const { env, items } = envState(to);
  const months = B.monthsBetween(from, to);
  const groups = q('SELECT * FROM groups WHERE archived = 0 ORDER BY sort, id').all().map((g) => ({ ...g, items: items.filter((i) => i.group_id === g.id && !i.archived).map((i) => ({ id: i.id, name: i.name, emoji: i.emoji, rollover: !!i.rollover,
    months: months.map((m) => env.get(m)?.get(i.id) || { carry: 0, planned: 0, spent: 0, available: 0 }) })) }));
  const totals = months.map((m) => B.summarize(items.filter((i) => !i.archived && !i.group_archived), env.get(m) || new Map()));
  return { months, groups, totals };
});

// ---- layout: groups & items
route('GET', '/api/layout', () => ({ groups: q('SELECT * FROM groups ORDER BY archived, sort, id').all(), items: itemsFlat() }));
route('POST', '/api/groups', ({ body, origin }) => {
  const name = str(body.name, 60); if (!name) bad('Name the group');
  const id = Number(q('INSERT INTO groups(name, emoji, color, kind, sort) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM groups))').run(name, str(body.emoji, 8), str(body.color, 20) || '#2a78d6', body.kind === 'income' ? 'income' : 'expense').lastInsertRowid);
  changed(origin, 'layout'); return { id };
});
route('PATCH', '/api/groups/:id', ({ params, body, origin }) => {
  const g = q('SELECT * FROM groups WHERE id = ?').get(+params.id); if (!g) notFound();
  for (const k of ['name', 'emoji', 'color']) if (body[k] !== undefined) q(`UPDATE groups SET ${k} = ? WHERE id = ?`).run(str(body[k], 60), g.id);
  if (body.archived !== undefined) q('UPDATE groups SET archived = ? WHERE id = ?').run(body.archived ? 1 : 0, g.id);
  changed(origin, 'layout'); return { ok: true };
});
route('DELETE', '/api/groups/:id', ({ params, user, origin }) => {
  const g = q('SELECT * FROM groups WHERE id = ?').get(+params.id); if (!g) notFound();
  const used = q('SELECT COUNT(*) c FROM lines WHERE item_id IN (SELECT id FROM items WHERE group_id = ?)').get(g.id).c;
  if (used) { q('UPDATE groups SET archived = 1 WHERE id = ?').run(g.id); log(user.id, 'layout', `Archived group ${g.name} (it has ${used} transactions)`); changed(origin, 'layout'); return { archived: true }; }
  q('DELETE FROM groups WHERE id = ?').run(g.id); log(user.id, 'layout', `Deleted group ${g.name}`);
  changed(origin, 'layout'); return { deleted: true };
});
route('POST', '/api/groups/reorder', ({ body, origin }) => { tx(() => (body.ids || []).forEach((id, i) => q('UPDATE groups SET sort = ? WHERE id = ?').run(i, +id))); changed(origin, 'layout'); return { ok: true }; });
const ITEM_FIELDS = { name: (v) => str(v, 60), emoji: (v) => str(v, 8), note: (v) => str(v, 500), aliases: (v) => str(v, 300), rollover: (v) => (v ? 1 : 0),
  goal_amount: (v) => (v === null || v === '' ? null : Math.max(0, cents(v))), goal_date: (v) => (v && B.isDate(v) ? v : null), default_amount: (v) => Math.max(0, cents(v || 0)),
  due_day: (v) => (v ? Math.max(1, Math.min(31, +v)) : null), archived: (v) => (v ? 1 : 0), group_id: (v) => { if (!q('SELECT 1 FROM groups WHERE id = ?').get(+v)) bad('Unknown group'); return +v; } };
route('POST', '/api/items', ({ body, origin }) => {
  if (!q('SELECT 1 FROM groups WHERE id = ?').get(+body.group_id)) bad('Pick a group');
  const name = str(body.name, 60); if (!name) bad('Name the category');
  const id = Number(q('INSERT INTO items(group_id, name, emoji, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM items WHERE group_id = ?))').run(+body.group_id, name, str(body.emoji, 8), +body.group_id).lastInsertRowid);
  for (const [k, f] of Object.entries(ITEM_FIELDS)) if (body[k] !== undefined && !['name', 'emoji', 'group_id'].includes(k)) q(`UPDATE items SET ${k} = ? WHERE id = ?`).run(f(body[k]), id);
  if (body.amount && B.isMonth(body.month)) setPlan(body.month, id, cents(body.amount));
  changed(origin, 'layout'); return { id };
});
route('PATCH', '/api/items/:id', ({ params, body, origin }) => {
  const it = q('SELECT * FROM items WHERE id = ?').get(+params.id); if (!it) notFound();
  for (const [k, f] of Object.entries(ITEM_FIELDS)) if (body[k] !== undefined) q(`UPDATE items SET ${k} = ? WHERE id = ?`).run(f(body[k]), it.id);
  if (body.name !== undefined) q('UPDATE debts SET name = ? WHERE item_id = ?').run(str(body.name, 60), it.id);
  changed(origin, 'layout'); return { ok: true };
});
route('DELETE', '/api/items/:id', ({ params, query, user, origin }) => {
  const it = q('SELECT * FROM items WHERE id = ?').get(+params.id); if (!it) notFound();
  const used = q('SELECT COUNT(*) c FROM lines WHERE item_id = ?').get(it.id).c;
  if (used && query.to) {
    if (!q('SELECT 1 FROM items WHERE id = ?').get(+query.to)) bad('Unknown category');
    tx(() => { q('UPDATE lines SET item_id = ? WHERE item_id = ?').run(+query.to, it.id); q('UPDATE payees SET item_id = ? WHERE item_id = ?').run(+query.to, it.id); q('DELETE FROM items WHERE id = ?').run(it.id); });
    log(user.id, 'layout', `Deleted ${it.name} and moved ${used} transaction(s)`);
  } else if (used) { q('UPDATE items SET archived = 1 WHERE id = ?').run(it.id); log(user.id, 'layout', `Archived ${it.name} (it has ${used} transactions)`); changed(origin, 'layout'); return { archived: true }; }
  else { q('DELETE FROM items WHERE id = ?').run(it.id); log(user.id, 'layout', `Deleted ${it.name}`); }
  changed(origin, 'layout'); return { deleted: true };
});
route('POST', '/api/items/reorder', ({ body, origin }) => {
  tx(() => (body.ids || []).forEach((id, i) => q('UPDATE items SET sort = ?, group_id = COALESCE(?, group_id) WHERE id = ?').run(i, body.group_id ? +body.group_id : null, +id)));
  changed(origin, 'layout'); return { ok: true };
});

// ---- accounts
route('GET', '/api/accounts', ({ query }) => accounts(B.isDate(query.asOf) ? query.asOf : '9999-12-31', { all: query.all === '1' }));
route('POST', '/api/accounts', ({ body, origin }) => {
  const name = str(body.name, 60); if (!name) bad('Name the account');
  const id = Number(q('INSERT INTO accounts(name, kind, start_balance, start_date, sort) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts))')
    .run(name, ['checking', 'savings', 'cash', 'credit'].includes(body.kind) ? body.kind : 'checking', cents(body.start_balance || 0), B.isDate(body.start_date) ? body.start_date : null).lastInsertRowid);
  changed(origin, 'accounts'); return { id };
});
route('PATCH', '/api/accounts/:id', ({ params, body, origin }) => {
  const a = q('SELECT * FROM accounts WHERE id = ?').get(+params.id); if (!a) notFound();
  if (body.name !== undefined) q('UPDATE accounts SET name = ? WHERE id = ?').run(str(body.name, 60), a.id);
  if (body.kind !== undefined && ['checking', 'savings', 'cash', 'credit'].includes(body.kind)) q('UPDATE accounts SET kind = ? WHERE id = ?').run(body.kind, a.id);
  if (body.start_balance !== undefined) q('UPDATE accounts SET start_balance = ? WHERE id = ?').run(cents(body.start_balance), a.id);
  if (body.start_date !== undefined) q('UPDATE accounts SET start_date = ? WHERE id = ?').run(B.isDate(body.start_date) ? body.start_date : null, a.id);
  if (body.archived !== undefined) q('UPDATE accounts SET archived = ? WHERE id = ?').run(body.archived ? 1 : 0, a.id);
  // Reconcile: set the balance to what the bank says by adjusting the starting balance, and mark everything up to now cleared.
  if (body.reconcile !== undefined) {
    const cur = accounts('9999-12-31', { all: true }).find((x) => x.id === a.id).balance, target = cents(body.reconcile);
    q('UPDATE accounts SET start_balance = start_balance + ? WHERE id = ?').run(target - cur, a.id);
    q('UPDATE txns SET cleared = 1 WHERE account_id = ? AND date <= ?').run(a.id, today());
    log(null, 'reconcile', `Reconciled ${a.name} to ${$(target)} (adjusted ${$(target - cur, { sign: true })})`);
  }
  changed(origin, 'accounts'); return { ok: true };
});
route('DELETE', '/api/accounts/:id', ({ params, origin }) => {
  const used = q('SELECT COUNT(*) c FROM txns WHERE account_id = ? OR to_account_id = ?').get(+params.id, +params.id).c;
  if (used) q('UPDATE accounts SET archived = 1 WHERE id = ?').run(+params.id); else q('DELETE FROM accounts WHERE id = ?').run(+params.id);
  changed(origin, 'accounts'); return { archived: !!used };
});

// ---- transactions
route('GET', '/api/txns', ({ query }) => listTxns({ ...query, uncategorized: query.uncategorized === '1', inbox: query.inbox === '1' }));
route('GET', '/api/txns/:id', ({ params }) => getTxn(+params.id) || notFound());
route('POST', '/api/txns', ({ user, body, origin }) => saveTxn(user.id, body, null, origin));
route('PUT', '/api/txns/:id', ({ user, params, body, origin }) => saveTxn(user.id, body, +params.id, origin));
route('DELETE', '/api/txns/:id', ({ user, params, origin }) => deleteTxn(user.id, +params.id, origin));
route('POST', '/api/txns/bulk', ({ user, body, origin }) => {
  const ids = (body.ids || []).map(Number);
  tx(() => {
    for (const id of ids) {
      if (body.action === 'delete') { forgetBank(q('SELECT bank_id, bank_id2 FROM txns WHERE id = ?').get(id)); q('DELETE FROM txns WHERE id = ?').run(id); continue; }
      if (body.action === 'categorize') { const t = getTxn(id); if (t && t.kind !== 'transfer' && t.lines.length <= 1) { q('DELETE FROM lines WHERE txn_id = ?').run(id); q('INSERT INTO lines(txn_id, item_id, amount) VALUES (?, ?, ?)').run(id, body.item_id ? +body.item_id : null, t.amount); if (body.item_id) { q('UPDATE txns SET reviewed = 1 WHERE id = ?').run(id); learnPayee(t.payee, +body.item_id); } } }
      if (body.action === 'approve') q('UPDATE txns SET reviewed = 1 WHERE id = ?').run(id);
      if (body.action === 'clear') q('UPDATE txns SET cleared = ? WHERE id = ?').run(body.cleared ? 1 : 0, id);
    }
    if (body.action === 'delete') log(user.id, 'delete', `Deleted ${ids.length} transaction(s)`);
  });
  changed(origin, 'txns'); setImmediate(() => checkPaidOff().catch(() => {}));
  return { ok: true, count: ids.length };
});
route('GET', '/api/payees', () => q('SELECT p.name, p.item_id, p.uses, i.name AS item_name FROM payees p LEFT JOIN items i ON i.id = p.item_id ORDER BY p.uses DESC, p.last_used DESC LIMIT 400').all());
route('POST', '/api/quick', ({ user, body, origin }) => quickEntry(user, body, origin));
route('GET', '/api/quick/parse', ({ query }) => {
  const items = itemsFlat().filter((i) => !i.archived);
  const r = B.parseQuick(query.text, items, (p) => payeeItem(p), today());
  return { ...r, item: r.item ? { id: r.item.id, name: r.item.name } : null };
});
function quickEntry(user, body, origin) {
  const items = itemsFlat().filter((i) => !i.archived);
  const r = B.parseQuick(String(body.text || ''), items.filter((i) => (body.text && /^(\+|income|got paid|paycheck|payday|received|deposit)/i.test(body.text) ? true : i.kind !== 'income')), (p) => payeeItem(p), today());
  if (!(r.amount > 0)) bad('I couldn’t find an amount. Try “42.50 Costco groceries”.');
  const kind = r.kind === 'income' || r.kind === 'refund' ? 'income' : 'expense';
  const t = saveTxn(user.id, { date: r.date || today(), kind, amount: r.amount, payee: r.payee, note: body.note || '', lines: [{ item_id: r.item?.id ?? null, amount: r.amount }], source: body.source || 'quick' }, null, origin);
  let left = '';
  if (r.item && r.item.kind !== 'income') { const it = monthView(t.date.slice(0, 7)).groups.flatMap((g) => g.items).find((i) => i.id === r.item.id); if (it) left = ` ${it.available < 0 ? `⚠️ ${it.name} is ${$(-it.available)} over` : `${$(it.available)} left in ${it.name}`}.`; }
  return { ok: true, txn: t, message: `${kind === 'income' ? 'Added' : 'Logged'} ${$(r.amount)}${r.payee ? ` · ${r.payee}` : ''} → ${r.item ? r.item.name : 'Needs category'}.${left}` };
}
// Bank CSV import. The browser parses and maps columns; rows arrive as { date, payee, amount (signed cents: negative = money out) }.
route('POST', '/api/import', ({ user, body, origin }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const acct = body.account_id ? +body.account_id : defaultAccount();
  let added = 0, skipped = 0, categorized = 0;
  const seen = new Map();
  tx(() => {
    for (const r of rows) {
      const date = B.isDate(r.date) ? r.date : B.parseDate(r.date), amt = cents(r.amount);
      if (!date || !amt) { skipped++; continue; }
      const base = `${acct}|${date}|${amt}|${String(r.payee || '').toLowerCase().trim()}`;
      const n = (seen.get(base) || 0) + 1; seen.set(base, n);
      const hash = sha(`${base}|${n}`);
      if (q('SELECT 1 FROM txns WHERE import_hash = ?').get(hash)) { skipped++; continue; }
      const kind = amt < 0 ? 'expense' : 'income';
      const item = kind === 'expense' ? payeeItem(r.payee) : null;
      if (item) categorized++;
      saveTxn(user.id, { date, kind, amount: Math.abs(amt), payee: str(r.payee, 120), account_id: acct, lines: [{ item_id: item?.id ?? null, amount: Math.abs(amt) }], import_hash: hash, cleared: 1, source: 'import' }, null, origin);
      added++;
    }
    log(user.id, 'import', `Imported ${added} transaction(s) (${skipped} skipped as duplicates/invalid)`);
  });
  return { added, skipped, categorized };
});

// ---- recurring (bills, paydays, transfers)
function recurringInput(b) {
  const rule = b.rule || {};
  if (!B.isDate(rule.start)) bad('Pick a first date');
  if (!['once', 'daily', 'weekly', 'monthly', 'semimonthly', 'yearly'].includes(rule.freq)) bad('Pick how often it repeats');
  const r = { freq: rule.freq, start: rule.start, interval: Math.max(1, +rule.interval || 1) };
  if (rule.freq === 'monthly') r.day = Math.max(1, Math.min(31, +rule.day || +rule.start.slice(8)));
  if (rule.freq === 'semimonthly') { r.day = Math.max(1, Math.min(31, +rule.day || 1)); r.day2 = Math.max(1, Math.min(31, +rule.day2 || 15)); }
  if (B.isDate(rule.end)) r.end = rule.end;
  const kind = ['expense', 'income', 'transfer'].includes(b.kind) ? b.kind : 'expense';
  const amount = Math.abs(cents(b.amount));
  if (!amount) bad('Enter an amount');
  const name = str(b.name, 80); if (!name) bad('Name it');
  return { name, kind, amount, item_id: kind === 'transfer' ? null : b.item_id ? +b.item_id : null, account_id: b.account_id ? +b.account_id : null, to_account_id: kind === 'transfer' && b.to_account_id ? +b.to_account_id : null,
    payee: str(b.payee, 120), rule: JSON.stringify(r), autopay: b.autopay ? 1 : 0, remind_days: Math.max(0, Math.min(30, +(b.remind_days ?? 2))), note: str(b.note, 500), active: b.active === false ? 0 : 1, is_sub: b.is_sub ? 1 : 0 };
}
route('GET', '/api/recurring', () => {
  const t = today();
  return recurringList().map((r) => ({ ...r, describe: B.describeRule(r.rule), next: B.occurrences(r.rule, t, B.addDays(t, 800))[0] || null }));
});
route('POST', '/api/recurring', ({ body, origin }) => {
  const r = recurringInput(body);
  const id = Number(q('INSERT INTO recurring(name, kind, amount, item_id, account_id, to_account_id, payee, rule, autopay, remind_days, note, active, is_sub, created) VALUES (:name, :kind, :amount, :item_id, :account_id, :to_account_id, :payee, :rule, :autopay, :remind_days, :note, :active, :is_sub, :created)').run({ ...r, created: Date.now() }).lastInsertRowid);
  if (r.item_id && body.set_plan) {
    for (const m of budgetMonths()) {
      const n = B.occurrences(JSON.parse(r.rule), `${m}-01`, B.lastDay(m)).length;
      if (n && !q('SELECT 1 FROM plans WHERE month = ? AND item_id = ?').get(m, r.item_id)) setPlan(m, r.item_id, n * r.amount);
    }
  }
  changed(origin, 'recurring'); setImmediate(runAutopay);
  return { id };
});
route('PUT', '/api/recurring/:id', ({ params, body, origin }) => {
  if (!q('SELECT 1 FROM recurring WHERE id = ?').get(+params.id)) notFound();
  const r = recurringInput(body);
  q('UPDATE recurring SET name=:name, kind=:kind, amount=:amount, item_id=:item_id, account_id=:account_id, to_account_id=:to_account_id, payee=:payee, rule=:rule, autopay=:autopay, remind_days=:remind_days, note=:note, active=:active, is_sub=:is_sub WHERE id=:id').run({ ...r, id: +params.id });
  changed(origin, 'recurring'); setImmediate(runAutopay);
  return { ok: true };
});
route('DELETE', '/api/recurring/:id', ({ params, user, origin }) => { const r = q('SELECT name FROM recurring WHERE id = ?').get(+params.id); q('DELETE FROM recurring WHERE id = ?').run(+params.id); if (r) log(user.id, 'bill', `Deleted bill ${r.name}`); changed(origin, 'recurring'); return { ok: true }; });
route('POST', '/api/recurring/:id/pay', ({ params, body, user, origin }) => {
  const r = recurringList().find((x) => x.id === +params.id); if (!r) notFound();
  if (!B.isDate(body.occ_date)) bad('occ_date required');
  if (q('SELECT 1 FROM txns WHERE recurring_id = ? AND occ_date = ?').get(r.id, body.occ_date)) bad('Already marked paid');
  q('DELETE FROM skips WHERE recurring_id = ? AND occ_date = ?').run(r.id, body.occ_date);
  const amount = body.amount !== undefined ? Math.abs(cents(body.amount)) : r.amount;
  return saveTxn(user.id, { date: B.isDate(body.date) ? body.date : body.occ_date <= today() ? body.occ_date : today(), kind: r.kind, amount, payee: r.payee || r.name, account_id: body.account_id ?? r.account_id, to_account_id: r.to_account_id,
    lines: r.kind === 'transfer' ? [] : [{ item_id: r.item_id, amount }], recurring_id: r.id, occ_date: body.occ_date, source: 'bill' }, null, origin);
});
route('POST', '/api/recurring/:id/skip', ({ params, body, origin }) => {
  if (!B.isDate(body.occ_date)) bad('occ_date required');
  if (body.undo) q('DELETE FROM skips WHERE recurring_id = ? AND occ_date = ?').run(+params.id, body.occ_date);
  else q('INSERT OR IGNORE INTO skips(recurring_id, occ_date) VALUES (?, ?)').run(+params.id, body.occ_date);
  changed(origin, 'recurring'); return { ok: true };
});

// ---- debts
route('GET', '/api/debts', () => {
  const s = debtSummary();
  // Debt total at the end of each month (for the progress chart): add back later payments, subtract later charges.
  const months = B.monthsBetween(B.addMonths(s.month, -11) < settings().start_month ? B.addMonths(settings().start_month, -1) : B.addMonths(s.month, -11), s.month);
  const history = months.map((m) => {
    const end = B.lastDay(m);
    let total = 0;
    for (const d of s.debts) {
      if (d.as_of > end) continue;
      const later = q(`SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN -l.amount ELSE l.amount END), 0) v FROM lines l JOIN txns t ON t.id = l.txn_id WHERE l.item_id = ? AND t.kind != 'transfer' AND t.date > ? AND t.date >= ?`).get(d.item_id, end, d.as_of).v;
      const laterAdj = q('SELECT COALESCE(SUM(amount), 0) v FROM debt_adjust WHERE debt_id = ? AND date > ? AND date >= ?').get(d.id, end, d.as_of).v;
      total += Math.max(0, d.current + later - laterAdj);
    }
    return { month: m, total };
  });
  return { ...s, history, adjustments: q('SELECT * FROM debt_adjust ORDER BY date DESC, id DESC LIMIT 200').all() };
});
route('POST', '/api/debts', ({ body, user, origin }) => {
  const name = str(body.name, 60); if (!name) bad('Name the debt');
  const balance = Math.abs(cents(body.balance)); if (!balance) bad('Enter the current balance');
  const original = body.original ? Math.max(balance, Math.abs(cents(body.original))) : balance;
  const id = tx(() => {
    const gid = ensureDebtGroup();
    const itemId = Number(q("INSERT INTO items(group_id, name, emoji, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM items WHERE group_id = ?))").run(gid, name, str(body.emoji, 8) || '💳', gid).lastInsertRowid);
    return Number(q('INSERT INTO debts(name, kind, balance, as_of, original, min_payment, due_day, item_id, note, account_id, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, str(body.kind, 30) || 'credit card', balance, B.isDate(body.as_of) ? body.as_of : today(), original, Math.abs(cents(body.min_payment || 0)), body.due_day ? Math.max(1, Math.min(31, +body.due_day)) : null, itemId, str(body.note, 500), body.account_id ? +body.account_id : null, Date.now()).lastInsertRowid);
  });
  log(user.id, 'debt', `Added debt ${name} (${$(balance)})`);
  changed(origin, 'debts'); return { id };
});
route('PATCH', '/api/debts/:id', ({ params, body, user, origin }) => {
  const d = debtList({ archived: true }).find((x) => x.id === +params.id); if (!d) notFound();
  if (body.name !== undefined) { q('UPDATE debts SET name = ? WHERE id = ?').run(str(body.name, 60), d.id); if (d.item_id) q('UPDATE items SET name = ? WHERE id = ?').run(str(body.name, 60), d.item_id); }
  if (body.kind !== undefined) q('UPDATE debts SET kind = ? WHERE id = ?').run(str(body.kind, 30), d.id);
  if (body.min_payment !== undefined) q('UPDATE debts SET min_payment = ? WHERE id = ?').run(Math.abs(cents(body.min_payment)), d.id);
  if (body.due_day !== undefined) q('UPDATE debts SET due_day = ? WHERE id = ?').run(body.due_day ? Math.max(1, Math.min(31, +body.due_day)) : null, d.id);
  if (body.original !== undefined) q('UPDATE debts SET original = ? WHERE id = ?').run(Math.abs(cents(body.original)), d.id);
  if (body.note !== undefined) q('UPDATE debts SET note = ? WHERE id = ?').run(str(body.note, 500), d.id);
  if (body.account_id !== undefined) q('UPDATE debts SET account_id = ? WHERE id = ?').run(body.account_id ? +body.account_id : null, d.id);
  if (body.archived !== undefined) { q('UPDATE debts SET archived = ? WHERE id = ?').run(body.archived ? 1 : 0, d.id); if (d.item_id) q('UPDATE items SET archived = ? WHERE id = ?').run(body.archived ? 1 : 0, d.item_id); }
  // "Update balance from statement": restart the running balance from today.
  if (body.balance !== undefined) {
    const nb = Math.abs(cents(body.balance));
    q('UPDATE debts SET balance = ?, as_of = ?, original = MAX(original, ?) WHERE id = ?').run(nb, today(), nb, d.id);
    log(user.id, 'debt', `Updated ${d.name} balance from ${$(d.current)} to ${$(nb)}`);
  }
  setImmediate(() => checkPaidOff().catch(() => {}));
  changed(origin, 'debts'); return { ok: true };
});
route('DELETE', '/api/debts/:id', ({ params, user, origin }) => {
  const d = q('SELECT * FROM debts WHERE id = ?').get(+params.id); if (!d) notFound();
  tx(() => {
    q('DELETE FROM debts WHERE id = ?').run(d.id);
    if (d.item_id) { if (q('SELECT COUNT(*) c FROM lines WHERE item_id = ?').get(d.item_id).c) q('UPDATE items SET archived = 1 WHERE id = ?').run(d.item_id); else q('DELETE FROM items WHERE id = ?').run(d.item_id); }
  });
  log(user.id, 'debt', `Deleted debt ${d.name}`);
  changed(origin, 'debts'); return { ok: true };
});
route('POST', '/api/debts/:id/adjust', ({ params, body, user, origin }) => {
  const d = q('SELECT * FROM debts WHERE id = ?').get(+params.id); if (!d) notFound();
  const amt = cents(body.amount); if (!amt) bad('Enter an amount');
  q('INSERT INTO debt_adjust(debt_id, date, amount, note, created) VALUES (?, ?, ?, ?, ?)').run(d.id, B.isDate(body.date) ? body.date : today(), amt, str(body.note, 200), Date.now());
  log(user.id, 'debt', `${amt > 0 ? 'Added charge' : 'Credit'} ${$(Math.abs(amt))} on ${d.name}`);
  setImmediate(() => checkPaidOff().catch(() => {}));
  changed(origin, 'debts'); return { ok: true };
});
route('POST', '/api/debts/:id/pay', ({ params, body, user, origin }) => {
  const d = q('SELECT * FROM debts WHERE id = ?').get(+params.id); if (!d) notFound();
  const amt = Math.abs(cents(body.amount)); if (!amt) bad('Enter an amount');
  return saveTxn(user.id, { date: B.isDate(body.date) ? body.date : today(), kind: 'expense', amount: amt, payee: d.name, account_id: body.account_id, lines: [{ item_id: d.item_id, amount: amt }], note: str(body.note) || 'Debt payment', source: 'debt' }, null, origin);
});
// Put the snowball's recommended payments into the budget for the chosen months.
route('POST', '/api/debts/apply', ({ body, user, origin }) => {
  const s = debtSummary(), cur = s.month;
  const months = (Array.isArray(body.months) ? body.months : [body.month || cur]).filter((m) => B.isMonth(m) && m >= cur);
  const byMonth = new Map(s.plan.months.map((r) => [r.month, r.payments]));
  let n = 0;
  tx(() => {
    for (const m of months) for (const d of s.debts) {
      if (!d.item_id) continue;
      const pay = (byMonth.get(m)?.[d.id] || 0) + (m === cur ? s.paidThisMonth[d.id] || 0 : 0);
      setPlan(m, d.item_id, pay); n++;
    }
    log(user.id, 'debt', `Applied the snowball plan to ${months.map((m) => B.monthLabel(m, 'short')).join(', ')}`);
  });
  changed(origin, 'plans'); return { changed: n };
});

// ---- calendar, cash flow, upcoming, reports
route('GET', '/api/calendar', ({ query }) => {
  const from = B.isDate(query.from) ? query.from : `${today().slice(0, 7)}-01`, to = B.isDate(query.to) ? query.to : B.lastDay(from.slice(0, 7));
  if (B.dayDiff(from, to) > 400) bad('Range too long');
  const txns = q(`SELECT t.id, t.date, t.kind, t.amount, t.payee, t.account_id, t.to_account_id, t.recurring_id, u.name AS user_name,
      (SELECT group_concat(COALESCE(i.emoji || ' ', '') || i.name, ', ') FROM lines l JOIN items i ON i.id = l.item_id WHERE l.txn_id = t.id) AS items,
      (SELECT COUNT(*) FROM lines l WHERE l.txn_id = t.id AND l.item_id IS NULL) AS unc,
      (SELECT g.color FROM lines l JOIN items i ON i.id = l.item_id JOIN groups g ON g.id = i.group_id WHERE l.txn_id = t.id LIMIT 1) AS color
    FROM txns t LEFT JOIN users u ON u.id = t.user_id WHERE t.date >= ? AND t.date <= ? ORDER BY t.date, t.id`).all(from, to);
  return { from, to, today: today(), txns, scheduled: scheduled(from, to), cashflow: cashflow(from, to) };
});
route('GET', '/api/upcoming', ({ query }) => upcoming(Math.min(120, +query.days || 14)));
route('GET', '/api/cashflow', ({ query }) => { const t = today(); return cashflow(B.isDate(query.from) ? query.from : t, B.isDate(query.to) ? query.to : B.addDays(t, 60)); });
route('GET', '/api/reports', ({ query }) => {
  const s = settings(), from = B.isMonth(query.from) ? query.from : s.start_month, to = B.isMonth(query.to) ? query.to : s.end_month;
  const items = itemsFlat();
  const act = activityMap(from, to, items), plans = plansMap(from, to);
  const months = B.monthsBetween(from, to);
  const groups = q('SELECT * FROM groups ORDER BY sort, id').all();
  const byGroup = months.map((m) => {
    const o = { month: m, income: 0, incomePlanned: 0, spent: 0, planned: 0, groups: {} };
    for (const i of items) {
      const a = act.get(m)?.get(i.id) || 0, p = plans.get(m)?.get(i.id) || 0;
      if (i.kind === 'income') { o.income += a; o.incomePlanned += p; continue; }
      o.spent += a; o.planned += p;
      const g = (o.groups[i.group_id] ||= { spent: 0, planned: 0 }); g.spent += a; g.planned += p;
    }
    o.uncategorized = q("SELECT COALESCE(SUM(l.amount), 0) v FROM lines l JOIN txns t ON t.id = l.txn_id WHERE l.item_id IS NULL AND t.kind = 'expense' AND t.date >= ? AND t.date <= ?").get(`${m}-01`, B.lastDay(m)).v;
    o.spent += o.uncategorized;
    return o;
  });
  const byItem = q(`SELECT l.item_id, SUM(CASE WHEN t.kind = 'income' THEN -l.amount ELSE l.amount END) v FROM lines l JOIN txns t ON t.id = l.txn_id JOIN items i ON i.id = l.item_id JOIN groups g ON g.id = i.group_id
    WHERE g.kind = 'expense' AND t.kind != 'transfer' AND t.date >= ? AND t.date <= ? GROUP BY l.item_id ORDER BY v DESC`).all(`${from}-01`, B.lastDay(to));
  const payees = q(`SELECT payee, COUNT(*) n, SUM(amount) v FROM txns WHERE kind = 'expense' AND payee != '' AND date >= ? AND date <= ? GROUP BY lower(payee) ORDER BY v DESC LIMIT 15`).all(`${from}-01`, B.lastDay(to));
  const daily = q(`SELECT date, SUM(amount) v FROM txns WHERE kind = 'expense' AND date >= ? AND date <= ? GROUP BY date`).all(`${from}-01`, B.lastDay(to));
  return { from, to, months, groups, byGroup, byItem, payees, daily, accounts: accounts(), debts: debtSummary() };
});
route('GET', '/api/activity', () => q('SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.at DESC LIMIT 200').all());

// ---- export
route('GET', '/api/export/csv', ({ res, query }) => {
  const rows = listTxns({ from: query.from, to: query.to, limit: 5000 });
  const out = [['Date', 'Kind', 'Payee', 'Category', 'Group', 'Amount', 'Account', 'To account', 'Note', 'Cleared', 'Entered by']];
  const groupOf = new Map(itemsFlat().map((i) => [i.id, i.group_name]));
  for (const t of rows) for (const l of t.lines.length ? t.lines : [{ item_name: '', amount: t.amount }])
    out.push([t.date, t.kind, t.payee, l.item_name || (t.kind === 'transfer' ? '' : 'Needs category'), groupOf.get(l.item_id) || '', ((t.kind === 'expense' ? -1 : 1) * l.amount / 100).toFixed(2), t.account_name || '', t.to_account_name || '', t.note, t.cleared ? 'yes' : '', t.user_name || '']);
  const body = '﻿' + out.map((r) => r.map(B.csvCell).join(',')).join('\r\n');
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="ledger-transactions-${today()}.csv"`, 'cache-control': 'no-store' });
  res.end(body);
}, { raw: true });
route('GET', '/api/export', ({ res }) => {
  const dump = {};
  for (const t of ['groups', 'items', 'plans', 'accounts', 'txns', 'lines', 'recurring', 'skips', 'debts', 'debt_adjust', 'payees', 'activity', 'kv']) dump[t] = q(`SELECT * FROM ${t}`).all();
  res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="ledger-export-${today()}.json"`, 'cache-control': 'no-store' });
  res.end(JSON.stringify({ app: 'ledger', version: 1, exported: new Date().toISOString(), ...dump }, null, 1));
}, { raw: true });

// ---- ICS feed of bills, paydays and debt due dates (subscribe from your phone or from Nexus)
const icsEsc = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
const fold = (l) => { const out = []; let s = l; while (Buffer.byteLength(s) > 74) { let n = 74; while (Buffer.byteLength(s.slice(0, n)) > 74) n--; out.push(s.slice(0, n)); s = ' ' + s.slice(n); } out.push(s); return out.join('\r\n'); };
route('GET', '/ics/:token', ({ params, req, res, query }) => {
  const u = q('SELECT id FROM users WHERE ics_token = ?').get(String(params.token).replace(/\.ics$/, ''));
  if (!u) notFound();
  const t = today(), stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'ledger').split(':')[0];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ledger//Budget//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEsc(settings().household)} – bills`, 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  const alarm = query.alarm === '0' ? null : 9; // 9am the day before... expressed as -PT15H from midnight
  for (const s of scheduled(B.addDays(t, -60), B.addDays(t, 400))) {
    if (s.status === 'skipped' || (query.income === '0' && s.kind === 'income')) continue;
    const d = s.date.replace(/-/g, ''), d2 = B.addDays(s.date, 1).replace(/-/g, '');
    const icon = s.kind === 'income' ? '💵' : s.type === 'debt' ? '⛓️' : s.kind === 'transfer' ? '🔁' : '🧾';
    lines.push('BEGIN:VEVENT', `UID:ledger-${s.type}-${s.id}-${d}@${host}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${d2}`,
      fold(`SUMMARY:${icsEsc(`${s.status === 'paid' ? '✅ ' : icon + ' '}${s.name} ${$(s.amount)}`)}`),
      fold(`DESCRIPTION:${icsEsc(`${s.kind === 'income' ? 'Expected income' : 'Bill'}: ${$(s.amount)}${s.item_name ? ` · ${s.item_name}` : ''}${s.autopay ? ' · autopay' : ''} · ${s.status}`)}`),
      'TRANSP:TRANSPARENT', 'CATEGORIES:Budget');
    if (alarm && s.status !== 'paid' && s.kind !== 'income' && !s.autopay) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(`${s.name} ${$(s.amount)} due`)}`, 'TRIGGER:-PT15H', 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' });
  res.end(lines.join('\r\n') + '\r\n');
}, { public: true, raw: true });

// ================================================================= bank sync (SimpleFIN), review tray, subscriptions, insights
// The SimpleFIN access URL is a credential: it's encrypted with a key kept in DATA_DIR/secret.key, which is not part of
// the database or its off-server backups.
const VAULT = SF.makeVault((() => {
  const f = join(DATA, 'secret.key');
  try { const k = readFileSync(f); if (k.length === 32) return k; } catch {}
  const k = randomBytes(32); writeFileSync(f, k, { mode: 0o600 }); return k;
})());
const localDate = (unix) => new Date(unix * 1000).toLocaleDateString('sv', { timeZone: TZ });
function forgetBank(t) { for (const b of [t?.bank_id, t?.bank_id2]) if (b) q('INSERT OR IGNORE INTO bank_ignored(bank_id) VALUES (?)').run(b); }
const bankName = (raw) => { const c = SF.cleanPayee(raw); return q('SELECT name FROM payee_names WHERE key = ?').get(SF.payeeKey(c))?.name || c; };
const sameMerchant = (a, b) => { const x = SF.payeeKey(a), y = SF.payeeKey(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)))); };

// Store one SimpleFIN /accounts response: new bank accounts, balances, and transactions (matched to anything
// you already logged by hand, paired into transfers between your own accounts, everything else into the review tray).
function importBankData(bl, data) {
  const res = { added: 0, matched: 0, transfers: 0, accounts: 0, autoFiled: 0, newIds: [] };
  tx(() => {
    for (const a of data.accounts || []) {
      const id = String(a.id), org = a.org?.name || a.org?.domain || '';
      let bal = a.balance != null && a.balance !== '' ? B.parseMoney(a.balance) : null;
      const avail = a['available-balance'] != null && a['available-balance'] !== '' ? B.parseMoney(a['available-balance']) : null;
      let ba = q('SELECT * FROM bank_accounts WHERE id = ?').get(id), fresh = false;
      const kindGuess = SF.guessKind(a.name, org);
      if (kindGuess === 'credit' && bal > 0) bal = -bal; // owed on a card is negative in Ledger
      if (!ba) {
        const nm = String(a.name || 'Account').slice(0, 60);
        let acct = q('SELECT id FROM accounts WHERE archived = 0 AND lower(name) = lower(?)').get(nm)?.id
          ?? q('SELECT id FROM accounts WHERE archived = 0 AND kind = ? AND id NOT IN (SELECT account_id FROM bank_accounts WHERE account_id IS NOT NULL) ORDER BY sort, id LIMIT 1').get(kindGuess)?.id;
        if (!acct) { acct = Number(q('INSERT INTO accounts(name, kind, start_balance, start_date, sort) VALUES (?, ?, 0, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts))').run(nm, kindGuess, bl.start_date).lastInsertRowid); fresh = true; }
        q('INSERT INTO bank_accounts(id, link_id, org, name, currency, balance, available, balance_date, account_id, enabled, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
          .run(id, bl.id, org, nm, a.currency || 'USD', bal, avail, a['balance-date'] || null, acct, Date.now());
        ba = q('SELECT * FROM bank_accounts WHERE id = ?').get(id);
        res.accounts++; (res.linked ||= new Set()).add(id);
        log(null, 'bank', `Linked ${org ? org + ' – ' : ''}${nm} to ${fresh ? 'a new' : 'your existing'} account “${q('SELECT name FROM accounts WHERE id = ?').get(acct).name}”`);
      } else q('UPDATE bank_accounts SET balance = ?, available = ?, balance_date = ?, org = ? WHERE id = ?').run(bal, avail, a['balance-date'] || null, org, id);
      if (!ba.enabled || !ba.account_id) continue;
      for (const t of (a.transactions || []).sort((x, y) => (x.posted || 0) - (y.posted || 0))) {
        if (t.pending || !t.posted) continue;
        const bid = `${id}:${t.id}`;
        if (q('SELECT 1 FROM txns WHERE bank_id = ? OR bank_id2 = ?').get(bid, bid) || q('SELECT 1 FROM bank_ignored WHERE bank_id = ?').get(bid)) continue;
        const amt = B.parseMoney(t.amount);
        if (!amt) continue;
        const date = localDate(t.transacted_at || t.posted);
        if (date < bl.start_date) continue;
        const kind = amt < 0 ? 'expense' : 'income', abs = Math.abs(amt);
        const raw = String(t.payee || t.description || t.memo || '').trim().slice(0, 300), name = bankName(raw) || 'Bank transaction';
        // 1) Something you already logged (phone quick-add, autopay, CSV): attach the bank record instead of duplicating.
        const m = q(`SELECT id, payee, account_id, date FROM txns WHERE bank_id IS NULL AND kind = ? AND amount = ? AND date BETWEEN ? AND ?`).all(kind, abs, B.addDays(date, -6), B.addDays(date, 3))
          .sort((x, y) => sameMerchant(y.payee, name) - sameMerchant(x.payee, name) || (y.account_id === ba.account_id) - (x.account_id === ba.account_id) || Math.abs(B.dayDiff(x.date, date)) - Math.abs(B.dayDiff(y.date, date)))[0];
        if (m) { q('UPDATE txns SET bank_id = ?, raw_payee = ?, account_id = ?, cleared = 1 WHERE id = ?').run(bid, raw, ba.account_id, m.id); res.matched++; continue; }
        // 2) New: suggest a category from what you've filed this payee under before (or the bill it pays).
        let sug = payeeItem(name, kind);
        if (!sug && kind === 'expense') { const r = recurringList().find((r) => r.active && r.kind === 'expense' && r.item_id && sameMerchant(r.payee || r.name, name)); if (r) sug = itemsFlat().find((i) => i.id === r.item_id) || null; }
        const uses = sug ? q('SELECT uses FROM payees WHERE key = ?').get(name.toLowerCase())?.uses || 0 : 0;
        // A scheduled bill or payday this pays: mark it paid now and suggest its category.
        const bill = scheduled(B.addDays(date, -6), B.addDays(date, 6)).filter((x) => x.type === 'bill' && x.kind === kind && x.status !== 'paid' && x.status !== 'skipped'
          && (sameMerchant(x.payee || x.name, name) || Math.abs(x.amount - abs) <= Math.max(100, x.amount * 0.02)) && (sameMerchant(x.payee || x.name, name) || !x.account_id || x.account_id === ba.account_id))
          .sort((x, y) => sameMerchant(y.payee || y.name, name) - sameMerchant(x.payee || x.name, name) || Math.abs(x.amount - abs) - Math.abs(y.amount - abs) || Math.abs(B.dayDiff(x.date, date)) - Math.abs(B.dayDiff(y.date, date)))[0];
        if (bill?.item_id && !sug) sug = itemsFlat().find((i) => i.id === bill.item_id) || null;
        const history = date < `${settings().start_month}-01`; // before the budget starts: kept for history and subscription detection only
        const auto = !history && !!(bl.auto_approve && sug && uses >= 2);
        const n = saveTxn(null, { date, kind, amount: abs, payee: name, account_id: ba.account_id, lines: [{ item_id: auto ? sug.id : null, amount: abs }], cleared: true, source: 'bank',
          reviewed: auto || history, suggest_item_id: sug?.id ?? null, bank_id: bid, raw_payee: raw, quiet: true, autolink: false,
          ...(bill && !history ? { recurring_id: bill.id, occ_date: bill.date } : {}) }, null, null);
        res.added++; if (auto) res.autoFiled++;
        // 3) Money moving between two of your linked accounts (card payment, savings transfer): one transfer, not spending + income.
        const c = q(`SELECT id, bank_id, raw_payee, account_id, kind FROM txns WHERE bank_id IS NOT NULL AND bank_id2 IS NULL AND id != ? AND kind = ? AND amount = ? AND account_id != ?
          AND account_id IN (SELECT account_id FROM bank_accounts WHERE enabled = 1) AND date BETWEEN ? AND ? AND reviewed = 0 ORDER BY abs(julianday(date) - julianday(?)) LIMIT 1`)
          .get(n.id, kind === 'expense' ? 'income' : 'expense', abs, ba.account_id, B.addDays(date, -4), B.addDays(date, 4), date);
        if (c && (SF.looksLikeTransfer(raw) || SF.looksLikeTransfer(c.raw_payee))) {
          const [out, inn] = kind === 'expense' ? [n, c] : [c, n];
          q('DELETE FROM txns WHERE id = ?').run(inn.id);
          q("UPDATE txns SET kind = 'transfer', to_account_id = ?, bank_id2 = ?, suggest_item_id = NULL WHERE id = ?").run(inn.account_id, inn.bank_id, out.id);
          q('DELETE FROM lines WHERE txn_id = ?').run(out.id);
          res.transfers++; res.added--;
          res.newIds = res.newIds.filter((x) => x !== inn.id);
          continue;
        }
        res.newIds.push(n.id);
      }
      // A newly linked account starts exactly at the bank's balance.
      if (res.linked?.has(id) && bal != null) {
        const cur = accounts('9999-12-31', { all: true }).find((x) => x.id === ba.account_id)?.balance ?? 0;
        q('UPDATE accounts SET start_balance = start_balance + ? WHERE id = ?').run(bal - cur, ba.account_id);
      }
    }
  });
  return res;
}

let bankBusy = false;
async function syncBank({ force = false, linkId = null } = {}) {
  if (bankBusy) return { busy: true };
  bankBusy = true;
  const total = { added: 0, matched: 0, transfers: 0, accounts: 0, autoFiled: 0, errors: [], bankErrors: [] };
  try {
    for (const bl of q('SELECT * FROM bank_links').all()) {
      if (linkId && bl.id !== linkId) continue;
      if (!force && bl.last_sync && Date.now() - bl.last_sync < 30 * 60000) continue;
      q('UPDATE bank_links SET last_sync = ? WHERE id = ?').run(Date.now(), bl.id);
      let access;
      try { access = VAULT.open(bl.access); }
      catch { q('UPDATE bank_links SET last_error = ? WHERE id = ?').run('Ledger can’t read the saved connection (secret.key changed). Reconnect in Settings → Bank sync.', bl.id); continue; }
      try {
        const from = bl.last_ok ? B.addDays(new Date(bl.last_ok).toLocaleDateString('sv', { timeZone: TZ }), -10) : bl.start_date;
        const start = Math.floor(Date.parse(`${from < bl.start_date ? bl.start_date : from}T00:00:00Z`) / 1000) - 86400;
        const data = await SF.fetchAccounts(access, { start });
        const r = importBankData(bl, data);
        for (const k of ['added', 'matched', 'transfers', 'accounts', 'autoFiled']) total[k] += r[k];
        total.bankErrors.push(...data.errors);
        q('UPDATE bank_links SET last_ok = ?, last_error = NULL, errors = ? WHERE id = ?').run(Date.now(), JSON.stringify(data.errors), bl.id);
        if (r.added || r.matched || r.transfers) log(null, 'bank', `Bank sync: ${r.added} new, ${r.matched} matched to entries you logged, ${r.transfers} transfer(s)${r.autoFiled ? `, ${r.autoFiled} auto-filed` : ''}`);
        setImmediate(() => bankAlerts(r.newIds).catch((e) => console.warn(`[bank] alerts: ${e.message}`)));
      } catch (e) {
        total.errors.push(e.message);
        q('UPDATE bank_links SET last_error = ? WHERE id = ?').run(e.message, bl.id);
        console.warn(`[bank] ${e.message}`);
        if (once(`bankerr:${bl.id}:${today()}`)) notifyAll('bank', '⚠️ Bank sync problem', e.message, { url: link('/settings') }).catch(() => {});
      }
    }
  } finally { bankBusy = false; }
  if (total.added || total.matched || total.transfers || total.accounts) { changed(null, 'txns'); setImmediate(() => checkPaidOff().catch(() => {})); }
  return total;
}

// Rocket-Money-style alerts for freshly imported charges.
async function bankAlerts(ids) {
  const s = settings(), t0 = today();
  const fresh = ids.map(getTxn).filter((t) => t && t.kind === 'expense');
  if (fresh.length) {
    const hist = q("SELECT id, date, amount, payee FROM txns WHERE kind = 'expense' AND date >= ?").all(B.addDays(t0, -400));
    for (const t of fresh) {
      // Subscription price changes and charges after you cancelled.
      for (const r of recurringList().filter((r) => r.kind === 'expense' && sameMerchant(r.payee || r.name, t.payee))) {
        if (r.cancelled_on && t.date > r.cancelled_on && once(`aftercancel:${t.id}`))
          await notifyAll('bank', `🚫 ${r.name} charged you after you cancelled`, `${$(t.amount)} on ${t.date}. You marked it cancelled on ${r.cancelled_on} – contact them for a refund.`, { priority: 'high', url: link('/subs') });
        else if (r.active && (r.is_sub || INS.isSubscriptionName(r.name)) && Math.abs(t.amount - r.amount) >= Math.max(50, r.amount * 0.01) && once(`price:${r.id}:${t.amount}`)) {
          await notifyAll('bank', `📈 ${r.name} ${t.amount > r.amount ? 'went up' : 'changed'}: ${$(r.amount)} → ${$(t.amount)}`, `That's ${$(Math.abs(t.amount - r.amount) * B.occurrences(r.rule, t0, B.addDays(t0, 364)).length)} a year${t.amount > r.amount ? ' more' : ''}. Ledger updated the expected amount.`, { url: link('/subs') });
          q('UPDATE recurring SET amount = ? WHERE id = ?').run(t.amount, r.id);
          log(null, 'bill', `${r.name} price changed from ${$(r.amount)} to ${$(t.amount)}`);
        }
      }
      const odd = INS.isUnusual(t, hist, s.large_charge);
      if (odd && once(`unusual:${t.id}`)) await notifyAll('bank', `👀 ${odd.reason === 'large charge' ? 'Large charge' : 'Unusual charge'}: ${t.payee} ${$(t.amount)}`, `${t.date}${odd.typical ? ` – usually about ${$(odd.typical)}` : ''}. Not you? Call your bank.`, { url: link('/inbox') });
    }
    for (const [a, b] of INS.findDuplicates(hist.filter((h) => B.dayDiff(h.date, t0) <= 10), 2)) {
      if (!fresh.some((t) => t.id === a.id || t.id === b.id) || !once(`dup:${a.id}:${b.id}`)) continue;
      await notifyAll('bank', `⚠️ Possible double charge: ${b.payee}`, `${$(b.amount)} on ${a.date} and again on ${b.date}. If that wasn't two purchases, ask the merchant for a refund.`, { url: link('/inbox') });
    }
  }
  // Low balance on checking/savings that come from the bank.
  for (const b of q("SELECT ba.*, a.name AS acct, a.kind FROM bank_accounts ba JOIN accounts a ON a.id = ba.account_id WHERE ba.enabled = 1 AND a.kind IN ('checking','savings','cash') AND ba.balance IS NOT NULL").all())
    if (s.low_balance && b.balance < s.low_balance && once(`lowbal:${b.id}:${t0}`)) await notifyAll('bank', `🪫 ${b.acct} is low: ${$(b.balance)}`, `Below your ${$(s.low_balance)} warning level. Upcoming bills are on the Ledger calendar.`, { priority: 'high', url: link('/calendar/agenda') });
}

// ---- subscriptions & recurring charges
const perYear = (rule) => ({ daily: 365, weekly: 52, monthly: 12, semimonthly: 24, yearly: 1, once: 0 }[rule.freq] || 0) / (+rule.interval || 1);
function subscriptionsView() {
  const t = today();
  const hist = q(`SELECT t.id, t.date, t.amount, t.payee, (SELECT item_id FROM lines l WHERE l.txn_id = t.id LIMIT 1) AS item_id FROM txns t WHERE t.kind = 'expense' AND t.date >= ?`).all(B.addDays(t, -400));
  const det = INS.detectRecurring(hist, t);
  const recs = recurringList().filter((r) => r.kind === 'expense');
  const items = new Map(itemsFlat().map((i) => [i.id, i]));
  const list = recs.map((r) => {
    const d = det.find((x) => sameMerchant(x.payee, r.payee || r.name));
    const last = q('SELECT date, amount FROM txns WHERE recurring_id = ? ORDER BY date DESC LIMIT 1').get(r.id) || (d ? { date: d.last, amount: d.amount } : null);
    const py = perYear(r.rule);
    return { id: r.id, name: r.name, payee: r.payee, amount: r.amount, is_sub: !!r.is_sub || INS.isSubscriptionName(r.name), active: r.active, cancelled_on: r.cancelled_on, autopay: r.autopay,
      describe: B.describeRule(r.rule), next: r.active ? B.occurrences(r.rule, t, B.addDays(t, 800))[0] || null : null, item_name: items.get(r.item_id)?.name || null,
      monthly: Math.round(r.amount * py / 12), yearly: Math.round(r.amount * py), last, change: d?.change || null, cancel_url: INS.cancelUrl(r.name), remind_days: r.remind_days };
  });
  // Already tracked if the name matches, or a bill with the same cadence charges about the same amount.
  const covered = (d) => recs.some((r) => sameMerchant(d.payee, r.payee || r.name) || (r.active && Math.abs(r.amount - d.amount) <= Math.max(100, d.amount * 0.05) && Math.abs(perYear(r.rule) - d.perYear) < 0.5));
  const detected = det.filter((d) => !covered(d) && !q('SELECT 1 FROM kv WHERE k = ?').get(`subdismiss:${d.key}`))
    .map((d) => ({ ...d, item_name: items.get(d.item_id)?.name || null, cancel_url: INS.cancelUrl(d.payee) }));
  const active = list.filter((x) => x.active);
  const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
  return { list, detected, totals: { subsMonthly: sum(active.filter((x) => x.is_sub), 'monthly'), subsYearly: sum(active.filter((x) => x.is_sub), 'yearly'), billsMonthly: sum(active, 'monthly'),
    savedYearly: sum(list.filter((x) => x.cancelled_on), 'yearly') } };
}

// ---- spending insights (Home card + Sunday notification)
function insights() {
  const t = today(), m = t.slice(0, 7), dom = +t.slice(8), pm = B.addMonths(m, -1);
  const [py, pmo] = pm.split('-').map(Number), pSame = B.ymd(py, pmo, Math.min(dom, B.daysIn(py, pmo)));
  const spend = (from, to) => q(`SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN -l.amount ELSE l.amount END), 0) v FROM lines l JOIN txns t ON t.id = l.txn_id
    LEFT JOIN items i ON i.id = l.item_id LEFT JOIN groups g ON g.id = i.group_id WHERE t.kind != 'transfer' AND (l.item_id IS NULL AND t.kind = 'expense' OR g.kind = 'expense') AND t.date BETWEEN ? AND ?`).get(from, to).v;
  const byItem = (from, to) => new Map(q(`SELECT l.item_id, SUM(CASE WHEN t.kind = 'income' THEN -l.amount ELSE l.amount END) v FROM lines l JOIN txns t ON t.id = l.txn_id JOIN items i ON i.id = l.item_id JOIN groups g ON g.id = i.group_id
    WHERE g.kind = 'expense' AND g.is_debt = 0 AND t.kind != 'transfer' AND t.date BETWEEN ? AND ? GROUP BY l.item_id`).all(from, to).map((r) => [r.item_id, r.v]));
  const week = spend(B.addDays(t, -6), t);
  const prior = [1, 2, 3, 4].map((k) => spend(B.addDays(t, -6 - 7 * k), B.addDays(t, -7 * k)));
  const typicalWeek = Math.round(prior.reduce((a, b) => a + b, 0) / 4);
  const now = byItem(`${m}-01`, t), before = byItem(`${pm}-01`, pSame), items = new Map(itemsFlat().map((i) => [i.id, i]));
  const changes = [...new Set([...now.keys(), ...before.keys()])].map((id) => ({ id, name: items.get(id)?.name, emoji: items.get(id)?.emoji, now: now.get(id) || 0, before: before.get(id) || 0 }))
    .map((x) => ({ ...x, diff: x.now - x.before })).filter((x) => x.name && x.before > 0 && Math.abs(x.diff) >= 2000).sort((a, b) => b.diff - a.diff);
  const renewals = scheduled(t, B.addDays(t, 7)).filter((s) => s.type === 'bill' && s.is_sub && s.status !== 'paid' && s.status !== 'skipped');
  return { week, typicalWeek, mtd: spend(`${m}-01`, t), lastMtd: spend(`${pm}-01`, pSame), up: changes.filter((x) => x.diff > 0).slice(0, 3), down: changes.filter((x) => x.diff < 0).slice(-3).reverse(), renewals, monthLabel: B.monthLabel(pm, 'short') };
}
function insightsMessage() {
  const i = insights();
  if (!i.week && !i.mtd) return null;
  const pct = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.round(Math.abs(a - b) / b * 100)}%` : '');
  const lines = [`This week: ${$(i.week)} spent${i.typicalWeek ? ` (typical week ${$(i.typicalWeek)}, ${pct(i.week, i.typicalWeek)})` : ''}.`,
    `Month so far: ${$(i.mtd)} vs ${$(i.lastMtd)} by this point in ${i.monthLabel} ${pct(i.mtd, i.lastMtd)}.`];
  if (i.up.length) lines.push(`Up most: ${i.up.map((x) => `${x.name} +${$(x.diff)}`).join(', ')}.`);
  if (i.renewals.length) lines.push(`Renewing this week: ${i.renewals.map((r) => `${r.name} ${$(r.amount)} (${r.date.slice(5)})`).join(', ')}.`);
  const inbox = q('SELECT COUNT(*) c FROM txns WHERE reviewed = 0').get().c;
  if (inbox) lines.push(`📥 ${inbox} bank transaction${inbox > 1 ? 's' : ''} waiting to be categorized.`);
  return { title: '📊 Your week in money', body: lines.join('\n') };
}

// ---- net worth over time (account balances at each month end, minus snowball debts not tracked as accounts)
function netWorth() {
  const t = today(), months = B.monthsBetween(B.addMonths(t.slice(0, 7), -11), t.slice(0, 7));
  const debts = debtList();
  return months.map((m) => {
    const end = m === t.slice(0, 7) ? t : B.lastDay(m);
    const acc = accounts(end);
    const assets = acc.filter((a) => a.kind !== 'credit').reduce((s, a) => s + a.balance, 0), cards = acc.filter((a) => a.kind === 'credit').reduce((s, a) => s + a.balance, 0);
    let owed = 0;
    for (const d of debts) {
      if (d.account_id || d.as_of > end) continue; // a linked debt is already counted as a (credit) account
      const later = q(`SELECT COALESCE(SUM(CASE WHEN t.kind = 'income' THEN -l.amount ELSE l.amount END), 0) v FROM lines l JOIN txns t ON t.id = l.txn_id WHERE l.item_id = ? AND t.kind != 'transfer' AND t.date > ?`).get(d.item_id, end).v;
      const laterAdj = q('SELECT COALESCE(SUM(amount), 0) v FROM debt_adjust WHERE debt_id = ? AND date > ?').get(d.id, end).v;
      owed += Math.max(0, d.current + later - laterAdj);
    }
    return { month: m, date: end, assets, cards, debts: owed, net: assets + cards - owed };
  });
}

// ---- routes
const bankState = () => ({
  links: q('SELECT id, label, start_date, auto_approve, last_sync, last_ok, last_error, errors, created FROM bank_links ORDER BY id').all().map((l) => ({ ...l, errors: JSON.parse(l.errors || '[]'), auto_approve: !!l.auto_approve })),
  accounts: q('SELECT ba.*, a.name AS account_name, a.kind AS account_kind FROM bank_accounts ba LEFT JOIN accounts a ON a.id = ba.account_id ORDER BY ba.org, ba.name').all(),
  inbox: q('SELECT COUNT(*) c FROM txns WHERE reviewed = 0').get().c, busy: bankBusy,
});
route('GET', '/api/bank', () => bankState());
route('POST', '/api/bank/connect', async ({ body, user }) => {
  const start = B.isDate(body.start_date) ? body.start_date : `${settings().start_month}-01`;
  let access;
  try { access = await SF.claim(body.token); } catch (e) { bad(e.message); }
  const id = Number(q('INSERT INTO bank_links(access, label, start_date, auto_approve, created) VALUES (?, ?, ?, ?, ?)').run(VAULT.seal(access), str(body.label || 'SimpleFIN', 60), start, body.auto_approve ? 1 : 0, Date.now()).lastInsertRowid);
  log(user.id, 'bank', `Connected bank sync (SimpleFIN), importing from ${start}`);
  const r = await syncBank({ force: true, linkId: id });
  return { ...r, state: bankState() };
});
route('POST', '/api/bank/sync', async () => ({ ...(await syncBank({ force: true })), state: bankState() }));
route('PATCH', '/api/bank/links/:id', ({ params, body }) => {
  if (body.start_date !== undefined && B.isDate(body.start_date)) q('UPDATE bank_links SET start_date = ?, last_ok = NULL WHERE id = ?').run(body.start_date, +params.id);
  if (body.auto_approve !== undefined) q('UPDATE bank_links SET auto_approve = ? WHERE id = ?').run(body.auto_approve ? 1 : 0, +params.id);
  return bankState();
});
route('DELETE', '/api/bank/links/:id', ({ params, user }) => {
  q('DELETE FROM bank_links WHERE id = ?').run(+params.id);
  log(user.id, 'bank', 'Disconnected bank sync (imported transactions were kept)');
  return bankState();
});
route('PATCH', '/api/bank/accounts/:id', ({ params, body, user, origin }) => {
  const ba = q('SELECT * FROM bank_accounts WHERE id = ?').get(params.id); if (!ba) notFound();
  if (body.enabled !== undefined) q('UPDATE bank_accounts SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, ba.id);
  if (body.account_id !== undefined) {
    let acct = body.account_id === 'new' ? Number(q('INSERT INTO accounts(name, kind, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM accounts))').run(ba.name, SF.guessKind(ba.name, ba.org)).lastInsertRowid) : +body.account_id || null;
    q('UPDATE bank_accounts SET account_id = ? WHERE id = ?').run(acct, ba.id);
    q('UPDATE txns SET account_id = ? WHERE bank_id LIKE ?').run(acct, `${ba.id}:%`);
    if (acct && ba.balance != null && body.align !== false) { // start this account at the bank's balance
      const cur = accounts('9999-12-31', { all: true }).find((x) => x.id === acct)?.balance ?? 0;
      q('UPDATE accounts SET start_balance = start_balance + ? WHERE id = ?').run(ba.balance - cur, acct);
    }
    log(user.id, 'bank', `${ba.name} now feeds ${acct ? q('SELECT name FROM accounts WHERE id = ?').get(acct).name : 'nothing'}`);
  }
  changed(origin, 'accounts');
  return bankState();
});
// Review tray (EveryDollar's "New" transactions): approve with a category, rename, split, or ignore.
route('GET', '/api/inbox', () => listTxns({ inbox: true, limit: 300 }).map((t) => ({ ...t, suggest_name: t.suggest_item_id ? itemsFlat().find((i) => i.id === t.suggest_item_id)?.name : null })));
route('POST', '/api/inbox/approve', ({ body, user, origin }) => {
  const done = [];
  tx(() => {
    for (const a of Array.isArray(body.items) ? body.items : []) {
      const t = getTxn(+a.id); if (!t) continue;
      const item = a.item_id !== undefined ? (a.item_id ? +a.item_id : null) : t.lines.length === 1 && !t.lines[0].item_id ? t.suggest_item_id : undefined;
      const upd = { reviewed: true, quiet: true };
      if (a.payee) upd.payee = a.payee;
      if (t.kind !== 'transfer' && item !== undefined && t.lines.length <= 1) upd.lines = [{ item_id: item, amount: t.amount }];
      if (t.kind !== 'transfer' && !(upd.lines?.[0]?.item_id || t.lines.some((l) => l.item_id))) continue; // needs a category first
      done.push(saveTxn(user.id, upd, t.id, origin).id);
    }
  });
  changed(origin, 'txns'); setImmediate(() => checkPaidOff().catch(() => {}));
  return { approved: done.length, ids: done };
});
route('POST', '/api/inbox/approve-suggested', ({ user, origin }) => {
  let n = 0;
  tx(() => { for (const t of listTxns({ inbox: true, limit: 1000 })) if (t.reviewed === 0 && t.kind !== 'transfer' && t.lines.length === 1 && !t.lines[0].item_id && t.suggest_item_id) { saveTxn(user.id, { reviewed: true, quiet: true, lines: [{ item_id: t.suggest_item_id, amount: t.amount }] }, t.id, origin); n++; } });
  changed(origin, 'txns'); setImmediate(() => checkPaidOff().catch(() => {}));
  return { approved: n };
});
route('GET', '/api/inbox/count', () => ({ count: q("SELECT COUNT(*) c FROM txns t WHERE t.reviewed = 0 OR (t.kind != 'transfer' AND t.date >= ? AND EXISTS (SELECT 1 FROM lines l WHERE l.txn_id = t.id AND l.item_id IS NULL))").get(`${settings().start_month}-01`).c }));
route('GET', '/api/subscriptions', () => subscriptionsView());
route('POST', '/api/subscriptions/track', ({ body, origin }) => {
  if (!B.isDate(body.next)) bad('next date required');
  const rule = { freq: body.freq === 'weekly' || body.freq === 'yearly' ? body.freq : 'monthly', interval: Math.max(1, +body.interval || 1), start: body.next };
  if (rule.freq === 'monthly') rule.day = +body.next.slice(8);
  const id = Number(q('INSERT INTO recurring(name, kind, amount, item_id, payee, rule, autopay, remind_days, is_sub, active, created) VALUES (?, \'expense\', ?, ?, ?, ?, 0, ?, ?, 1, ?)')
    .run(str(body.name || body.payee, 80), Math.abs(cents(body.amount)), body.item_id ? +body.item_id : null, str(body.payee, 120), JSON.stringify(rule), body.is_sub ? 3 : 2, body.is_sub ? 1 : 0, Date.now()).lastInsertRowid);
  changed(origin, 'recurring');
  return { id };
});
route('POST', '/api/subscriptions/dismiss', ({ body }) => { setKv(`subdismiss:${str(body.key, 120)}`, '1'); return { ok: true }; });
route('POST', '/api/recurring/:id/cancel', ({ params, body, user, origin }) => {
  const r = q('SELECT * FROM recurring WHERE id = ?').get(+params.id); if (!r) notFound();
  if (body.undo) q('UPDATE recurring SET active = 1, cancelled_on = NULL WHERE id = ?').run(r.id);
  else q('UPDATE recurring SET active = 0, cancelled_on = ? WHERE id = ?').run(B.isDate(body.date) ? body.date : today(), r.id);
  log(user.id, 'bill', `${body.undo ? 'Restored' : 'Cancelled'} ${r.name}`);
  changed(origin, 'recurring');
  return { ok: true };
});
route('GET', '/api/insights', () => insights());
route('GET', '/api/networth', () => netWorth());

// ---- notifications settings
route('GET', '/api/notify', ({ user }) => ({ prefs: prefsOf(q('SELECT prefs FROM users WHERE id = ?').get(user.id)), smtp: smtpConfigured(), pushover: pushoverConfigured() }));
route('PUT', '/api/notify', ({ user, body }) => {
  const p = prefsOf(q('SELECT prefs FROM users WHERE id = ?').get(user.id));
  const n = { ...p, ...body, notify: { ...p.notify, ...(body.notify || {}) }, digest: { ...p.digest, ...(body.digest || {}) } };
  q('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(n), user.id);
  return n;
});
route('POST', '/api/notify/test', async ({ user }) => {
  const u = q('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!hasChannel(prefsOf(u))) bad('Set up ntfy, Pushover or email first');
  const d = digest();
  return { results: await notifyUser(u, d || { title: '💰 Ledger test', body: 'Notifications work. Nothing is due right now.', url: link('/') }) };
});

// ---- Claude app connector (MCP over HTTP with OAuth 2.1 + PKCE) and token quick-add (Siri / Shortcuts)
const ACCESS_TTL = 7 * DAY, REFRESH_TTL = 180 * DAY;
const authCodes = new Map(), authRequests = new Map();
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MCP_INSTRUCTIONS = `Ledger is the household's zero-based envelope budget with a debt snowball. Amounts are in US dollars.
When the user says they spent, paid, bought or received money, call log_transaction right away with the amount, payee and the best-matching budget category (call list_categories if unsure). Afterwards tell them briefly what was logged and how much is left in that category.
Use budget_status to answer "how much is left / can I afford" questions, upcoming_bills for what's due, and debt_snowball for debt progress.
Bank transactions arrive automatically; new_transactions lists what needs a category and categorize_transaction files them. subscriptions and spending_insights cover recurring charges and trends. Today is ${'${today}'} (${TZ}).`;
function tokenUser(req, kinds) {
  // "Bearer <token>"; a bare personal token is accepted too (a common slip when building a Shortcut).
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || (/^lgp_\S+$/.test(String(req.headers.authorization || '').trim()) && kinds.includes('pat') ? [null, String(req.headers.authorization).trim()] : null);
  if (!m) return null;
  const row = q('SELECT t.id, t.kind, t.client_id, t.expires, u.id AS uid, u.name, u.email, u.color FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ?').get(sha(m[1].trim()));
  if (!row || !kinds.includes(row.kind) || (row.expires && row.expires < Date.now())) return null;
  q('UPDATE api_tokens SET last_used = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.uid, name: row.name, email: row.email, color: row.color };
}
function issueTokens(uid, clientId) {
  const access = 'lga_' + token(32), refresh = 'lgr_' + token(32), now = Date.now();
  q('INSERT INTO api_tokens(hash, user_id, kind, client_id, expires, created) VALUES (?, ?, ?, ?, ?, ?)').run(sha(access), uid, 'access', clientId, now + ACCESS_TTL, now);
  q('INSERT INTO api_tokens(hash, user_id, kind, client_id, expires, created) VALUES (?, ?, ?, ?, ?, ?)').run(sha(refresh), uid, 'refresh', clientId, now + REFRESH_TTL, now);
  q("DELETE FROM api_tokens WHERE kind IN ('access','refresh') AND expires < ?").run(now);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: 'ledger' };
}
const oauthError = (res, status, error, description) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error, error_description: description })); };
const resourceMeta = ({ req }) => ({ resource: `${baseUrl(req)}/mcp`, authorization_servers: [baseUrl(req)], bearer_methods_supported: ['header'], scopes_supported: ['ledger'], resource_name: 'Ledger' });
route('GET', '/.well-known/oauth-protected-resource', resourceMeta, { public: true });
route('GET', '/.well-known/oauth-protected-resource/mcp', resourceMeta, { public: true });
const asMeta = ({ req }) => { const b = baseUrl(req); return { issuer: b, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`, registration_endpoint: `${b}/oauth/register`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: ['ledger'] }; };
route('GET', '/.well-known/oauth-authorization-server', asMeta, { public: true });
route('GET', '/.well-known/oauth-authorization-server/mcp', asMeta, { public: true });
route('POST', '/oauth/register', ({ body, res }) => {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  const okUri = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)); } catch { return false; } };
  if (!uris.length || !uris.every(okUri)) return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https URLs');
  if (q('SELECT COUNT(*) c FROM oauth_clients').get().c >= 500) return oauthError(res, 400, 'invalid_client_metadata', 'Too many registered clients');
  const method = ['client_secret_post', 'client_secret_basic'].includes(body.token_endpoint_auth_method) ? body.token_endpoint_auth_method : 'none';
  const clientId = 'lgc_' + token(16), secret = method === 'none' ? null : 'lgs_' + token(32);
  const name = String(body.client_name || 'App').slice(0, 100);
  q('INSERT INTO oauth_clients(client_id, secret_hash, name, redirect_uris, created) VALUES (?, ?, ?, ?, ?)').run(clientId, secret ? sha(secret) : null, name, JSON.stringify(uris), Date.now());
  res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ client_id: clientId, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method }));
}, { public: true, raw: true });
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function authPage(res, { title, body, status = 200 }) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Ledger</title>
<style>:root{color-scheme:light dark;--bg:#f6f7f5;--fg:#16201a;--mute:#5d6b62;--line:#dfe5e0;--acc:#0f7a4f;--panel:#fff}@media(prefers-color-scheme:dark){:root{--bg:#0e1311;--fg:#e6ece8;--mute:#93a39a;--line:#26302b;--acc:#34c08a;--panel:#161d1a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{width:100%;max-width:400px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px}h1{font-size:21px;margin:0 0 8px}.logo{color:var(--acc);font-size:30px;font-weight:800}
p{color:var(--mute);margin:8px 0}ul{color:var(--mute);padding-left:20px;margin:8px 0 16px}input{width:100%;box-sizing:border-box;padding:10px 12px;margin:5px 0;border:1px solid var(--line);border-radius:9px;background:transparent;color:inherit;font:inherit}
.row{display:flex;gap:10px;margin-top:16px}button{flex:1;padding:11px;border-radius:9px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}button.go{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}.err{color:#dc2626}</style></head>
<body><main><div class="logo">$</div>${body}</main></body></html>`);
}
function sessionUser(req) { const sid = cookies(req).sid; return sid ? q('SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?').get(sid, Date.now()) : null; }
function consentForm(res, reqId, client, user, error) {
  authPage(res, { title: 'Connect', body: `<h1>Connect ${escH(client.name)} to Ledger</h1>
    <p><b>${escH(client.name)}</b> is asking to use your budget as ${user ? `<b>${escH(user.name)}</b>` : 'you'}. It will be able to:</p>
    <ul><li>log spending and income into budget categories</li><li>read budget balances, transactions, bills and debts</li><li>move money between categories</li></ul>
    <form method="post" action="/oauth/authorize"><input type="hidden" name="req" value="${escH(reqId)}">
    ${user ? '' : '<input name="email" type="email" placeholder="Email" autocomplete="username" required><input name="password" type="password" placeholder="Password" autocomplete="current-password" required><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Authenticator code (if two-step sign-in is on)">'}
    ${error ? `<p class="err">${escH(error)}</p>` : ''}
    <div class="row"><button name="action" value="deny" formnovalidate>Cancel</button><button class="go" name="action" value="allow">Allow</button></div></form>
    <p style="font-size:13px">You can disconnect it any time in Ledger → Settings → Phone &amp; Claude app.</p>` });
}
route('GET', '/oauth/authorize', ({ req, res, query }) => {
  const client = q('SELECT * FROM oauth_clients WHERE client_id = ?').get(String(query.client_id || ''));
  const uris = client ? JSON.parse(client.redirect_uris) : [];
  if (!client || !uris.includes(query.redirect_uri)) return authPage(res, { status: 400, title: 'Error', body: '<h1>Can’t connect</h1><p>This app isn’t registered with Ledger, or its return address doesn’t match. Remove the connector and add it again.</p>' });
  const back = (params) => { const u = new URL(query.redirect_uri); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); if (query.state) u.searchParams.set('state', query.state); res.writeHead(302, { location: u.toString() }); res.end(); };
  if (query.response_type !== 'code') return back({ error: 'unsupported_response_type' });
  if (!query.code_challenge || query.code_challenge_method !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
  const reqId = token(18);
  authRequests.set(reqId, { client_id: client.client_id, redirect_uri: query.redirect_uri, state: query.state || '', challenge: query.code_challenge, exp: Date.now() + 15 * 60000 });
  consentForm(res, reqId, client, sessionUser(req));
}, { public: true, raw: true });
route('POST', '/oauth/authorize', ({ req, res, body }) => {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) return authPage(res, { status: 403, title: 'Error', body: '<h1>Blocked</h1><p>Cross-site request.</p>' });
  const ar = authRequests.get(String(body.req || ''));
  if (!ar || ar.exp < Date.now()) return authPage(res, { status: 400, title: 'Expired', body: '<h1>This sign-in expired</h1><p>Go back to the Claude app and try connecting again.</p>' });
  const client = q('SELECT * FROM oauth_clients WHERE client_id = ?').get(ar.client_id);
  const back = (params) => { authRequests.delete(String(body.req)); const u = new URL(ar.redirect_uri); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); if (ar.state) u.searchParams.set('state', ar.state); res.writeHead(302, { location: u.toString() }); res.end(); };
  if (body.action !== 'allow') return back({ error: 'access_denied' });
  let user = sessionUser(req);
  if (!user) {
    const a = loginAttempts.get(clientIp(req)) || { n: 0, until: 0 };
    if (a.until > Date.now()) return consentForm(res, body.req, client, null, 'Too many attempts – wait a minute.');
    const u = q('SELECT * FROM users WHERE email = ?').get(String(body.email || '').trim());
    if (!u || !checkPw(String(body.password || ''), u.pw)) { failed(req, a); return consentForm(res, body.req, client, null, 'Wrong email or password.'); }
    if (u.totp_secret && !checkSecondFactor(u, body.code)) { failed(req, a); return consentForm(res, body.req, client, null, 'Enter the current 6-digit code from your authenticator app (or a recovery code).'); }
    loginAttempts.delete(clientIp(req));
    user = u;
  }
  const code = token(24);
  authCodes.set(code, { client_id: ar.client_id, redirect_uri: ar.redirect_uri, challenge: ar.challenge, uid: user.id, exp: Date.now() + 5 * 60000 });
  back({ code });
}, { public: true, raw: true });
route('POST', '/oauth/token', ({ req, res, body }) => {
  let clientId = body.client_id, secret = body.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (basic) { const [id, sec] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent); clientId = id; secret = sec; }
  const client = q('SELECT * FROM oauth_clients WHERE client_id = ?').get(String(clientId || ''));
  if (!client) return oauthError(res, 401, 'invalid_client', 'Unknown client');
  if (client.secret_hash && sha(secret || '') !== client.secret_hash) return oauthError(res, 401, 'invalid_client', 'Bad client secret');
  const ok = (data) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' }); res.end(JSON.stringify(data)); };
  if (body.grant_type === 'authorization_code') {
    const c = authCodes.get(String(body.code || ''));
    authCodes.delete(String(body.code || ''));
    if (!c || c.exp < Date.now() || c.client_id !== client.client_id) return oauthError(res, 400, 'invalid_grant', 'Code is invalid or expired');
    if (body.redirect_uri && body.redirect_uri !== c.redirect_uri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
    if (createHash('sha256').update(String(body.code_verifier || '')).digest('base64url') !== c.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
    return ok(issueTokens(c.uid, client.client_id));
  }
  if (body.grant_type === 'refresh_token') {
    const row = q("SELECT * FROM api_tokens WHERE hash = ? AND kind = 'refresh'").get(sha(body.refresh_token || ''));
    if (!row || row.client_id !== client.client_id || row.expires < Date.now()) return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
    q('DELETE FROM api_tokens WHERE id = ?').run(row.id);
    return ok(issueTokens(row.user_id, client.client_id));
  }
  return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
}, { public: true, raw: true });

const toolDeps = { q, saveTxn, monthView, itemsFlat, payeeItem, listTxns, upcoming, debtSummary, moveMoney: (uid, m, f, t, a) => moveMoney(uid, m, f, t, a, null), today, subscriptions: () => subscriptionsView(), insights: () => insights() };
async function mcpHandle(msg, user) {
  const { id, method, params = {} } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid request');
  if (id === undefined) return null;
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ledger', title: 'Ledger budget', version: '1.0.0' }, instructions: MCP_INSTRUCTIONS.replace('${today}', today()) });
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: buildTools(toolDeps, user).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,
        annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false, idempotentHint: !!t.readOnly, openWorldHint: false } })) });
    case 'tools/call': {
      const t = buildTools(toolDeps, user).find((x) => x.name === params.name);
      if (!t) return fail(-32602, `Unknown tool: ${params.name}`);
      const args = { ...(params.arguments || {}) };
      const err = validate(t.inputSchema, args);
      if (err) return reply({ content: [{ type: 'text', text: `Invalid arguments: ${err}` }], isError: true });
      try { return reply({ content: [{ type: 'text', text: String(await t.run(args)) }] }); }
      catch (e) { return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }); }
    }
    default: return fail(-32601, `Method not found: ${method}`);
  }
}
route('POST', '/mcp', async ({ req, res, body }) => {
  const user = tokenUser(req, ['access']);
  if (!user) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp", scope="ledger"` });
    return res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Connect Ledger from your Claude app to get access.' }));
  }
  const batch = Array.isArray(body);
  const out = (await Promise.all((batch ? body : [body]).map((m) => mcpHandle(m, user)))).filter(Boolean);
  if (!out.length) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(batch ? out : out[0]));
}, { public: true, raw: true });
const mcpNoStream = ({ res }) => { res.writeHead(405, { allow: 'POST' }); res.end(); };
route('GET', '/mcp', mcpNoStream, { public: true, raw: true });
route('DELETE', '/mcp', mcpNoStream, { public: true, raw: true });

// Siri / Shortcuts / scripts: POST /api/spend with a personal token. {"text":"42.50 Costco groceries"} or {"amount":42.5,"payee":"Costco","category":"Groceries"}
// ?format=text answers with one plain sentence – success or the problem – for Shortcuts' Show Notification.
route('POST', '/api/spend', ({ req, body, query }) => {
  if (query.format !== 'text') return spend(req, body);
  try { return spend(req, body).message; } catch (e) { return `⚠️ ${e.status === 500 || !e.status ? 'Ledger hit an error' : e.message}`; }
}, { public: true });
function spend(req, body) {
  const user = tokenUser(req, ['pat']);
  if (!user) throw new HttpError(401, 'Missing or invalid token – create a new one in Ledger → Settings → Phone');
  if (body.amount !== undefined) {
    const tool = buildTools(toolDeps, user).find((t) => t.name === 'log_transaction');
    const args = { ...body };
    for (const k of Object.keys(args)) if (args[k] === '' || args[k] === null) delete args[k];
    // Shortcut menus send the label they showed ("🛒 Groceries · $69 left"); keep just the name.
    if (args.category) { args.category = String(args.category).split(' · ')[0].replace(/^[^\p{L}\p{N}]+/u, '').trim(); if (!args.category || /^not sure/i.test(args.category)) delete args.category; }
    if (args.kind && !['expense', 'income', 'refund'].includes(String(args.kind).toLowerCase())) args.kind = /income|received|paid me/i.test(args.kind) ? 'income' : /refund|return/i.test(args.kind) ? 'refund' : 'expense';
    else if (args.kind) args.kind = String(args.kind).toLowerCase();
    const err = validate(tool.inputSchema, args); if (err) bad(err);
    // Short enough for a phone notification: "✓ $18.40 Chick-fil-A → Restaurants · $38.11 left of $225.00"
    const msg = tool.run({ ...args, _source: 'shortcut' }).replace(/^Logged (?:expense|income|refund) /, '✓ ').replace(/ at /, ' ').replace(` on ${today()}`, '')
      .replace(/\. ([^.]+?): (.+)$/, (m, name, rest) => ` · ${rest}`).replace(/\.$/, '');
    return { ok: true, message: msg };
  }
  const r = quickEntry(user, { ...body, source: 'shortcut' }, null);
  return { ok: true, message: r.message };
}
// The category menu for the phone Shortcut: most-used first, each with what's left this month.
route('GET', '/api/spend/categories', ({ req, query }) => {
  const user = tokenUser(req, ['pat']);
  if (!user) throw new HttpError(401, 'Missing or invalid token');
  const income = query.kind === 'income';
  const v = monthView(B.isMonth(query.month) ? query.month : today().slice(0, 7));
  const uses = new Map(q("SELECT l.item_id, COUNT(*) n FROM lines l JOIN txns t ON t.id = l.txn_id WHERE t.date >= ? AND l.item_id IS NOT NULL GROUP BY l.item_id").all(B.addDays(today(), -90)).map((r) => [r.item_id, r.n]));
  const rows = v.groups.filter((g) => (g.kind === 'income') === income).flatMap((g) => g.items).map((i, k) => ({ i, k })).sort((a, b) => (uses.get(b.i.id) || 0) - (uses.get(a.i.id) || 0) || a.k - b.k);
  const labels = rows.map(({ i }) => `${i.emoji ? i.emoji + ' ' : ''}${i.name}${income ? '' : ` · ${$(Math.abs(i.available), { cents: Math.abs(i.available) < 10000 })} ${i.available < 0 ? 'over' : 'left'}`}`);
  labels.push('❓ Not sure – sort it later');
  return query.format === 'text' ? labels.join('\n') : labels;
}, { public: true });
route('GET', '/api/spend/status', ({ req, query }) => {
  const user = tokenUser(req, ['pat']);
  if (!user) throw new HttpError(401, 'Missing or invalid token');
  return { message: buildTools(toolDeps, user).find((t) => t.name === 'budget_status').run({ category: query.category || undefined }) };
}, { public: true });
route('GET', '/api/tokens', ({ user }) => ({
  tokens: q("SELECT id, name, created, last_used FROM api_tokens WHERE user_id = ? AND kind = 'pat' ORDER BY created DESC").all(user.id),
  apps: q(`SELECT t.client_id, c.name, MIN(t.created) AS created, MAX(t.last_used) AS last_used FROM api_tokens t LEFT JOIN oauth_clients c ON c.client_id = t.client_id
    WHERE t.user_id = ? AND t.kind IN ('access','refresh') AND t.expires > ? GROUP BY t.client_id ORDER BY created DESC`).all(user.id, Date.now()),
}));
route('POST', '/api/tokens', ({ user, body }) => {
  const t = 'lgp_' + token(24);
  q("INSERT INTO api_tokens(hash, user_id, kind, name, created) VALUES (?, ?, 'pat', ?, ?)").run(sha(t), user.id, str(body.name || 'Quick add', 60), Date.now());
  return { token: t };
});
route('DELETE', '/api/tokens/:id', ({ user, params }) => { q("DELETE FROM api_tokens WHERE id = ? AND user_id = ? AND kind = 'pat'").run(+params.id, user.id); return { ok: true }; });
route('DELETE', '/api/apps/:client', ({ user, params }) => { q("DELETE FROM api_tokens WHERE user_id = ? AND client_id = ? AND kind IN ('access','refresh')").run(user.id, decodeURIComponent(params.client)); return { ok: true }; });

// ---- backups
const OFF = {
  endpoint: process.env.BACKUP_S3_ENDPOINT, bucket: process.env.BACKUP_S3_BUCKET, region: process.env.BACKUP_S3_REGION || 'us-east-1',
  accessKeyId: process.env.BACKUP_S3_KEY_ID, secretAccessKey: process.env.BACKUP_S3_SECRET, prefix: (process.env.BACKUP_S3_PREFIX || 'ledger').replace(/^\/|\/$/g, ''),
  pass: process.env.BACKUP_PASSPHRASE, dir: process.env.BACKUP_COPY_DIR, keep: +(process.env.BACKUP_REMOTE_KEEP || 30),
};
const s3Configured = () => !!(OFF.endpoint && OFF.bucket && OFF.accessKeyId && OFF.secretAccessKey);
const offsiteConfigured = () => s3Configured() || !!OFF.dir;
async function backup({ force = false } = {}) {
  const keepEnv = +(process.env.BACKUP_KEEP ?? 14);
  if (keepEnv === 0 && !force) return;
  const keep = Math.max(1, keepEnv || 0), dir = join(DATA, 'backups');
  mkdirSync(dir, { recursive: true });
  const day = today(), name = `ledger-${day}.db`;
  const files = readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  if (!files.includes(name) || force) {
    if (files.includes(name)) unlinkSync(join(dir, name));
    store.db.exec(`VACUUM INTO '${join(dir, name).replace(/'/g, "''")}'`);
    for (const f of [...new Set(files.concat(name))].sort().slice(0, -keep)) unlinkSync(join(dir, f));
    console.log(`[backup] wrote ${name}`);
  }
  if (offsiteConfigured() && (force || kv('offsite_day') !== day)) await offsiteBackup(join(dir, name), name, day);
}
async function offsiteBackup(file, name, day) {
  const status = { at: Date.now(), ok: true, targets: [], error: null };
  try {
    if (s3Configured() && !OFF.pass) throw new Error('Set BACKUP_PASSPHRASE – Ledger only uploads encrypted backups to cloud storage.');
    const ext = OFF.pass ? '.enc' : '';
    const buf = OFF.pass ? encrypt(readFileSync(file), OFF.pass) : readFileSync(file);
    if (s3Configured()) {
      const s3 = s3Client(OFF);
      await s3.put(`${OFF.prefix}/db/${name}${ext}`, buf);
      const old = (await s3.list(`${OFF.prefix}/db/`)).filter((k) => /ledger-\d{4}-\d{2}-\d{2}\.db/.test(k)).sort();
      for (const k of old.slice(0, Math.max(0, old.length - OFF.keep))) await s3.del(k);
      status.targets.push(`${OFF.bucket} (${new URL(OFF.endpoint).hostname})`);
    }
    if (OFF.dir) {
      mkdirSync(join(OFF.dir, 'db'), { recursive: true });
      writeFileSync(join(OFF.dir, 'db', name + ext), buf);
      const old = readdirSync(join(OFF.dir, 'db')).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.db/.test(f)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - OFF.keep))) unlinkSync(join(OFF.dir, 'db', f));
      status.targets.push(OFF.dir);
    }
    status.encrypted = !!OFF.pass; status.bytes = buf.length;
    setKv('offsite_day', day);
  } catch (e) {
    status.ok = false; status.error = e.message;
    console.warn(`[backup] off-server copy failed: ${e.message}`);
    notifyAll('backup', '⚠️ Ledger backup failed', `The off-server backup didn't complete: ${e.message}`).catch(() => {});
  }
  setKv('offsite_status', JSON.stringify(status));
  return status;
}
route('GET', '/api/backup', () => ({
  local: (() => { try { return readdirSync(join(DATA, 'backups')).filter((f) => f.endsWith('.db')).sort().reverse().slice(0, 5); } catch { return []; } })(),
  offsite: { configured: offsiteConfigured(), s3: s3Configured(), folder: !!OFF.dir, encrypted: !!OFF.pass, status: JSON.parse(kv('offsite_status') || 'null') },
}));
route('POST', '/api/backup/run', async () => { await backup({ force: true }); return { ok: true, offsite: JSON.parse(kv('offsite_status') || 'null') }; });

// ================================================================= server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  try {
    if (!path.startsWith('/api/') && !path.startsWith('/ics/') && !path.startsWith('/oauth/') && !path.startsWith('/.well-known/') && path !== '/mcp') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (serveAsset(req, res, path === '/' ? '/index.html' : path, url.searchParams.has('v'))) return;
      if (!extname(path)) return void serveAsset(req, res, '/index.html');
      throw new HttpError(404, 'Not found');
    }
    let match, r;
    for (r of routes) if (r.method === req.method && (match = r.re.exec(path))) break;
    if (!match) throw new HttpError(404, 'Not found');
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
    const sid = cookies(req).sid;
    const user = sid ? q('SELECT u.id, u.name, u.email, u.color, u.ics_token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?').get(sid, Date.now()) || null : null;
    if (!r.public && !user) throw new HttpError(401, 'Sign in required');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !r.public) {
      const o = req.headers.origin;
      if (o && new URL(o).host !== (req.headers['x-forwarded-host'] || req.headers.host)) throw new HttpError(403, 'Cross-origin request blocked');
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const result = await r.handler({ req, res, user, params, body, query: Object.fromEntries(url.searchParams), origin: req.headers['x-client-id'] || null });
    if (r.raw || r.stream || res.headersSent) return;
    send(req, res, 200, result ?? { ok: true });
  } catch (e) {
    if (res.headersSent) return res.end();
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(req, res, status, { error: status === 500 ? 'Server error' : e.message });
  }
});

if (process.env.NODE_ENV !== 'test') {
  setInterval(() => { try { runAutopay(); } catch (e) { console.warn(`[autopay] ${e.message}`); } q('DELETE FROM sessions WHERE expires < ?').run(Date.now()); }, 3600000).unref();
  setTimeout(() => { try { runAutopay(); } catch (e) { console.warn(`[autopay] ${e.message}`); } }, 5000).unref();
  setInterval(() => backup().catch((e) => console.warn(`[backup] ${e.message}`)), 3600000).unref();
  setTimeout(() => backup().catch((e) => console.warn(`[backup] ${e.message}`)), 60000).unref();
  setInterval(() => notificationTick().catch((e) => console.warn(`[notify] ${e.message}`)), 60000).unref();
  setInterval(() => syncBank().catch((e) => console.warn(`[bank] ${e.message}`)), Math.max(1, +(process.env.BANK_SYNC_HOURS || 6)) * 3600000).unref();
  setTimeout(() => syncBank().catch((e) => console.warn(`[bank] ${e.message}`)), 90000).unref();
}
server.keepAliveTimeout = 65000;
server.listen(PORT, HOST, () => console.log(`Ledger listening on http://${HOST}:${PORT}  (data: ${DATA}, tz: ${TZ})`));
const shutdown = () => { server.close(); for (const c of clients) c.res.end(); store.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, store, runAutopay, monthView, debtSummary, cashflow, scheduled, syncBank, importBankData };
