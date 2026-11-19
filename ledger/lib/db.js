import { DatabaseSync } from 'node:sqlite';

// Money columns are integer cents. Dates are 'YYYY-MM-DD', months 'YYYY-MM'.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, pw TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2a78d6', ics_token TEXT NOT NULL, prefs TEXT NOT NULL DEFAULT '{}',
  totp_secret TEXT, totp_last INTEGER, recovery TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS notify_log(key TEXT PRIMARY KEY, at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS api_tokens(id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, name TEXT, client_id TEXT, expires INTEGER, created INTEGER NOT NULL, last_used INTEGER);
CREATE TABLE IF NOT EXISTS oauth_clients(client_id TEXT PRIMARY KEY, secret_hash TEXT, name TEXT, redirect_uris TEXT NOT NULL, created INTEGER NOT NULL);

-- Budget layout: groups hold line items ("envelopes"). kind = 'income' | 'expense'.
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#2a78d6',
  kind TEXT NOT NULL DEFAULT 'expense', is_debt INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, rollover INTEGER NOT NULL DEFAULT 0,
  goal_amount INTEGER, goal_date TEXT, default_amount INTEGER NOT NULL DEFAULT 0, due_day INTEGER, aliases TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS items_group ON items(group_id, sort);
CREATE TABLE IF NOT EXISTS plans(month TEXT NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, amount INTEGER NOT NULL,
  PRIMARY KEY(month, item_id)) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'checking',
  start_balance INTEGER NOT NULL DEFAULT 0, start_date TEXT, sort INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);

-- kind = 'expense' | 'income' | 'transfer'. amount is always positive; lines split it across budget items
-- (a negative line on an expense is a refund). Transfers move money between accounts and have no lines.
CREATE TABLE IF NOT EXISTS txns(id INTEGER PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
  payee TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  to_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL, cleared INTEGER NOT NULL DEFAULT 0,
  recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL, occ_date TEXT, import_hash TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, source TEXT NOT NULL DEFAULT 'web', created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS txns_date ON txns(date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS txns_occ ON txns(recurring_id, occ_date) WHERE recurring_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS txns_import ON txns(import_hash) WHERE import_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS lines(id INTEGER PRIMARY KEY, txn_id INTEGER NOT NULL REFERENCES txns(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL, amount INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS lines_txn ON lines(txn_id);
CREATE INDEX IF NOT EXISTS lines_item ON lines(item_id);

-- Scheduled bills, paydays and transfers. rule = JSON { freq, start, interval, day, day2, end }
CREATE TABLE IF NOT EXISTS recurring(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'expense', amount INTEGER NOT NULL,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL, account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  to_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL, payee TEXT NOT NULL DEFAULT '', rule TEXT NOT NULL,
  autopay INTEGER NOT NULL DEFAULT 0, remind_days INTEGER NOT NULL DEFAULT 2, note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS skips(recurring_id INTEGER NOT NULL REFERENCES recurring(id) ON DELETE CASCADE, occ_date TEXT NOT NULL,
  PRIMARY KEY(recurring_id, occ_date)) WITHOUT ROWID;

-- Debt snowball. Current balance = balance - payments (lines on item_id dated on/after as_of) + adjustments.
CREATE TABLE IF NOT EXISTS debts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'credit card',
  balance INTEGER NOT NULL, as_of TEXT NOT NULL, original INTEGER NOT NULL, min_payment INTEGER NOT NULL DEFAULT 0,
  due_day INTEGER, item_id INTEGER REFERENCES items(id) ON DELETE SET NULL, note TEXT NOT NULL DEFAULT '',
  paid_off TEXT, archived INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS debt_adjust(id INTEGER PRIMARY KEY, debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  date TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);

-- Payee memory: the budget item a payee was last filed under (auto-categorizes quick entries and imports).
CREATE TABLE IF NOT EXISTS payees(key TEXT PRIMARY KEY, name TEXT NOT NULL, item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  uses INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;

-- Audit trail of budget changes (money moves, plan copies, deletes) so nothing changes silently.
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user_id INTEGER, kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT);
CREATE INDEX IF NOT EXISTS activity_at ON activity(at DESC);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  let depth = 0;
  const tx = (fn) => {
    if (depth) return fn();
    depth++; db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; }
  };
  return { db, q, tx, close: () => db.close() };
}
