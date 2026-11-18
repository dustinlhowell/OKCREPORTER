import { DatabaseSync } from 'node:sqlite';
import { parseNote } from './parse.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, pw TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1', ics_token TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
  icon TEXT, pinned INTEGER NOT NULL DEFAULT 0, private INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, updated_by INTEGER,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS notes_updated ON notes(updated DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, content, content='notes', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content); END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title, content ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END;

CREATE TABLE IF NOT EXISTS links(src INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE, dst TEXT NOT NULL, PRIMARY KEY(src, dst)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
CREATE TABLE IF NOT EXISTS tags(note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY(note_id, tag)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);
CREATE TABLE IF NOT EXISTS fields(note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(note_id, key)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tasks(note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE, line INTEGER NOT NULL, text TEXT NOT NULL,
  done INTEGER NOT NULL, due TEXT, time TEXT, PRIMARY KEY(note_id, line)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tasks_due ON tasks(due) WHERE due IS NOT NULL;

CREATE TABLE IF NOT EXISTS supertags(name TEXT PRIMARY KEY, color TEXT NOT NULL DEFAULT '#8b5cf6', icon TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '[]', template TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS cards(id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE, hash TEXT NOT NULL,
  front TEXT NOT NULL, back TEXT NOT NULL, ease REAL NOT NULL DEFAULT 2.5, interval REAL NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, UNIQUE(note_id, hash));
CREATE INDEX IF NOT EXISTS cards_due ON cards(due) WHERE active = 1;

CREATE TABLE IF NOT EXISTS calendars(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0ea5e9', kind TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', shared INTEGER NOT NULL DEFAULT 1,
  last_sync INTEGER, sync_error TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  ext_id TEXT, title TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, tz TEXT,
  location TEXT, description TEXT, rrule TEXT, exdates TEXT, who TEXT NOT NULL DEFAULT '[]', note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  updated INTEGER NOT NULL, UNIQUE(calendar_id, ext_id));
CREATE INDEX IF NOT EXISTS events_range ON events(start, end);
CREATE INDEX IF NOT EXISTS events_rrule ON events(calendar_id) WHERE rrule IS NOT NULL;
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- Connected apps (OAuth clients registered by e.g. the Claude app) and access tokens (stored hashed).
CREATE TABLE IF NOT EXISTS oauth_clients(client_id TEXT PRIMARY KEY, secret_hash TEXT, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens(id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, client_id TEXT, name TEXT, expires INTEGER, created INTEGER NOT NULL, last_used INTEGER);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id, kind);

-- Version history: snapshots of a note's previous state.
CREATE TABLE IF NOT EXISTS note_revisions(id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL, content TEXT NOT NULL, author_id INTEGER, reason TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS note_revisions_note ON note_revisions(note_id, created DESC);
-- Uploaded files (images, PDFs, audio…), stored under DATA_DIR/files.
CREATE TABLE IF NOT EXISTS attachments(id INTEGER PRIMARY KEY, note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL, user_id INTEGER,
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, path TEXT NOT NULL, created INTEGER NOT NULL);
-- Flashcard review log (study streaks / charts).
CREATE TABLE IF NOT EXISTS card_reviews(id INTEGER PRIMARY KEY, card_id INTEGER, user_id INTEGER, grade INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS card_reviews_at ON card_reviews(user_id, at);
-- De-duplication for notifications that must only fire once.
CREATE TABLE IF NOT EXISTS notify_log(key TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;

// In-place upgrades for databases created by earlier versions.
function migrate(db) {
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  const add = (t, col, def) => { if (!cols(t).has(col)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${def}`); };
  add('notes', 'deleted', 'INTEGER');              // trash: time it was deleted
  add('notes', 'noai', 'INTEGER NOT NULL DEFAULT 0'); // hidden from Claude
  add('users', 'totp_secret', 'TEXT');
  add('users', 'totp_last', 'INTEGER');
  add('users', 'recovery', 'TEXT');
  add('users', 'prefs', "TEXT NOT NULL DEFAULT '{}'"); // notification settings etc.
  // Titles only need to be unique among notes that aren't in the trash.
  db.exec(`DROP INDEX IF EXISTS notes_title;
    CREATE UNIQUE INDEX IF NOT EXISTS notes_title_live ON notes(lower(title)) WHERE deleted IS NULL;
    CREATE INDEX IF NOT EXISTS notes_deleted ON notes(deleted) WHERE deleted IS NOT NULL;`);
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
           PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32000; PRAGMA mmap_size=268435456;`);
  db.exec(SCHEMA);
  migrate(db);
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const tx = (fn) => {
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  return { db, q, tx, close: () => db.close() };
}

// Re-derive links/tags/fields/tasks/cards for a note. Card scheduling survives edits (keyed by question hash).
export function indexNote(store, id, content) {
  const { q } = store;
  const p = parseNote(content);
  q('DELETE FROM links WHERE src = ?').run(id);
  for (const l of p.links) q('INSERT OR IGNORE INTO links(src, dst) VALUES (?, ?)').run(id, l);
  q('DELETE FROM tags WHERE note_id = ?').run(id);
  for (const t of p.tags) q('INSERT OR IGNORE INTO tags(note_id, tag) VALUES (?, ?)').run(id, t);
  q('DELETE FROM fields WHERE note_id = ?').run(id);
  for (const [k, v] of Object.entries(p.fields)) q('INSERT INTO fields(note_id, key, value) VALUES (?, ?, ?)').run(id, k, v);
  q('DELETE FROM tasks WHERE note_id = ?').run(id);
  for (const t of p.tasks) q('INSERT OR REPLACE INTO tasks(note_id, line, text, done, due, time) VALUES (?, ?, ?, ?, ?, ?)').run(id, t.line, t.text, t.done ? 1 : 0, t.due, t.time);
  q('UPDATE cards SET active = 0 WHERE note_id = ?').run(id);
  const now = Date.now();
  for (const c of p.cards) {
    q(`INSERT INTO cards(note_id, hash, front, back, due) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(note_id, hash) DO UPDATE SET front = excluded.front, back = excluded.back, active = 1`).run(id, c.hash, c.front, c.back, now);
  }
  return p;
}
