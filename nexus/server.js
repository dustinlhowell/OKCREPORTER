// Nexus – self-hosted notes + knowledge base + household calendar. Zero npm dependencies.
import http from 'node:http';
import https from 'node:https';
import { readFileSync, readdirSync, mkdirSync, statSync, watch, unlinkSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { openDb, indexNote } from './lib/db.js';
import { setField, setTask } from './lib/parse.js';
import { expand } from './lib/rrule.js';
import { generateICS } from './lib/ics.js';
import { PROVIDERS, providerConfigured, authorizeUrl, exchangeCode, syncCalendar, pushEvent, deleteRemote, listRemoteCalendars } from './lib/calendar.js';
import { SUPERTAGS, NOTES } from './lib/seed.js';
import { DAY } from './lib/time.js';
import * as assistant from './lib/assistant.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_DIR || join(ROOT, 'data');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
// Mark cookies Secure only when this request arrived over HTTPS, so LAN access over http://tower:port keeps working.
const isHttps = (req) => process.env.COOKIE_SECURE === '1' || req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const SESSION_DAYS = 60;

mkdirSync(DATA, { recursive: true });
const store = openDb(process.env.DB_FILE || join(DATA, 'nexus.db'));
const { q, tx } = store;

// ---------------------------------------------------------------- static assets (pre-compressed, in memory)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
const assets = new Map();
function loadAssets(dir = join(ROOT, 'public'), prefix = '/') {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { loadAssets(p, `${prefix}${f}/`); continue; }
    const body = readFileSync(p), type = MIME[extname(f)] || 'application/octet-stream';
    const compressible = /text|json|svg|javascript|manifest/.test(type);
    assets.set(prefix + f, {
      body, type, etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`,
      gz: compressible ? gzipSync(body, { level: 9 }) : null,
      br: compressible ? brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }) : null,
    });
  }
}
function buildAssets() {
  assets.clear();
  loadAssets();
  // Cache-bust module URLs in index.html by content hash so assets can be cached immutably.
  const idx = assets.get('/index.html');
  let html = idx.body.toString();
  html = html.replace(/(src|href)="\/(app\.css|app\.js)"/g, (m, a, f) => `${a}="/${f}?v=${assets.get('/' + f).etag.slice(1, 9)}"`);
  const body = Buffer.from(html);
  assets.set('/index.html', { ...idx, body, gz: gzipSync(body), br: brotliCompressSync(body), etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"` });
}
buildAssets();
if (process.env.NODE_ENV !== 'production') {
  let t; watch(join(ROOT, 'public'), { recursive: true }, () => { clearTimeout(t); t = setTimeout(() => { try { buildAssets(); } catch {} }, 100); });
}

function serveAsset(req, res, path, versioned = false) {
  const a = assets.get(path);
  if (!a) return false;
  const headers = { 'content-type': a.type, etag: a.etag, vary: 'accept-encoding',
    'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache' };
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

// ---------------------------------------------------------------- helpers
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

function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const token = (n = 24) => randomBytes(n).toString('base64url');
const nn = (v) => (v === undefined || v === '' ? null : v);
const baseUrl = (req) => PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

function hashPw(pw) { const salt = randomBytes(16); return `scrypt$${salt.toString('base64')}$${scryptSync(pw, salt, 64).toString('base64')}`; }
function checkPw(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const h = scryptSync(pw, Buffer.from(salt, 'base64'), 64);
  return timingSafeEqual(h, Buffer.from(hash, 'base64'));
}

// ---------------------------------------------------------------- live updates (Server-Sent Events)
const clients = new Set();
function broadcast(type, data = {}, origin) {
  const msg = `event: ${type}\ndata: ${JSON.stringify({ ...data, origin })}\n\n`;
  for (const c of clients) if (!data.private || c.uid === data.owner) c.res.write(msg);
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();

// ---------------------------------------------------------------- domain
const USER_COLS = 'id, name, email, color, ics_token';
const visible = '(n.private = 0 OR n.owner_id = :uid)';

function createUser({ name, email, password, color }) {
  if (!name || !email || !password) bad('Name, email and password are required');
  if (String(password).length < 8) bad('Password must be at least 8 characters');
  if (q('SELECT 1 FROM users WHERE email = ?').get(email)) bad('That email is already registered');
  const palette = ['#6366f1', '#ec4899', '#14b8a6', '#f97316'];
  const n = q('SELECT COUNT(*) c FROM users').get().c;
  return tx(() => {
    const { lastInsertRowid: id } = q('INSERT INTO users(name, email, pw, color, ics_token, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name.trim(), email.trim(), hashPw(password), color || palette[n % palette.length], token(18), Date.now());
    q("INSERT INTO calendars(user_id, name, color, kind) VALUES (?, ?, ?, 'local')").run(id, `${name.trim()}`, color || palette[n % palette.length]);
    return Number(id);
  });
}

function newSession(req, res, uid) {
  const t = token(32);
  q('INSERT INTO sessions(token, user_id, expires) VALUES (?, ?, ?)').run(t, uid, Date.now() + SESSION_DAYS * DAY);
  res.setHeader('set-cookie', `sid=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
}

function getNote(id, uid) {
  const n = q(`SELECT n.*, u.name AS updated_by_name FROM notes n LEFT JOIN users u ON u.id = n.updated_by WHERE n.id = :id AND ${visible}`).get({ id, uid });
  if (!n) notFound('Note not found');
  const t = n.title.toLowerCase();
  n.backlinks = q(`SELECT n.id, n.title, n.icon, n.content FROM links l JOIN notes n ON n.id = l.src WHERE l.dst = :t AND n.id != :id AND ${visible} ORDER BY n.updated DESC LIMIT 200`)
    .all({ t, id, uid }).map((b) => ({ id: b.id, title: b.title, icon: b.icon, context: linkContext(b.content, n.title) }));
  n.tags = q('SELECT tag FROM tags WHERE note_id = ?').all(id).map((r) => r.tag);
  n.fields = Object.fromEntries(q('SELECT key, value FROM fields WHERE note_id = ?').all(id).map((r) => [r.key, r.value]));
  n.events = q(`SELECT e.id, e.title, e.start, e.end, e.all_day FROM events e WHERE e.note_id = ?`).all(id);
  return n;
}

function linkContext(content, title) {
  const re = new RegExp(`\\[\\[${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[#|][^\\]]*)?\\]\\]`, 'i');
  const line = content.split('\n').find((l) => re.test(l));
  return line ? line.trim().slice(0, 240) : '';
}

function uniqueTitle(title, excludeId = 0) {
  let t = String(title || 'Untitled').trim().replace(/[\[\]|#^]/g, '').slice(0, 200) || 'Untitled';
  const base = t;
  for (let i = 2; q('SELECT 1 FROM notes WHERE lower(title) = lower(?) AND id != ?').get(t, excludeId); i++) t = `${base} ${i}`;
  return t;
}

function saveNote(uid, { id, title, folder, content, icon, pinned, private: priv, base }, origin) {
  return tx(() => {
    const now = Date.now();
    let note;
    if (id) {
      const cur = q('SELECT * FROM notes WHERE id = ? AND (private = 0 OR owner_id = ?)').get(id, uid);
      if (!cur) notFound('Note not found');
      if (base && cur.updated > base && content !== undefined && content !== cur.content) {
        throw Object.assign(new HttpError(409, 'This note was changed by someone else'), { current: { content: cur.content, updated: cur.updated, updated_by: cur.updated_by } });
      }
      const newTitle = title !== undefined && title.trim() !== cur.title ? uniqueTitle(title, id) : cur.title;
      if (newTitle !== cur.title) renameLinks(cur.title, newTitle, uid, now);
      q(`UPDATE notes SET title = ?, folder = ?, content = ?, icon = ?, pinned = ?, private = ?, updated = ?, updated_by = ? WHERE id = ?`).run(
        newTitle, folder ?? cur.folder, content ?? cur.content, icon !== undefined ? nn(icon) : cur.icon,
        pinned !== undefined ? (pinned ? 1 : 0) : cur.pinned, priv !== undefined ? (priv ? 1 : 0) : cur.private, now, uid, id);
      if (content !== undefined && content !== cur.content) indexNote(store, id, content);
      note = q('SELECT id, title, folder, icon, pinned, private, owner_id, updated FROM notes WHERE id = ?').get(id);
    } else {
      const t = uniqueTitle(title);
      const { lastInsertRowid } = q(`INSERT INTO notes(title, folder, content, icon, pinned, private, owner_id, updated_by, created, updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t, folder || '', content || '', nn(icon), pinned ? 1 : 0, priv ? 1 : 0, uid, uid, now, now);
      id = Number(lastInsertRowid);
      indexNote(store, id, content || '');
      note = q('SELECT id, title, folder, icon, pinned, private, owner_id, updated FROM notes WHERE id = ?').get(id);
    }
    broadcast('note', { id: note.id, updated: note.updated, private: note.private, owner: note.owner_id }, origin);
    return note;
  });
}

// When a note is renamed, rewrite [[Old]] links everywhere (Obsidian behaviour).
function renameLinks(oldTitle, newTitle, uid, now) {
  const re = new RegExp(`\\[\\[${oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\]#|])`, 'gi');
  for (const r of q('SELECT n.id, n.content FROM links l JOIN notes n ON n.id = l.src WHERE l.dst = ?').all(oldTitle.toLowerCase())) {
    const c = r.content.replace(re, `[[${newTitle}`);
    if (c !== r.content) { q('UPDATE notes SET content = ?, updated = ?, updated_by = ? WHERE id = ?').run(c, now, uid, r.id); indexNote(store, r.id, c); }
  }
}

function notesList(uid) {
  return q(`SELECT n.id, n.title, n.folder, n.icon, n.pinned, n.private, n.updated, n.created,
      (SELECT group_concat(tag, ' ') FROM tags t WHERE t.note_id = n.id) AS tags
    FROM notes n WHERE ${visible} ORDER BY n.updated DESC`).all({ uid });
}

function writableCalendar(id, uid) {
  const c = q('SELECT * FROM calendars WHERE id = ?').get(id);
  if (!c) notFound('Calendar not found');
  if (c.kind === 'ics') bad('Subscribed calendars are read-only');
  if (c.user_id && c.user_id !== uid && (c.kind !== 'local' || !c.shared)) throw new HttpError(403, 'Not your calendar');
  return c;
}

function eventsInRange(uid, fromMs, toMs) {
  const from = new Date(fromMs).toISOString(), to = new Date(toMs).toISOString();
  const cals = q('SELECT id FROM calendars WHERE user_id IS NULL OR user_id = ? OR shared = 1').all(uid).map((c) => c.id);
  if (!cals.length) return { events: [], tasks: [] };
  const inCals = `calendar_id IN (${cals.join(',')})`;
  const out = q(`SELECT * FROM events WHERE ${inCals} AND rrule IS NULL AND start < ? AND end > ?`).all(to, from.slice(0, 10));
  for (const ev of q(`SELECT * FROM events WHERE ${inCals} AND rrule IS NOT NULL AND start < ?`).all(to)) {
    ev.exdates = ev.exdates ? JSON.parse(ev.exdates) : [];
    for (const occ of expand(ev, fromMs - DAY, toMs)) out.push({ ...ev, start: occ.start, end: occ.end, occurrence: occ.recurrence, master_start: ev.start, master_end: ev.end, exdates: undefined });
  }
  for (const e of out) e.who = JSON.parse(e.who || '[]');
  const tasks = q(`SELECT t.note_id, t.line, t.text, t.done, t.due, t.time, n.title AS note_title, n.owner_id FROM tasks t JOIN notes n ON n.id = t.note_id
    WHERE t.due >= ? AND t.due <= ? AND (n.private = 0 OR n.owner_id = ?)`).all(new Date(fromMs - DAY).toISOString().slice(0, 10), to.slice(0, 10), uid);
  return { events: out, tasks };
}

// ---------------------------------------------------------------- service health (homelab dashboard)
const health = new Map();
function ping(url) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let u; try { u = new URL(url); } catch { return resolve({ ok: false, error: 'Invalid URL' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', timeout: 5000, rejectUnauthorized: false, headers: { 'user-agent': 'Nexus-HealthCheck' } }, (r) => {
      r.resume();
      resolve({ ok: r.statusCode < 500, status: r.statusCode, ms: Math.round(performance.now() - t0) });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.message, ms: Math.round(performance.now() - t0) }));
    req.end();
  });
}
async function checkServices() {
  const rows = q(`SELECT f.note_id, f.value FROM fields f JOIN tags t ON t.note_id = f.note_id AND t.tag = 'service' WHERE f.key = 'url' AND f.value LIKE 'http%'`).all();
  const seen = new Set();
  await Promise.all(rows.map(async (r) => {
    seen.add(r.note_id);
    const res = await ping(r.value.trim());
    health.set(r.note_id, { ...res, url: r.value, at: Date.now() });
  }));
  for (const k of health.keys()) if (!seen.has(k)) health.delete(k);
  broadcast('services', {});
}

// ---------------------------------------------------------------- spaced repetition (SM-2 variant)
function review(card, grade) {
  let { ease, interval, reps, lapses } = card;
  if (grade === 0) { lapses++; reps = 0; interval = 10 / 1440; ease = Math.max(1.3, ease - 0.2); }
  else {
    reps++;
    if (reps === 1) interval = grade === 3 ? 3 : 1;
    else if (reps === 2) interval = grade === 1 ? 3 : grade === 3 ? 8 : 6;
    else interval = interval * (grade === 1 ? 1.2 : grade === 3 ? ease * 1.3 : ease);
    ease = Math.max(1.3, ease + (grade === 1 ? -0.15 : grade === 3 ? 0.15 : 0));
  }
  return { ease, interval, reps, lapses, due: Date.now() + interval * DAY };
}

// ---------------------------------------------------------------- OAuth state
const oauthStates = new Map();
const loginAttempts = new Map();

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, path, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, ...opts });
};

route('GET', '/api/status', () => ({ setup: q('SELECT COUNT(*) c FROM users').get().c === 0 }), { public: true });

route('POST', '/api/setup', ({ body, req, res }) => {
  if (q('SELECT COUNT(*) c FROM users').get().c) throw new HttpError(403, 'Already set up');
  const uid = createUser(body);
  tx(() => {
    q("INSERT INTO calendars(user_id, name, color, kind) VALUES (NULL, 'Household', '#f59e0b', 'local')").run();
    for (const s of SUPERTAGS) q('INSERT OR IGNORE INTO supertags(name, color, icon, fields, template, folder) VALUES (?, ?, ?, ?, ?, ?)').run(s.name, s.color, s.icon, JSON.stringify(s.fields), s.template, s.folder);
    for (const n of NOTES) saveNote(uid, n);
  });
  newSession(req, res, uid);
  return { ok: true };
}, { public: true });

route('POST', '/api/login', ({ body, res, req }) => {
  // Behind Cloudflare Tunnel / a reverse proxy every request comes from the proxy, so key the lockout on the real client IP.
  const ip = String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress);
  const a = loginAttempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts – try again in a minute');
  const u = q('SELECT * FROM users WHERE email = ?').get(String(body.email || '').trim());
  if (!u || !checkPw(String(body.password || ''), u.pw)) {
    a.n++; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; } loginAttempts.set(ip, a);
    throw new HttpError(401, 'Wrong email or password');
  }
  loginAttempts.delete(ip);
  newSession(req, res, u.id);
  return { ok: true };
}, { public: true });

route('POST', '/api/logout', ({ req, res }) => {
  q('DELETE FROM sessions WHERE token = ?').run(cookies(req).sid || '');
  res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/me', ({ user }) => ({
  claude: { configured: assistant.configured(), model: assistant.MODEL },
  user, users: q(`SELECT id, name, color FROM users ORDER BY id`).all(),
  integrations: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, configured: providerConfigured(k) }])),
}));
route('POST', '/api/users', ({ body }) => ({ id: createUser(body) }));
route('PATCH', '/api/users/me', ({ user, body }) => {
  if (body.name) q('UPDATE users SET name = ? WHERE id = ?').run(body.name, user.id);
  if (body.color) q('UPDATE users SET color = ? WHERE id = ?').run(body.color, user.id);
  if (body.password) {
    if (!checkPw(String(body.current || ''), q('SELECT pw FROM users WHERE id = ?').get(user.id).pw)) bad('Current password is wrong');
    if (String(body.password).length < 8) bad('Password must be at least 8 characters');
    q('UPDATE users SET pw = ? WHERE id = ?').run(hashPw(body.password), user.id);
  }
  if (body.rotateIcs) q('UPDATE users SET ics_token = ? WHERE id = ?').run(token(18), user.id);
  return q(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(user.id);
});

// SSE stream
route('GET', '/api/stream', ({ req, res, user }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const c = { res, uid: user.id };
  clients.add(c);
  req.on('close', () => clients.delete(c));
  return undefined;
}, { stream: true });

// ---- notes
route('GET', '/api/notes', ({ user }) => notesList(user.id));
route('GET', '/api/notes/:id', ({ user, params }) => getNote(+params.id, user.id));
route('POST', '/api/notes', ({ user, body, origin }) => {
  if (body.supertag && !body.content) {
    const st = q('SELECT * FROM supertags WHERE name = ?').get(body.supertag.toLowerCase());
    body.content = `#${body.supertag.toLowerCase()}\n${st?.template || ''}`;
    if (st?.folder && body.folder === undefined) body.folder = st.folder;
    if (st?.icon && !body.icon) body.icon = st.icon;
  }
  return saveNote(user.id, { ...body, id: undefined }, origin);
});
route('PUT', '/api/notes/:id', ({ user, params, body, origin }) => saveNote(user.id, { ...body, id: +params.id }, origin));
route('DELETE', '/api/notes/:id', ({ user, params, origin }) => {
  const n = q('SELECT * FROM notes WHERE id = ? AND (private = 0 OR owner_id = ?)').get(+params.id, user.id);
  if (!n) notFound();
  q('DELETE FROM notes WHERE id = ?').run(n.id);
  broadcast('note', { id: n.id, deleted: true, private: n.private, owner: n.owner_id }, origin);
  return { ok: true };
});
route('POST', '/api/notes/:id/field', ({ user, params, body, origin }) => {
  const n = q('SELECT content FROM notes WHERE id = ? AND (private = 0 OR owner_id = ?)').get(+params.id, user.id) || notFound();
  return saveNote(user.id, { id: +params.id, content: setField(n.content, String(body.key), body.value == null ? '' : String(body.value)) }, origin);
});
route('POST', '/api/notes/:id/task', ({ user, params, body, origin }) => {
  const n = q('SELECT content FROM notes WHERE id = ? AND (private = 0 OR owner_id = ?)').get(+params.id, user.id) || notFound();
  return saveNote(user.id, { id: +params.id, content: setTask(n.content, +body.line, !!body.done) }, origin);
});
route('POST', '/api/folders/rename', ({ user, body, origin }) => {
  const from = String(body.from || ''), to = String(body.to || '').replace(/^\/+|\/+$/g, '');
  if (!from) bad('Missing folder');
  tx(() => {
    for (const n of q("SELECT id, folder FROM notes WHERE folder = ? OR folder LIKE ? || '/%'").all(from, from))
      q('UPDATE notes SET folder = ? WHERE id = ?').run(to + n.folder.slice(from.length), n.id);
  });
  broadcast('notes', {}, origin);
  return { ok: true };
});

route('GET', '/api/daily/:date', ({ user, params, origin }) => {
  const d = params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) bad('Bad date');
  const ex = q('SELECT id FROM notes WHERE lower(title) = ?').get(d);
  if (ex) return { id: ex.id };
  const tpl = q("SELECT v FROM kv WHERE k = 'daily_template'").get()?.v ?? '## Focus\n- [ ] \n\n## Log\n- \n';
  return saveNote(user.id, { title: d, folder: 'Daily', icon: '📅', content: tpl }, origin);
});

route('GET', '/api/search', ({ user, query }) => {
  const raw = String(query.q || '').trim();
  if (!raw) return [];
  const terms = raw.replace(/["*():^]/g, ' ').split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const match = terms.map((t, i) => `"${t}"${i === terms.length - 1 ? '*' : ''}`).join(' ');
  return q(`SELECT n.id, n.title, n.icon, n.folder, snippet(notes_fts, 1, '\u0001', '\u0002', '…', 14) AS snip
    FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid WHERE notes_fts MATCH :m AND ${visible}
    ORDER BY bm25(notes_fts, 8.0, 1.0) LIMIT 40`).all({ m: match, uid: user.id });
});

route('GET', '/api/graph', ({ user }) => {
  const nodes = q(`SELECT n.id, n.title, n.folder, (SELECT tag FROM tags t WHERE t.note_id = n.id LIMIT 1) AS tag FROM notes n WHERE ${visible}`).all({ uid: user.id });
  const byTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n.id]));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const l of q('SELECT src, dst FROM links').all()) { const t = byTitle.get(l.dst); if (t && ids.has(l.src) && t !== l.src) edges.push([l.src, t]); }
  return { nodes, edges };
});

route('GET', '/api/tags', ({ user }) => q(`SELECT t.tag, COUNT(*) AS count FROM tags t JOIN notes n ON n.id = t.note_id WHERE ${visible} GROUP BY t.tag ORDER BY count DESC`).all({ uid: user.id }));

// ---- supertags & databases
route('GET', '/api/supertags', () => q('SELECT * FROM supertags ORDER BY name').all().map((s) => ({ ...s, fields: JSON.parse(s.fields) })));
route('PUT', '/api/supertags/:name', ({ params, body, origin }) => {
  const name = decodeURIComponent(params.name).toLowerCase().replace(/^#/, '');
  q(`INSERT INTO supertags(name, color, icon, fields, template, folder) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET color = excluded.color, icon = excluded.icon, fields = excluded.fields, template = excluded.template, folder = excluded.folder`)
    .run(name, body.color || '#8b5cf6', body.icon || '', JSON.stringify(body.fields || []), body.template || '', body.folder || '');
  broadcast('supertags', {}, origin);
  return { ok: true };
});
route('DELETE', '/api/supertags/:name', ({ params, origin }) => { q('DELETE FROM supertags WHERE name = ?').run(decodeURIComponent(params.name)); broadcast('supertags', {}, origin); return { ok: true }; });

route('GET', '/api/db/:tag', ({ user, params }) => {
  const tag = decodeURIComponent(params.tag).toLowerCase();
  const rows = q(`SELECT n.id, n.title, n.icon, n.folder, n.updated FROM tags t JOIN notes n ON n.id = t.note_id WHERE t.tag = :tag AND ${visible} ORDER BY n.title`).all({ tag, uid: user.id });
  const fieldRows = q(`SELECT f.note_id, f.key, f.value FROM fields f JOIN tags t ON t.note_id = f.note_id AND t.tag = ?`).all(tag);
  const map = new Map(rows.map((r) => [r.id, Object.assign(r, { fields: {}, health: health.get(r.id) || null })]));
  for (const f of fieldRows) map.get(f.note_id) && (map.get(f.note_id).fields[f.key] = f.value);
  const st = q('SELECT * FROM supertags WHERE name = ?').get(tag);
  return { tag, supertag: st ? { ...st, fields: JSON.parse(st.fields) } : null, rows, keys: [...new Set(fieldRows.map((f) => f.key))] };
});

// ---- tasks
route('GET', '/api/tasks', ({ user, query }) => q(`SELECT t.*, n.title AS note_title, n.icon FROM tasks t JOIN notes n ON n.id = t.note_id
  WHERE ${visible} ${query.all ? '' : 'AND t.done = 0'} ORDER BY t.due IS NULL, t.due, n.updated DESC LIMIT 1000`).all({ uid: user.id }));

// ---- flashcards
route('GET', '/api/cards/due', ({ user, query }) => {
  const base = `SELECT c.*, n.title FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.active = 1 AND ${visible}`;
  if (query.note) return q(`${base} AND n.id = :id ORDER BY c.due`).all({ uid: user.id, id: +query.note });
  const scope = String(query.scope || '').toLowerCase();
  if (scope.startsWith('#')) return q(`${base} AND c.due <= :now AND c.note_id IN (SELECT note_id FROM tags WHERE tag = :s) ORDER BY c.due LIMIT 200`).all({ uid: user.id, now: Date.now(), s: scope.slice(1) });
  return q(`${base} AND c.due <= :now ORDER BY c.due LIMIT 200`).all({ uid: user.id, now: Date.now() });
});
route('GET', '/api/cards/stats', ({ user }) => {
  const now = Date.now();
  const r = q(`SELECT COUNT(*) total, SUM(c.due <= :now) due, SUM(c.reps = 0 AND c.lapses = 0) new, SUM(c.interval >= 21) mature
    FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.active = 1 AND ${visible}`).get({ now, uid: user.id });
  const decks = q(`SELECT n.id, n.title, n.icon, COUNT(*) total, SUM(c.due <= :now) due FROM cards c JOIN notes n ON n.id = c.note_id
    WHERE c.active = 1 AND ${visible} GROUP BY n.id ORDER BY due DESC, n.title`).all({ now, uid: user.id });
  return { ...r, decks };
});
route('POST', '/api/cards/:id/review', ({ params, body }) => {
  const c = q('SELECT * FROM cards WHERE id = ?').get(+params.id) || notFound();
  const g = Math.max(0, Math.min(3, +body.grade | 0));
  const r = review(c, g);
  q('UPDATE cards SET ease = ?, interval = ?, reps = ?, lapses = ?, due = ? WHERE id = ?').run(r.ease, r.interval, r.reps, r.lapses, r.due, c.id);
  return r;
});

// ---- calendars
route('GET', '/api/calendars', ({ user }) => q(`SELECT c.id, c.user_id, c.name, c.color, c.kind, c.shared, c.last_sync, c.sync_error, c.config, u.name AS owner
  FROM calendars c LEFT JOIN users u ON u.id = c.user_id WHERE c.user_id IS NULL OR c.user_id = ? OR c.shared = 1 ORDER BY c.user_id IS NULL DESC, c.user_id, c.id`).all(user.id)
  .map((c) => { const cfg = JSON.parse(c.config || '{}'); delete c.config; return { ...c, account: cfg.account || null, url: c.user_id === user.id ? cfg.url || null : null, calendarId: cfg.calendarId ?? null, mine: c.user_id === user.id }; }));
route('POST', '/api/calendars', async ({ user, body, origin }) => {
  const kind = body.kind === 'ics' ? 'ics' : 'local';
  if (kind === 'ics' && !/^(https?|webcal):\/\//i.test(body.url || '')) bad('Enter a valid https:// or webcal:// ICS URL');
  const { lastInsertRowid } = q('INSERT INTO calendars(user_id, name, color, kind, config, shared) VALUES (?, ?, ?, ?, ?, ?)')
    .run(body.household ? null : user.id, body.name || (kind === 'ics' ? 'Subscribed calendar' : 'Calendar'), body.color || '#0ea5e9', kind, JSON.stringify(kind === 'ics' ? { url: body.url } : {}), body.shared === false ? 0 : 1);
  const cal = q('SELECT * FROM calendars WHERE id = ?').get(lastInsertRowid);
  if (kind === 'ics') await syncCalendar(store, cal).catch(() => {});
  broadcast('events', {}, origin);
  return { id: Number(lastInsertRowid) };
});
route('PATCH', '/api/calendars/:id', async ({ user, params, body, origin }) => {
  const c = q('SELECT * FROM calendars WHERE id = ?').get(+params.id) || notFound();
  if (c.user_id && c.user_id !== user.id) throw new HttpError(403, 'Not your calendar');
  if (body.name) q('UPDATE calendars SET name = ? WHERE id = ?').run(body.name, c.id);
  if (body.color) q('UPDATE calendars SET color = ? WHERE id = ?').run(body.color, c.id);
  if (body.shared !== undefined) q('UPDATE calendars SET shared = ? WHERE id = ?').run(body.shared ? 1 : 0, c.id);
  if (body.calendarId !== undefined || body.url) {
    const cfg = JSON.parse(c.config);
    if (body.calendarId !== undefined) cfg.calendarId = body.calendarId;
    if (body.url) cfg.url = body.url;
    q('UPDATE calendars SET config = ? WHERE id = ?').run(JSON.stringify(cfg), c.id);
    q('DELETE FROM events WHERE calendar_id = ?').run(c.id);
    await syncCalendar(store, q('SELECT * FROM calendars WHERE id = ?').get(c.id)).catch(() => {});
  }
  broadcast('events', {}, origin);
  return { ok: true };
});
route('DELETE', '/api/calendars/:id', ({ user, params, origin }) => {
  const c = q('SELECT * FROM calendars WHERE id = ?').get(+params.id) || notFound();
  if (c.user_id && c.user_id !== user.id) throw new HttpError(403, 'Not your calendar');
  if (c.user_id === null && c.kind === 'local' && q("SELECT COUNT(*) c FROM calendars WHERE user_id IS NULL AND kind = 'local'").get().c === 1) bad('Keep at least one household calendar');
  q('DELETE FROM calendars WHERE id = ?').run(c.id);
  broadcast('events', {}, origin);
  return { ok: true };
});
route('POST', '/api/calendars/:id/sync', async ({ params, origin }) => {
  const c = q('SELECT * FROM calendars WHERE id = ?').get(+params.id) || notFound();
  const r = await syncCalendar(store, c).catch((e) => bad(e.message));
  broadcast('events', {}, origin);
  return r;
});
route('GET', '/api/calendars/:id/remote', async ({ user, params }) => {
  const c = q('SELECT * FROM calendars WHERE id = ? AND user_id = ?').get(+params.id, user.id) || notFound();
  return listRemoteCalendars(store, c).catch((e) => bad(e.message));
});

// ---- events
route('GET', '/api/events', ({ user, query }) => {
  const from = Date.parse(query.from), to = Date.parse(query.to);
  if (isNaN(from) || isNaN(to) || to - from > 400 * DAY) bad('Bad range');
  return eventsInRange(user.id, from, to);
});
function eventInput(b, cal) {
  if (!b.title?.trim()) bad('Title is required');
  if (!b.start || !b.end) bad('Start and end are required');
  const allDay = b.all_day ? 1 : 0;
  const start = allDay ? String(b.start).slice(0, 10) : new Date(b.start).toISOString();
  let end = allDay ? String(b.end).slice(0, 10) : new Date(b.end).toISOString();
  if (end < start || (allDay && end === start)) end = allDay ? new Date(Date.parse(start) + DAY).toISOString().slice(0, 10) : start;
  return { title: b.title.trim(), start, end, all_day: allDay, tz: nn(b.tz), location: nn(b.location), description: nn(b.description),
    rrule: cal.kind === 'local' || cal.kind === 'google' ? nn(b.rrule) : null, who: JSON.stringify(Array.isArray(b.who) ? b.who.map(Number) : []), note_id: nn(b.note_id) };
}
async function createEvent(uid, body, origin) {
  const cal = writableCalendar(+body.calendar_id, uid);
  const ev = eventInput(body, cal);
  const ext = await pushEvent(store, cal, ev).catch((e) => bad(`Could not save to ${cal.kind}: ${e.message}`));
  const { lastInsertRowid } = q(`INSERT INTO events(calendar_id, ext_id, title, start, end, all_day, tz, location, description, rrule, who, note_id, updated)
    VALUES (:cal, :ext, :title, :start, :end, :all_day, :tz, :location, :description, :rrule, :who, :note_id, :now)`).run({ cal: cal.id, ext: ext || `local-${token(9)}`, now: Date.now(), ...ev });
  broadcast('events', {}, origin);
  return { id: Number(lastInsertRowid), calendar: cal.name };
}
route('POST', '/api/events', ({ user, body, origin }) => createEvent(user.id, body, origin));
route('PUT', '/api/events/:id', async ({ user, params, body, origin }) => {
  const cur = q('SELECT * FROM events WHERE id = ?').get(+params.id) || notFound();
  let cal = writableCalendar(cur.calendar_id, user.id);
  const ev = eventInput({ ...cur, who: JSON.parse(cur.who), ...body }, cal);
  if (body.calendar_id && +body.calendar_id !== cur.calendar_id) {
    // Moving between calendars = delete from old, create in new.
    const target = writableCalendar(+body.calendar_id, user.id);
    await deleteRemote(store, cal, cur.ext_id).catch(() => {});
    const ext = await pushEvent(store, target, ev).catch((e) => bad(e.message));
    q('UPDATE events SET calendar_id = ?, ext_id = ? WHERE id = ?').run(target.id, ext || `local-${token(9)}`, cur.id);
    cal = target;
  } else await pushEvent(store, cal, ev, cur.ext_id).catch((e) => bad(`Could not update ${cal.kind}: ${e.message}`));
  q(`UPDATE events SET title = :title, start = :start, end = :end, all_day = :all_day, tz = :tz, location = :location, description = :description,
     rrule = :rrule, who = :who, note_id = :note_id, updated = :now WHERE id = :id`).run({ ...ev, now: Date.now(), id: cur.id });
  broadcast('events', {}, origin);
  return { ok: true };
});
route('DELETE', '/api/events/:id', async ({ user, params, query, origin }) => {
  const cur = q('SELECT * FROM events WHERE id = ?').get(+params.id) || notFound();
  const cal = writableCalendar(cur.calendar_id, user.id);
  if (query.occurrence && cur.rrule && cal.kind === 'local') {
    const ex = JSON.parse(cur.exdates || '[]'); ex.push(query.occurrence);
    q('UPDATE events SET exdates = ? WHERE id = ?').run(JSON.stringify(ex), cur.id);
  } else {
    await deleteRemote(store, cal, cur.ext_id).catch((e) => bad(`Could not delete from ${cal.kind}: ${e.message}`));
    q('DELETE FROM events WHERE id = ?').run(cur.id);
  }
  broadcast('events', {}, origin);
  return { ok: true };
});
route('POST', '/api/events/:id/note', ({ user, params, origin }) => {
  const ev = q('SELECT * FROM events WHERE id = ?').get(+params.id) || notFound();
  if (ev.note_id && q('SELECT 1 FROM notes WHERE id = ?').get(ev.note_id)) return { id: ev.note_id };
  const date = ev.start.slice(0, 10);
  const st = q("SELECT template FROM supertags WHERE name = 'meeting'").get();
  const content = `#meeting\n${(st?.template || '').replace(/^date::.*$/m, `date:: ${date}`)}\nRelated: [[${date}]]\n`;
  const note = saveNote(user.id, { title: `${date} ${ev.title}`, folder: 'Meetings', icon: '🗓️', content }, origin);
  q('UPDATE events SET note_id = ? WHERE id = ?').run(note.id, ev.id);
  broadcast('events', {}, origin);
  return { id: note.id };
});

// ---- OAuth (Google / Outlook)
route('GET', '/api/oauth/:provider/start', ({ user, params, req, res }) => {
  const p = params.provider;
  if (!PROVIDERS[p]) notFound();
  if (!providerConfigured(p)) bad(`${PROVIDERS[p].label} is not configured on the server. See README → Calendar integrations.`);
  const state = token(16);
  oauthStates.set(state, { uid: user.id, provider: p, exp: Date.now() + 600000 });
  res.writeHead(302, { location: authorizeUrl(p, `${baseUrl(req)}/api/oauth/${p}/callback`, state) });
  res.end();
}, { raw: true });
route('GET', '/api/oauth/:provider/callback', async ({ params, query, req, res }) => {
  const st = oauthStates.get(query.state);
  oauthStates.delete(query.state);
  const fail = (m) => { res.writeHead(302, { location: `/#/settings?error=${encodeURIComponent(m)}` }); res.end(); };
  if (!st || st.exp < Date.now() || st.provider !== params.provider) return fail('Sign-in expired, please try again');
  if (query.error) return fail(String(query.error_description || query.error));
  try {
    const cfg = await exchangeCode(st.provider, String(query.code), `${baseUrl(req)}/api/oauth/${st.provider}/callback`);
    const existing = q('SELECT id, config FROM calendars WHERE user_id = ? AND kind = ?').all(st.uid, st.provider).find((c) => JSON.parse(c.config).account === cfg.account);
    let id;
    if (existing) {
      const old = JSON.parse(existing.config);
      q('UPDATE calendars SET config = ?, sync_error = NULL WHERE id = ?').run(JSON.stringify({ ...old, ...cfg, calendarId: old.calendarId ?? cfg.calendarId }), existing.id);
      id = existing.id;
    } else {
      const u = q('SELECT name, color FROM users WHERE id = ?').get(st.uid);
      id = Number(q('INSERT INTO calendars(user_id, name, color, kind, config, shared) VALUES (?, ?, ?, ?, ?, 1)')
        .run(st.uid, `${u.name} · ${st.provider === 'google' ? 'Google' : 'Outlook'}`, u.color, st.provider, JSON.stringify(cfg)).lastInsertRowid);
    }
    await syncCalendar(store, q('SELECT * FROM calendars WHERE id = ?').get(id)).catch(() => {});
    broadcast('events', {});
    res.writeHead(302, { location: `/#/settings?connected=${st.provider}` }); res.end();
  } catch (e) { fail(e.message); }
}, { raw: true, public: true });

// ---- household ICS feed (subscribe from any phone / Google / Outlook)
route('GET', '/ics/:token', ({ params, req, res }) => {
  const tok = params.token.replace(/\.ics$/, '');
  const u = q('SELECT id, name FROM users WHERE ics_token = ?').get(tok);
  if (!u) { res.writeHead(404); return res.end(); }
  const from = new Date(Date.now() - 60 * DAY).toISOString();
  const users = new Map(q('SELECT id, name FROM users').all().map((x) => [x.id, x.name]));
  // Exclude the subscriber's own Google/Outlook calendars – they already have those.
  const rows = q(`SELECT e.*, c.user_id AS cal_user FROM events e JOIN calendars c ON c.id = e.calendar_id
    WHERE (c.user_id IS NULL OR c.shared = 1 OR c.user_id = :uid) AND NOT (c.user_id = :uid AND c.kind IN ('google','outlook'))
      AND (e.rrule IS NOT NULL OR e.end > :from)`).all({ uid: u.id, from });
  const events = rows.map((e) => {
    const who = JSON.parse(e.who || '[]');
    const names = (who.length ? who : e.cal_user ? [e.cal_user] : []).map((id) => users.get(id)).filter(Boolean);
    return { ...e, uid: `nexus-${e.id}@nexus`, title: names.length && names.length < users.size ? `${e.title} (${names.join(' & ')})` : e.title, exdates: e.exdates ? JSON.parse(e.exdates) : [] };
  });
  const body = generateICS('Household (Nexus)', events);
  res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-cache', 'content-disposition': 'inline; filename="household.ics"' });
  res.end(body);
}, { raw: true, public: true });

// ---- Ask Claude (streams Server-Sent Events back on the POST response)
const claudeBusy = new Set();
route('POST', '/api/claude/chat', async ({ user, body, req, res }) => {
  if (!assistant.configured()) bad('Claude is not set up. Add ANTHROPIC_API_KEY to the Nexus container settings.');
  const history = (Array.isArray(body.messages) ? body.messages : []).slice(-30)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role, text: m.text.slice(0, 40000) }));
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length || history[history.length - 1].role !== 'user') bad('Send a question.');
  if (claudeBusy.has(user.id)) throw new HttpError(429, 'Claude is still answering your previous question.');
  claudeBusy.add(user.id);
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const emit = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const t0 = Date.now();
  try {
    const usage = await assistant.runAssistant({
      deps: { q, visible, saveNote, getNote, createEvent, eventsInRange, health, origin: null },
      user, history, context: { noteId: body.noteId, tz: body.tz }, emit, signal: ctrl.signal,
    });
    console.log(`[claude] ${user.name}: ${usage.input} in (${usage.cacheRead} cached) / ${usage.output} out tokens, ${Date.now() - t0} ms`);
    emit({ type: 'done', usage });
  } catch (e) {
    if (!ctrl.signal.aborted) { console.warn('[claude]', e.message); emit({ type: 'error', message: assistant.friendlyError(e) }); }
  } finally {
    claudeBusy.delete(user.id);
    res.end();
  }
}, { stream: true });

// ---- homelab
route('GET', '/api/services', () => Object.fromEntries(health));
route('POST', '/api/services/check', async () => { await checkServices(); return Object.fromEntries(health); });

// ---- import / export
function frontmatterToNexus(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return content;
  const lines = [], tagList = [];
  let listKey = null;
  for (const l of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(l);
    if (item && listKey) { (listKey === 'tags' ? tagList : lines).push(listKey === 'tags' ? item[1] : `${listKey}:: ${item[1]}`); continue; }
    const kv = /^([\w][\w -]*):\s*(.*)$/.exec(l);
    if (!kv) continue;
    listKey = kv[2] ? null : kv[1].toLowerCase();
    if (kv[1].toLowerCase() === 'tags' || kv[1].toLowerCase() === 'tag') tagList.push(...kv[2].replace(/[[\]]/g, '').split(/[,\s]+/).filter(Boolean));
    else if (kv[2]) lines.push(`${kv[1].toLowerCase()}:: ${kv[2].replace(/^["']|["']$/g, '')}`);
  }
  const tagLine = tagList.length ? tagList.map((t) => `#${t.replace(/^#/, '').replace(/\s+/g, '-')}`).join(' ') + '\n' : '';
  return tagLine + (lines.length ? lines.join('\n') + '\n\n' : '') + content.slice(m[0].length);
}
route('POST', '/api/import', ({ user, body, origin }) => {
  const files = Array.isArray(body.files) ? body.files : bad('No files');
  let count = 0;
  tx(() => {
    for (const f of files) {
      if (!/\.(md|markdown|txt)$/i.test(f.path || '')) continue;
      const parts = String(f.path).replace(/\\/g, '/').split('/').filter(Boolean);
      const file = parts.pop();
      if (parts.some((p) => p.startsWith('.'))) continue; // skip .obsidian, .trash
      const title = file.replace(/\.(md|markdown|txt)$/i, '').replace(/\s[0-9a-f]{32}$/i, '');
      const folder = (body.root ? [body.root, ...parts.slice(1)] : parts.slice(1)).map((p) => p.replace(/\s[0-9a-f]{32}$/i, '')).join('/');
      saveNote(user.id, { title, folder, content: frontmatterToNexus(String(f.content || '')) });
      count++;
    }
  });
  broadcast('notes', {}, origin);
  return { count };
});
route('GET', '/api/export', ({ user, res }) => {
  const data = { exported: new Date().toISOString(), notes: q(`SELECT n.id, n.title, n.folder, n.icon, n.pinned, n.private, n.content, n.created, n.updated FROM notes n WHERE ${visible}`).all({ uid: user.id }),
    supertags: q('SELECT * FROM supertags').all(), events: q('SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.kind = \'local\'').all() };
  res.setHeader('content-disposition', `attachment; filename="nexus-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return data;
});
route('GET', '/api/settings', () => ({ daily_template: q("SELECT v FROM kv WHERE k = 'daily_template'").get()?.v ?? '## Focus\n- [ ] \n\n## Log\n- \n' }));
route('PUT', '/api/settings', ({ body }) => { if (typeof body.daily_template === 'string') q("INSERT OR REPLACE INTO kv(k, v) VALUES ('daily_template', ?)").run(body.daily_template); return { ok: true }; });

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  try {
    if (!path.startsWith('/api/') && !path.startsWith('/ics/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (serveAsset(req, res, path === '/' ? '/index.html' : path, url.searchParams.has('v'))) return;
      if (!extname(path)) return void serveAsset(req, res, '/index.html');
      throw new HttpError(404, 'Not found');
    }
    let match, r;
    for (r of routes) if (r.method === req.method && (match = r.re.exec(path))) break;
    if (!match) throw new HttpError(404, 'Not found');
    const params = Object.fromEntries(r.keys.map((k, i) => [k, match[i + 1]]));
    let user = null;
    const sid = cookies(req).sid;
    if (sid) user = q(`SELECT u.id, u.name, u.email, u.color, u.ics_token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?`).get(sid, Date.now()) || null;
    if (!r.public && !user) throw new HttpError(401, 'Sign in required');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !r.public) {
      // CSRF: require same-origin requests for mutations.
      const o = req.headers.origin;
      if (o && new URL(o).host !== (req.headers['x-forwarded-host'] || req.headers.host)) throw new HttpError(403, 'Cross-origin request blocked');
    }
    const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' ? await readBody(req) : {};
    const result = await r.handler({ req, res, user, params, body, query: Object.fromEntries(url.searchParams), origin: req.headers['x-client-id'] || null });
    if (r.raw || r.stream || res.headersSent) return;
    send(req, res, 200, result ?? { ok: true });
  } catch (e) {
    if (res.headersSent) return res.end();
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(req, res, status, { error: status === 500 ? 'Server error' : e.message, ...(e.current ? { current: e.current } : {}) });
  }
});

// ---------------------------------------------------------------- background jobs
// Nightly consistent snapshot (VACUUM INTO) to DATA_DIR/backups, keeping the newest BACKUP_KEEP files.
async function backup() {
  const keep = +(process.env.BACKUP_KEEP ?? 14);
  if (!keep) return;
  const dir = join(DATA, 'backups');
  mkdirSync(dir, { recursive: true });
  const name = `nexus-${new Date().toLocaleDateString('sv')}.db`;
  const files = readdirSync(dir).filter((f) => /^nexus-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  if (files.includes(name)) return;
  store.db.exec(`VACUUM INTO '${join(dir, name).replace(/'/g, "''")}'`);
  for (const f of files.concat(name).slice(0, -keep)) unlinkSync(join(dir, f));
  console.log(`[backup] wrote ${name}`);
}

async function syncAll() {
  for (const c of q("SELECT * FROM calendars WHERE kind != 'local'").all()) {
    try { await syncCalendar(store, c); } catch (e) { console.warn(`[sync] ${c.name}: ${e.message}`); }
  }
  broadcast('events', {});
}
if (process.env.NODE_ENV !== 'test') {
  setInterval(syncAll, +(process.env.SYNC_MINUTES || 10) * 60000).unref();
  setInterval(() => checkServices().catch(() => {}), +(process.env.HEALTH_SECONDS || 120) * 1000).unref();
  setInterval(() => q('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600000).unref();
  setInterval(() => backup().catch((e) => console.warn(`[backup] ${e.message}`)), 3600000).unref();
  setTimeout(() => backup().catch((e) => console.warn(`[backup] ${e.message}`)), 60000).unref();
  setTimeout(() => { syncAll(); checkServices().catch(() => {}); }, 3000).unref();
}

server.keepAliveTimeout = 65000;
server.listen(PORT, HOST, () => console.log(`Nexus listening on http://${HOST}:${PORT}  (data: ${DATA})`));

const shutdown = () => { server.close(); for (const c of clients) c.res.end(); store.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, store };
