// Nexus – self-hosted notes + knowledge base + household calendar. Zero npm dependencies.
import http from 'node:http';
import https from 'node:https';
import { readFileSync, readdirSync, mkdirSync, statSync, watch, unlinkSync, createWriteStream, createReadStream, renameSync, writeFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { openDb, indexNote } from './lib/db.js';
import { setField, setTask, rollRecurring } from './lib/parse.js';
import { expand } from './lib/rrule.js';
import { generateICS } from './lib/ics.js';
import { PROVIDERS, providerConfigured, authorizeUrl, exchangeCode, syncCalendar, pushEvent, deleteRemote, listRemoteCalendars, outlookMail, outlookMarkRead } from './lib/calendar.js';
import { SUPERTAGS, NOTES } from './lib/seed.js';
import { DAY, wallParts, zonedToUtc } from './lib/time.js';
import { deliver, hasChannel, smtpConfigured, pushoverConfigured } from './lib/notify.js';
import * as unraid from './lib/unraid.js';
import * as assistant from './lib/assistant.js';
import { buildTools, appendUnder } from './lib/tools.js';
import { encrypt, s3Client } from './lib/offsite.js';
import { newSecret, otpauthUri, verifyTotp, newRecoveryCodes, useRecoveryCode } from './lib/totp.js';
import { z } from 'zod';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA = process.env.DATA_DIR || join(ROOT, 'data');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
// Mark cookies Secure only when this request arrived over HTTPS, so LAN access over http://tower:port keeps working.
const isHttps = (req) => process.env.COOKIE_SECURE === '1' || req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const SESSION_DAYS = 60;

mkdirSync(DATA, { recursive: true });
const FILES = join(DATA, 'files');
mkdirSync(FILES, { recursive: true });
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
  // Vendored, version-pinned QR code library (used only on the two-step sign-in setup screen).
  try {
    const body = readFileSync(join(ROOT, 'node_modules/qrcode-generator/qrcode.js'));
    assets.set('/vendor/qrcode.js', { body, type: MIME['.js'], etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`, gz: gzipSync(body), br: brotliCompressSync(body) });
  } catch {}
  // Cache-bust module URLs in index.html by content hash so assets can be cached immutably.
  const idx = assets.get('/index.html');
  let html = idx.body.toString();
  html = html.replace(/(src|href)="\/(app\.css|app\.js)"/g, (m, a, f) => `${a}="/${f}?v=${assets.get('/' + f).etag.slice(1, 9)}"`);
  const body = Buffer.from(html);
  assets.set('/index.html', { ...idx, body, gz: gzipSync(body), br: brotliCompressSync(body), etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"` });
}
buildAssets();
// One-time additions for workspaces created by earlier versions.
function seedV2() {
  if (q("SELECT v FROM kv WHERE k = 'seed_v2'").get() || !q('SELECT 1 FROM users LIMIT 1').get()) return;
  for (const st of SUPERTAGS.filter((x) => ['bill', 'chore'].includes(x.name)))
    q('INSERT OR IGNORE INTO supertags(name, color, icon, fields, template, folder) VALUES (?, ?, ?, ?, ?, ?)').run(st.name, st.color, st.icon, JSON.stringify(st.fields), st.template, st.folder);
  const owner = q('SELECT id FROM users ORDER BY id LIMIT 1').get().id, now = Date.now();
  for (const n of NOTES.filter((x) => x.folder === 'Household'))
    if (!q('SELECT 1 FROM notes WHERE lower(title) = lower(?) AND deleted IS NULL').get(n.title)) {
      const { lastInsertRowid } = q('INSERT INTO notes(title, folder, content, icon, pinned, owner_id, updated_by, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(n.title, n.folder, n.content, n.icon, n.pinned || 0, owner, owner, now, now);
      indexNote(store, Number(lastInsertRowid), n.content);
    }
  q("INSERT OR REPLACE INTO kv(k, v) VALUES ('seed_v2', '1')").run();
}
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
const visible = '(n.deleted IS NULL AND (n.private = 0 OR n.owner_id = :uid))';
// "Hide from AI": notes flagged individually, or anywhere under an excluded folder, are invisible to Claude
// (Ask Claude, the phone connector and the weekly review).
let aiExcluded = [];
const loadAiExcluded = () => { aiExcluded = JSON.parse(q("SELECT v FROM kv WHERE k = 'ai_excluded_folders'").get()?.v || '[]'); };
loadAiExcluded();
store.db.function('ai_hidden', (folder, noai) => (noai || aiExcluded.some((f) => folder === f || String(folder).startsWith(f + '/')) ? 1 : 0));
const aiVisible = `(${visible} AND ai_hidden(n.folder, n.noai) = 0)`;
const aiHidden = (id) => !!q('SELECT ai_hidden(folder, noai) AS h FROM notes WHERE id = ?').get(id)?.h;

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
  n.ai_hidden = aiHidden(id);
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
  for (let i = 2; q('SELECT 1 FROM notes WHERE lower(title) = lower(?) AND id != ? AND deleted IS NULL').get(t, excludeId); i++) t = `${base} ${i}`;
  return t;
}

function saveNote(uid, { id, title, folder, content, icon, pinned, private: priv, noai, base, revReason }, origin) {
  let rolled = false;
  if (content !== undefined) { // recurring tasks: completing one adds the next occurrence
    const next = rollRecurring(content, new Date().toLocaleDateString('sv', { timeZone: process.env.TZ || undefined }));
    if (next !== content) { content = next; rolled = true; }
  }
  return tx(() => {
    const now = Date.now();
    let note;
    if (id) {
      const cur = q('SELECT * FROM notes WHERE id = ? AND deleted IS NULL AND (private = 0 OR owner_id = ?)').get(id, uid);
      if (!cur) notFound('Note not found');
      if (base && cur.updated > base && content !== undefined && content !== cur.content) {
        throw Object.assign(new HttpError(409, 'This note was changed by someone else'), { current: { content: cur.content, updated: cur.updated, updated_by: cur.updated_by } });
      }
      const newTitle = title !== undefined && title.trim() !== cur.title ? uniqueTitle(title, id) : cur.title;
      if ((content !== undefined && content !== cur.content) || newTitle !== cur.title) snapshot(cur, uid, revReason, now);
      if (newTitle !== cur.title) renameLinks(cur.title, newTitle, uid, now);
      q(`UPDATE notes SET title = ?, folder = ?, content = ?, icon = ?, pinned = ?, private = ?, updated = ?, updated_by = ? WHERE id = ?`).run(
        newTitle, folder ?? cur.folder, content ?? cur.content, icon !== undefined ? nn(icon) : cur.icon,
        pinned !== undefined ? (pinned ? 1 : 0) : cur.pinned, priv !== undefined ? (priv ? 1 : 0) : cur.private, now, uid, id);
      if (noai !== undefined) q('UPDATE notes SET noai = ? WHERE id = ?').run(noai ? 1 : 0, id);
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
    broadcast('note', { id: note.id, updated: note.updated, private: note.private, owner: note.owner_id }, rolled ? null : origin);
    return rolled ? { ...note, content } : note;
  });
}

// Version history. A snapshot of the previous state is kept when a new editing session starts (10+ minutes since
// the last snapshot, or a different person), and always before changes by Claude, the phone connector or a restore.
function snapshot(cur, uid, reason, now = Date.now()) {
  if (!cur.content.trim()) return;
  // Same person still mid-session: the snapshot taken when their session began already covers this.
  if (!reason && cur.updated_by === uid && now - cur.updated < 10 * 60000) return;
  q('INSERT INTO note_revisions(note_id, title, content, author_id, reason, created) VALUES (?, ?, ?, ?, ?, ?)').run(cur.id, cur.title, cur.content, cur.updated_by, reason || null, now);
  q('DELETE FROM note_revisions WHERE note_id = ? AND id NOT IN (SELECT id FROM note_revisions WHERE note_id = ? ORDER BY created DESC LIMIT 100)').run(cur.id, cur.id);
}

// When a note is renamed, rewrite [[Old]] links everywhere (Obsidian behaviour).
function renameLinks(oldTitle, newTitle, uid, now) {
  const re = new RegExp(`\\[\\[${oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\]#|])`, 'gi');
  for (const r of q('SELECT n.id, n.content FROM links l JOIN notes n ON n.id = l.src WHERE l.dst = ? AND n.deleted IS NULL').all(oldTitle.toLowerCase())) {
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
    WHERE t.due >= ? AND t.due <= ? AND n.deleted IS NULL AND (n.private = 0 OR n.owner_id = ?)`).all(new Date(fromMs - DAY).toISOString().slice(0, 10), to.slice(0, 10), uid);
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
  const rows = q(`SELECT f.note_id, f.value FROM fields f JOIN tags t ON t.note_id = f.note_id AND t.tag = 'service' JOIN notes n ON n.id = f.note_id AND n.deleted IS NULL WHERE f.key = 'url' AND f.value LIKE 'http%'`).all();
  const seen = new Set();
  await Promise.all(rows.map(async (r) => {
    seen.add(r.note_id);
    const res = await ping(r.value.trim());
    const prev = health.get(r.note_id);
    const fails = res.ok ? 0 : (prev?.fails || 0) + 1;
    const down = prev ? (res.ok ? false : fails >= 2 ? true : prev.down) : !res.ok; // 2 failures in a row before calling it down
    health.set(r.note_id, { ...res, url: r.value, at: Date.now(), fails, down });
    if (prev && prev.down !== down) { // alert only on changes (not on startup)
      const title = q('SELECT title FROM notes WHERE id = ?').get(r.note_id)?.title || r.value;
      notifyAll('homelab', down ? `🔴 ${title} is down` : `🟢 ${title} is back up`,
        down ? `${title} (${r.value}) isn't responding: ${res.error || `HTTP ${res.status}`}.` : `${title} is responding again (${res.ms} ms).`,
        { url: `${PUBLIC_URL}/#/note/${r.note_id}`, priority: down ? 'high' : 'default', tags: [down ? 'red_circle' : 'green_circle'] });
    }
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
    q("INSERT OR REPLACE INTO kv(k, v) VALUES ('seed_v2', '1')").run();
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
  if (u.totp_secret) {
    if (!body.code) return { totp: true }; // ask for the authenticator code (password was right)
    if (!checkSecondFactor(u, body.code)) {
      a.n++; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; } loginAttempts.set(ip, a);
      throw new HttpError(401, 'That code didn’t work – use the current code from your authenticator app, or a recovery code');
    }
  }
  loginAttempts.delete(ip);
  newSession(req, res, u.id);
  return { ok: true };
}, { public: true });

// Second factor: a 6-digit authenticator code (each code works once) or a one-time recovery code.
function checkSecondFactor(u, code) {
  const step = verifyTotp(u.totp_secret, code, u.totp_last);
  if (step) { q('UPDATE users SET totp_last = ? WHERE id = ?').run(step, u.id); return true; }
  const left = useRecoveryCode(JSON.parse(u.recovery || '[]'), code);
  if (left) { q('UPDATE users SET recovery = ? WHERE id = ?').run(JSON.stringify(left), u.id); return true; }
  return false;
}
const pendingTotp = new Map();
route('POST', '/api/2fa/setup', ({ user }) => {
  const secret = newSecret();
  pendingTotp.set(user.id, { secret, exp: Date.now() + 15 * 60000 });
  return { secret, uri: otpauthUri(secret, user.email) };
});
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
route('POST', '/api/2fa/recovery', ({ user, body }) => {
  if (!checkPw(String(body.password || ''), q('SELECT pw FROM users WHERE id = ?').get(user.id).pw)) bad('Password is wrong');
  const { codes, hashes } = newRecoveryCodes();
  q('UPDATE users SET recovery = ? WHERE id = ? AND totp_secret IS NOT NULL').run(JSON.stringify(hashes), user.id);
  return { codes };
});

route('POST', '/api/logout', ({ req, res }) => {
  q('DELETE FROM sessions WHERE token = ?').run(cookies(req).sid || '');
  res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/me', ({ user }) => ({
  claude: { configured: assistant.configured(), model: assistant.MODEL },
  security: (({ t, r }) => ({ totp: !!t, recoveryLeft: r ? JSON.parse(r).length : 0 }))(q('SELECT totp_secret AS t, recovery AS r FROM users WHERE id = ?').get(user.id)),
  publicUrl: PUBLIC_URL || null,
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
  const n = q('SELECT * FROM notes WHERE id = ? AND deleted IS NULL AND (private = 0 OR owner_id = ?)').get(+params.id, user.id);
  if (!n) notFound();
  q('UPDATE notes SET deleted = ?, updated_by = ? WHERE id = ?').run(Date.now(), user.id, n.id); // to the trash for 30 days
  broadcast('note', { id: n.id, deleted: true, private: n.private, owner: n.owner_id }, origin);
  return { ok: true };
});
route('POST', '/api/notes/:id/field', ({ user, params, body, origin }) => {
  const n = q('SELECT content FROM notes WHERE id = ? AND deleted IS NULL AND (private = 0 OR owner_id = ?)').get(+params.id, user.id) || notFound();
  return saveNote(user.id, { id: +params.id, content: setField(n.content, String(body.key), body.value == null ? '' : String(body.value)) }, origin);
});
route('POST', '/api/notes/:id/task', ({ user, params, body, origin }) => {
  const n = q('SELECT content FROM notes WHERE id = ? AND deleted IS NULL AND (private = 0 OR owner_id = ?)').get(+params.id, user.id) || notFound();
  return saveNote(user.id, { id: +params.id, content: setTask(n.content, +body.line, !!body.done) }, origin);
});
// ---- attachments (images, PDFs, audio, any file) stored under DATA_DIR/files
const MAX_UPLOAD = +(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;
const FILE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', aac: 'audio/aac', caf: 'audio/x-caf',
  mp4: 'video/mp4', mov: 'video/quicktime', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain', yaml: 'text/yaml', yml: 'text/yaml', zip: 'application/zip' };
const cleanName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
const fileUrl = (a) => `/files/${a.id}/${encodeURIComponent(a.name)}`;
const fileMarkdown = (a) => a.mime.startsWith('image/') ? `![${a.name}](${fileUrl(a)})` : a.mime.startsWith('audio/') || a.mime.startsWith('video/') ? `![🎙️ ${a.name}](${fileUrl(a)})` : `[📎 ${a.name}](${fileUrl(a)})`;
function storeUpload(req, { uid, noteId, name, mime }) {
  return new Promise((resolve, reject) => {
    name = cleanName(name);
    const ext = (name.split('.').pop() || '').toLowerCase();
    mime = FILE_TYPES[ext] || (mime && mime !== 'application/octet-stream' && !/^application\/(x-www-form|json)/.test(mime) ? mime.split(';')[0] : 'application/octet-stream');
    const month = new Date().toISOString().slice(0, 7);
    mkdirSync(join(FILES, month), { recursive: true });
    const rel = `${month}/${token(9)}-${name}`, tmp = join(FILES, rel + '.part');
    const out = createWriteStream(tmp);
    let size = 0, failed = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD && !failed) { failed = true; out.destroy(); try { unlinkSync(tmp); } catch {} reject(new HttpError(413, `File is larger than ${MAX_UPLOAD / 1048576} MB`)); req.destroy(); } });
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (!size) { try { unlinkSync(tmp); } catch {} return reject(new HttpError(400, 'Empty file')); }
      renameSync(tmp, join(FILES, rel));
      const { lastInsertRowid } = q('INSERT INTO attachments(note_id, user_id, name, mime, size, path, created) VALUES (?, ?, ?, ?, ?, ?, ?)').run(noteId || null, uid, name, mime, size, rel, Date.now());
      const a = { id: Number(lastInsertRowid), name, mime, size };
      resolve({ ...a, url: fileUrl(a), markdown: fileMarkdown(a) });
    });
    out.on('error', reject);
  });
}
function canSeeAttachment(a, uid) {
  if (!a) return false;
  if (!a.note_id) return true; // household-shared upload not yet attached to a note
  return !!q(`SELECT 1 FROM notes n WHERE n.id = :id AND (n.private = 0 OR n.owner_id = :uid)`).get({ id: a.note_id, uid });
}
route('POST', '/api/files', async ({ user, req, query }) => {
  if (query.note) getNote(+query.note, user.id); // must be able to see the note
  return storeUpload(req, { uid: user.id, noteId: query.note ? +query.note : null, name: query.name || req.headers['x-filename'], mime: req.headers['content-type'] });
}, { rawBody: true });
route('GET', '/files/:id/:name', ({ user, params, req, res }) => {
  const a = q('SELECT * FROM attachments WHERE id = ?').get(+params.id);
  if (!canSeeAttachment(a, user.id)) notFound('File not found');
  const file = join(FILES, a.path);
  let st; try { st = statSync(file); } catch { notFound('File is missing'); }
  const inline = /^(image|audio|video)\//.test(a.mime) && a.mime !== 'image/svg+xml' || a.mime === 'application/pdf' || a.mime.startsWith('text/');
  const headers = { 'content-type': a.mime.startsWith('text/') ? `${a.mime}; charset=utf-8` : a.mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000, immutable',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] ? +range[1] : st.size - +range[2], end = range[1] && range[2] ? +range[2] : st.size - 1;
    if (start < 0 || start >= st.size || end >= st.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}, { raw: true });
route('GET', '/api/notes/:id/files', ({ user, params }) => {
  getNote(+params.id, user.id);
  return q('SELECT id, name, mime, size, created FROM attachments WHERE note_id = ? ORDER BY created').all(+params.id).map((a) => ({ ...a, url: fileUrl(a), markdown: fileMarkdown(a) }));
});
route('DELETE', '/api/files/:id', ({ user, params }) => {
  const a = q('SELECT * FROM attachments WHERE id = ?').get(+params.id);
  if (!canSeeAttachment(a, user.id)) notFound();
  try { unlinkSync(join(FILES, a.path)); } catch {}
  q('DELETE FROM attachments WHERE id = ?').run(a.id);
  return { ok: true };
});

// ---- trash & version history
route('GET', '/api/trash', ({ user }) => q(`SELECT n.id, n.title, n.folder, n.icon, n.deleted, u.name AS deleted_by FROM notes n LEFT JOIN users u ON u.id = n.updated_by
  WHERE n.deleted IS NOT NULL AND (n.private = 0 OR n.owner_id = ?) ORDER BY n.deleted DESC`).all(user.id));
route('POST', '/api/trash/:id/restore', ({ user, params, origin }) => {
  const n = q('SELECT * FROM notes WHERE id = ? AND deleted IS NOT NULL AND (private = 0 OR owner_id = ?)').get(+params.id, user.id) || notFound();
  const title = q('SELECT 1 FROM notes WHERE lower(title) = lower(?) AND deleted IS NULL').get(n.title) ? uniqueTitle(`${n.title} (restored)`) : n.title;
  q('UPDATE notes SET deleted = NULL, title = ?, updated = ?, updated_by = ? WHERE id = ?').run(title, Date.now(), user.id, n.id);
  broadcast('notes', {}, origin);
  return { id: n.id, title };
});
function purgeNote(id) {
  for (const a of q('SELECT path FROM attachments WHERE note_id = ?').all(id)) { try { unlinkSync(join(FILES, a.path)); } catch {} }
  q('DELETE FROM attachments WHERE note_id = ?').run(id);
  q('DELETE FROM notes WHERE id = ?').run(id);
}
route('DELETE', '/api/trash/:id', ({ user, params }) => {
  const n = q('SELECT id FROM notes WHERE id = ? AND deleted IS NOT NULL AND (private = 0 OR owner_id = ?)').get(+params.id, user.id) || notFound();
  purgeNote(n.id);
  return { ok: true };
});
route('DELETE', '/api/trash', ({ user }) => {
  for (const n of q('SELECT id FROM notes WHERE deleted IS NOT NULL AND (private = 0 OR owner_id = ?)').all(user.id)) purgeNote(n.id);
  return { ok: true };
});
route('GET', '/api/notes/:id/revisions', ({ user, params }) => {
  getNote(+params.id, user.id); // access check
  return q(`SELECT r.id, r.title, r.reason, r.created, length(r.content) AS size, u.name AS author FROM note_revisions r LEFT JOIN users u ON u.id = r.author_id
    WHERE r.note_id = ? ORDER BY r.created DESC`).all(+params.id);
});
route('GET', '/api/notes/:id/revisions/:rid', ({ user, params }) => {
  getNote(+params.id, user.id);
  return q('SELECT id, title, content, created FROM note_revisions WHERE id = ? AND note_id = ?').get(+params.rid, +params.id) || notFound();
});
route('POST', '/api/notes/:id/revisions/:rid/restore', ({ user, params, origin }) => {
  getNote(+params.id, user.id);
  const r = q('SELECT * FROM note_revisions WHERE id = ? AND note_id = ?').get(+params.rid, +params.id) || notFound();
  return saveNote(user.id, { id: +params.id, title: r.title, content: r.content, revReason: 'Before restoring an earlier version' }, origin);
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

function ensureDaily(uid, d, origin) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) bad('Bad date');
  const ex = q('SELECT id FROM notes WHERE lower(title) = ? AND deleted IS NULL').get(d);
  if (ex) return { id: ex.id };
  const tpl = q("SELECT v FROM kv WHERE k = 'daily_template'").get()?.v ?? '## Focus\n- [ ] \n\n## Log\n- \n';
  return saveNote(uid, { title: d, folder: 'Daily', icon: '📅', content: tpl }, origin);
}
route('GET', '/api/daily/:date', ({ user, params, origin }) => ensureDaily(user.id, params.date, origin));

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
route('GET', '/api/cards/history', ({ user }) => {
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(localDay(Date.now() - i * DAY));
  const counts = new Map(days.map((d) => [d, 0]));
  let good = 0, total = 0;
  for (const r of q('SELECT grade, at FROM card_reviews WHERE user_id = ? AND at >= ?').all(user.id, dayStart(days[0]))) {
    const d = localDay(r.at); if (counts.has(d)) counts.set(d, counts.get(d) + 1);
    total++; if (r.grade >= 2) good++;
  }
  // Streak: consecutive days with at least one review, ending today (or yesterday if today has none yet).
  const reviewedDays = new Set(q('SELECT DISTINCT at FROM card_reviews WHERE user_id = ? AND at >= ?').all(user.id, Date.now() - 400 * DAY).map((r) => localDay(r.at)));
  let streak = 0, cursor = Date.now();
  if (!reviewedDays.has(localDay(cursor))) cursor -= DAY;
  while (reviewedDays.has(localDay(cursor))) { streak++; cursor -= DAY; }
  return { days: days.map((d) => ({ date: d, count: counts.get(d) })), streak, retention: total ? Math.round((good / total) * 100) : null, total30: total,
    week: days.slice(-7).reduce((n, d) => n + counts.get(d), 0) };
});
route('POST', '/api/cards/:id/review', ({ user, params, body }) => {
  const c = q('SELECT * FROM cards WHERE id = ?').get(+params.id) || notFound();
  const g = Math.max(0, Math.min(3, +body.grade | 0));
  const r = review(c, g);
  q('UPDATE cards SET ease = ?, interval = ?, reps = ?, lapses = ?, due = ? WHERE id = ?').run(r.ease, r.interval, r.reps, r.lapses, r.due, c.id);
  q('INSERT INTO card_reviews(card_id, user_id, grade, at) VALUES (?, ?, ?, ?)').run(c.id, user.id, g, Date.now());
  return r;
});

// ---- calendars
route('GET', '/api/calendars', ({ user }) => q(`SELECT c.id, c.user_id, c.name, c.color, c.kind, c.shared, c.last_sync, c.sync_error, c.config, u.name AS owner
  FROM calendars c LEFT JOIN users u ON u.id = c.user_id WHERE c.user_id IS NULL OR c.user_id = ? OR c.shared = 1 ORDER BY c.user_id IS NULL DESC, c.user_id, c.id`).all(user.id)
  .map((c) => { const cfg = JSON.parse(c.config || '{}'); delete c.config; return { ...c, account: cfg.account || null, url: c.user_id === user.id ? cfg.url || null : null, calendarId: cfg.calendarId ?? null, mine: c.user_id === user.id, mailAccess: !!cfg.mail, mailWatch: cfg.mailWatch || null, mailStatus: c.user_id === user.id && cfg.mailWatch ? JSON.parse(q('SELECT v FROM kv WHERE k = ?').get(`mail_status:${c.id}`)?.v || 'null') : null }; }));
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
  if (body.mailWatch) {
    const cfg = JSON.parse(q('SELECT config FROM calendars WHERE id = ?').get(c.id).config);
    cfg.mailWatch = { enabled: !!body.mailWatch.enabled, folder: String(body.mailWatch.folder || 'Nexus').trim().slice(0, 100) || 'Nexus' };
    q('UPDATE calendars SET config = ? WHERE id = ?').run(JSON.stringify(cfg), c.id);
  }
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
  if (ev.note_id && q('SELECT 1 FROM notes WHERE id = ? AND deleted IS NULL').get(ev.note_id)) return { id: ev.note_id };
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
  const mail = p === 'outlook' && new URL(req.url, 'http://x').searchParams.get('mail') === '1';
  oauthStates.set(state, { uid: user.id, provider: p, mail, exp: Date.now() + 600000 });
  res.writeHead(302, { location: authorizeUrl(p, `${baseUrl(req)}/api/oauth/${p}/callback`, state, { mail }) });
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
    if (st.mail) cfg.mail = true;
    const existing = q('SELECT id, config FROM calendars WHERE user_id = ? AND kind = ?').all(st.uid, st.provider).find((c) => JSON.parse(c.config).account === cfg.account);
    let id;
    if (existing) {
      const old = JSON.parse(existing.config);
      q('UPDATE calendars SET config = ?, sync_error = NULL WHERE id = ?').run(JSON.stringify({ ...old, ...cfg, calendarId: old.calendarId ?? cfg.calendarId, mail: st.mail || old.mail || false }), existing.id);
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
  const alarm = Math.max(0, Math.min(1440, +(new URL(req.url, 'http://x').searchParams.get('alarm') ?? 30) || 0));
  const body = generateICS('Household (Nexus)', events, { alarmMinutes: alarm });
  res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-cache', 'content-disposition': 'inline; filename="household.ics"' });
  res.end(body);
}, { raw: true, public: true });

// ---- Ask Claude (streams Server-Sent Events back on the POST response)
const claudeBusy = new Set();
// Attachment lookup for Claude's tools: by id or file name, only on notes Claude may read.
function findAttachment(ref, uid) {
  const r = String(ref ?? '').trim().replace(/^\/files\/(\d+)\/.*$/, '$1');
  const row = /^\d+$/.test(r)
    ? q(`SELECT a.* FROM attachments a JOIN notes n ON n.id = a.note_id WHERE a.id = :r AND ${aiVisible}`).get({ r: +r, uid })
    : q(`SELECT a.* FROM attachments a JOIN notes n ON n.id = a.note_id WHERE lower(a.name) = lower(:r) AND ${aiVisible} ORDER BY a.created DESC`).get({ r, uid });
  if (!row) return null;
  return { ...row, read: () => readFileSync(join(FILES, row.path)) };
}
const toolDeps = { q, visible: aiVisible, aiHidden, saveNote, getNote, createEvent, eventsInRange, health, ensureDaily, findAttachment, unraid: () => (unraid.unraidConfigured() ? unraid.summary(unraidStatus) : null), origin: null };
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
      deps: toolDeps,
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

// ---- Connector for Claude apps (MCP over HTTP, OAuth 2.1 with PKCE) and token-based quick capture
const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
const ACCESS_TTL = 7 * DAY, REFRESH_TTL = 180 * DAY;
const authCodes = new Map(), authRequests = new Map();
const SERVER_TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MCP_INSTRUCTIONS = `Nexus is the user's household "second brain": notes (certification study, work knowledge base, homelab docs, daily notes) and the shared household calendar.
Use the capture tool whenever the user wants to remember, save, jot down or note something, shares a voice memo or idea, or mentions something they need to do – put action items in its tasks with due dates (YYYY-MM-DD) when a day was mentioned. Confirm briefly what was saved.
Search or read notes before answering questions about what the user has written. Times are in the household's time zone (${SERVER_TZ}).
Note links look like [[Note Title]]; tasks are "- [ ] text @YYYY-MM-DD"; properties are "key:: value".`;

function tokenUser(req, kinds) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const row = q(`SELECT t.id, t.kind, t.client_id, t.expires, u.id AS uid, u.name, u.email, u.color FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ?`).get(sha(m[1].trim()));
  if (!row || !kinds.includes(row.kind) || (row.expires && row.expires < Date.now())) return null;
  q('UPDATE api_tokens SET last_used = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.uid, name: row.name, email: row.email, color: row.color, client_id: row.client_id };
}
function issueTokens(uid, clientId) {
  const access = 'nxa_' + token(32), refresh = 'nxr_' + token(32), now = Date.now();
  q('INSERT INTO api_tokens(hash, user_id, kind, client_id, expires, created) VALUES (?, ?, ?, ?, ?, ?)').run(sha(access), uid, 'access', clientId, now + ACCESS_TTL, now);
  q('INSERT INTO api_tokens(hash, user_id, kind, client_id, expires, created) VALUES (?, ?, ?, ?, ?, ?)').run(sha(refresh), uid, 'refresh', clientId, now + REFRESH_TTL, now);
  q("DELETE FROM api_tokens WHERE kind IN ('access','refresh') AND expires < ?").run(now);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: 'nexus' };
}
const oauthError = (res, status, error, description) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error, error_description: description })); };

// Discovery (RFC 9728 protected resource metadata, RFC 8414 authorization server metadata)
const resourceMeta = ({ req }) => ({ resource: `${baseUrl(req)}/mcp`, authorization_servers: [baseUrl(req)], bearer_methods_supported: ['header'], scopes_supported: ['nexus'], resource_name: 'Nexus' });
route('GET', '/.well-known/oauth-protected-resource', resourceMeta, { public: true });
route('GET', '/.well-known/oauth-protected-resource/mcp', resourceMeta, { public: true });
const asMeta = ({ req }) => {
  const b = baseUrl(req);
  return { issuer: b, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`, registration_endpoint: `${b}/oauth/register`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: ['nexus'] };
};
route('GET', '/.well-known/oauth-authorization-server', asMeta, { public: true });
route('GET', '/.well-known/oauth-authorization-server/mcp', asMeta, { public: true });

// Dynamic client registration (RFC 7591) – how the Claude app introduces itself.
route('POST', '/oauth/register', ({ body, res }) => {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  const okUri = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)); } catch { return false; } };
  if (!uris.length || !uris.every(okUri)) return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https URLs');
  if (q('SELECT COUNT(*) c FROM oauth_clients').get().c >= 500) return oauthError(res, 400, 'invalid_client_metadata', 'Too many registered clients');
  const method = ['client_secret_post', 'client_secret_basic'].includes(body.token_endpoint_auth_method) ? body.token_endpoint_auth_method : 'none';
  const clientId = 'nxc_' + token(16), secret = method === 'none' ? null : 'nxs_' + token(32);
  const name = String(body.client_name || 'App').slice(0, 100);
  q('INSERT INTO oauth_clients(client_id, secret_hash, name, redirect_uris, created) VALUES (?, ?, ?, ?, ?)').run(clientId, secret ? sha(secret) : null, name, JSON.stringify(uris), Date.now());
  res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ client_id: clientId, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method }));
}, { public: true, raw: true });

function authPage(res, { title, body, status = 200 }) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Nexus</title>
<style>:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1f2328;--mute:#6b7280;--line:#e5e5e2;--acc:#7c3aed;--panel:#fff}@media(prefers-color-scheme:dark){:root{--bg:#111318;--fg:#e6e6e6;--mute:#9097a3;--line:#2a2e37;--acc:#a78bfa;--panel:#1b1e25}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{width:100%;max-width:400px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:28px}h1{font-size:21px;margin:0 0 8px}.logo{color:var(--acc);font-size:32px}
p{color:var(--mute);margin:8px 0}ul{color:var(--mute);padding-left:20px;margin:8px 0 16px}input{width:100%;box-sizing:border-box;padding:10px 12px;margin:5px 0;border:1px solid var(--line);border-radius:9px;background:transparent;color:inherit;font:inherit}
.row{display:flex;gap:10px;margin-top:16px}button{flex:1;padding:11px;border-radius:9px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}button.go{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}.err{color:#dc2626}</style></head>
<body><main><div class="logo">◆</div>${body}</main></body></html>`);
}
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sessionUser(req) {
  const sid = cookies(req).sid;
  return sid ? q('SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?').get(sid, Date.now()) : null;
}
function consentForm(res, reqId, client, user, error) {
  authPage(res, { title: 'Connect', body: `<h1>Connect ${escH(client.name)} to Nexus</h1>
    <p><b>${escH(client.name)}</b> is asking to use Nexus as ${user ? `<b>${escH(user.name)}</b>` : 'you'}. It will be able to:</p>
    <ul><li>save notes, voice memos and tasks</li><li>search and read your notes</li><li>read and add calendar events</li></ul>
    <form method="post" action="/oauth/authorize"><input type="hidden" name="req" value="${escH(reqId)}">
    ${user ? '' : '<input name="email" type="email" placeholder="Email" autocomplete="username" required><input name="password" type="password" placeholder="Password" autocomplete="current-password" required><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Authenticator code (if two-step sign-in is on)">'}
    ${error ? `<p class="err">${escH(error)}</p>` : ''}
    <div class="row"><button name="action" value="deny" formnovalidate>Cancel</button><button class="go" name="action" value="allow">Allow</button></div></form>
    <p style="font-size:13px">You can disconnect it any time in Nexus → Settings → Phone &amp; Claude app.</p>` });
}
route('GET', '/oauth/authorize', ({ req, res, query }) => {
  const client = q('SELECT * FROM oauth_clients WHERE client_id = ?').get(String(query.client_id || ''));
  const uris = client ? JSON.parse(client.redirect_uris) : [];
  if (!client || !uris.includes(query.redirect_uri)) return authPage(res, { status: 400, title: 'Error', body: '<h1>Can’t connect</h1><p>This app isn’t registered with Nexus, or its return address doesn’t match. Remove the connector and add it again.</p>' });
  const back = (params) => { const u = new URL(query.redirect_uri); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); if (query.state) u.searchParams.set('state', query.state); res.writeHead(302, { location: u.toString() }); res.end(); };
  if (query.response_type !== 'code') return back({ error: 'unsupported_response_type' });
  if (!query.code_challenge || query.code_challenge_method !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
  const reqId = token(18);
  authRequests.set(reqId, { client_id: client.client_id, redirect_uri: query.redirect_uri, state: query.state || '', challenge: query.code_challenge, exp: Date.now() + 15 * 60000 });
  consentForm(res, reqId, client, sessionUser(req));
}, { public: true, raw: true });
route('POST', '/oauth/authorize', ({ req, res, body }) => {
  // Same-origin form posts only (blocks another site from submitting a consent on your behalf).
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) return authPage(res, { status: 403, title: 'Error', body: '<h1>Blocked</h1><p>Cross-site request.</p>' });
  const ar = authRequests.get(String(body.req || ''));
  if (!ar || ar.exp < Date.now()) return authPage(res, { status: 400, title: 'Expired', body: '<h1>This sign-in expired</h1><p>Go back to the Claude app and try connecting again.</p>' });
  const client = q('SELECT * FROM oauth_clients WHERE client_id = ?').get(ar.client_id);
  const back = (params) => { authRequests.delete(String(body.req)); const u = new URL(ar.redirect_uri); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); if (ar.state) u.searchParams.set('state', ar.state); res.writeHead(302, { location: u.toString() }); res.end(); };
  if (body.action !== 'allow') return back({ error: 'access_denied' });
  let user = sessionUser(req);
  if (!user) {
    const ip = String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress);
    const a = loginAttempts.get(ip) || { n: 0, until: 0 };
    if (a.until > Date.now()) return consentForm(res, body.req, client, null, 'Too many attempts – wait a minute.');
    const u = q('SELECT * FROM users WHERE email = ?').get(String(body.email || '').trim());
    if (!u || !checkPw(String(body.password || ''), u.pw)) { a.n++; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; } loginAttempts.set(ip, a); return consentForm(res, body.req, client, null, 'Wrong email or password.'); }
    if (u.totp_secret && !checkSecondFactor(u, body.code)) { a.n++; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; } loginAttempts.set(ip, a); return consentForm(res, body.req, client, null, 'Enter the current 6-digit code from your authenticator app (or a recovery code).'); }
    loginAttempts.delete(ip);
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
    const verifier = String(body.code_verifier || '');
    if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
    return ok(issueTokens(c.uid, client.client_id));
  }
  if (body.grant_type === 'refresh_token') {
    const row = q("SELECT * FROM api_tokens WHERE hash = ? AND kind = 'refresh'").get(sha(body.refresh_token || ''));
    if (!row || row.client_id !== client.client_id || row.expires < Date.now()) return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
    q('DELETE FROM api_tokens WHERE id = ?').run(row.id); // rotate
    return ok(issueTokens(row.user_id, client.client_id));
  }
  return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
}, { public: true, raw: true });

// MCP endpoint (Streamable HTTP transport, JSON responses, stateless).
const mcpToolsFor = (user) => buildTools({ deps: toolDeps, user, tz: SERVER_TZ });
function mcpSchema(t) { const sch = z.toJSONSchema(t.inputSchema); delete sch.$schema; return sch; }
async function mcpHandle(msg, user) {
  const { id, method, params = {} } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid request');
  if (id === undefined) return null; // notification (e.g. notifications/initialized)
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'nexus', title: 'Nexus', version: '1.0.0' }, instructions: MCP_INSTRUCTIONS });
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: mcpToolsFor(user).map((t) => ({ name: t.name, description: t.description, inputSchema: mcpSchema(t),
        annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false, idempotentHint: !!t.readOnly, openWorldHint: false } })) });
    case 'tools/call': {
      const t = mcpToolsFor(user).find((x) => x.name === params.name);
      if (!t) return fail(-32602, `Unknown tool: ${params.name}`);
      const parsed = t.inputSchema.safeParse(params.arguments ?? {});
      if (!parsed.success) return reply({ content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` }], isError: true });
      try {
        const out = await t.run(parsed.data);
        if (!Array.isArray(out)) return reply({ content: [{ type: 'text', text: String(out) }] });
        // Rich results (attachments): images pass through; PDFs aren't supported over the connector yet.
        return reply({ content: out.map((blk) => blk.type === 'image' ? { type: 'image', data: blk.source.data, mimeType: blk.source.media_type }
          : blk.type === 'document' ? { type: 'text', text: `(${blk.title} is a PDF – open it in Nexus, or use Ask Claude inside Nexus to read it.)` }
          : { type: 'text', text: blk.text }) });
      }
      catch (e) { return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }); }
    }
    default: return fail(-32601, `Method not found: ${method}`);
  }
}
route('POST', '/mcp', async ({ req, res, body }) => {
  const user = tokenUser(req, ['access']);
  if (!user) {
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp", scope="nexus"` });
    return res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Connect Nexus from your Claude app to get access.' }));
  }
  const batch = Array.isArray(body);
  const out = (await Promise.all((batch ? body : [body]).map((m) => mcpHandle(m, user)))).filter(Boolean);
  if (!out.length) { res.writeHead(202); return res.end(); }
  const json = JSON.stringify(batch ? out : out[0]);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(json);
}, { public: true, raw: true });
const mcpNoStream = ({ res }) => { res.writeHead(405, { allow: 'POST' }); res.end(); };
route('GET', '/mcp', mcpNoStream, { public: true, raw: true });
route('DELETE', '/mcp', mcpNoStream, { public: true, raw: true });

// Quick capture with a personal token (iPhone Shortcuts / Siri, Android HTTP shortcuts, scripts). No AI involved.
route('POST', '/api/capture', async ({ req, body }) => {
  const user = tokenUser(req, ['pat']);
  if (!user) throw new HttpError(401, 'Missing or invalid capture token');
  let text = String(body.text ?? body.note ?? '').trim();
  if (!text) bad('Send some text');
  const tasks = [];
  const m = /^(?:todo|to do|task|remind me to)[:,]?\s+(.+)$/i.exec(text);
  if (m) { tasks.push({ text: m[1].replace(/[.!]$/, '') }); text = ''; }
  const capture = mcpToolsFor(user).find((t) => t.name === 'capture');
  return { ok: true, message: await capture.run({ text, title: body.title ? String(body.title) : undefined, tasks }) };
}, { public: true });

// Voice memos / photos / files from Shortcuts: POST the raw file to /api/capture/file?name=memo.m4a[&text=transcript]
route('POST', '/api/capture/file', async ({ req, query }) => {
  const user = tokenUser(req, ['pat']);
  if (!user) throw new HttpError(401, 'Missing or invalid capture token');
  const tz = SERVER_TZ, now = new Date();
  const today = now.toLocaleDateString('sv', { timeZone: tz });
  const time = now.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  const daily = ensureDaily(user.id, today, null);
  const name = query.name || req.headers['x-filename'] || `memo-${today}-${time.replace(':', '')}.m4a`;
  const a = await storeUpload(req, { uid: user.id, noteId: daily.id, name, mime: req.headers['content-type'] });
  const text = String(query.text || req.headers['x-text'] || '').trim();
  const cur = getNote(daily.id, user.id);
  const line = `- ${time} ${a.mime.startsWith('audio/') ? '🎙️ Voice memo' : a.mime.startsWith('image/') ? '📷 Photo' : '📎 File'}${text ? `: ${text}` : ''}\n  ${a.markdown}`;
  saveNote(user.id, { id: daily.id, content: appendUnder(cur.content, 'Inbox', line), revReason: 'Before a capture' }, null);
  return { ok: true, message: `Saved ${a.mime.startsWith('audio/') ? 'voice memo' : 'file'} to the Inbox in today's note.` };
}, { public: true, rawBody: true });

// Personal tokens and connected apps (Settings → Phone & Claude app)
route('GET', '/api/tokens', ({ user }) => ({
  tokens: q("SELECT id, name, created, last_used FROM api_tokens WHERE user_id = ? AND kind = 'pat' ORDER BY created DESC").all(user.id),
  apps: q(`SELECT t.client_id, c.name, MIN(t.created) AS created, MAX(t.last_used) AS last_used FROM api_tokens t LEFT JOIN oauth_clients c ON c.client_id = t.client_id
    WHERE t.user_id = ? AND t.kind IN ('access','refresh') AND t.expires > ? GROUP BY t.client_id ORDER BY created DESC`).all(user.id, Date.now()),
}));
route('POST', '/api/tokens', ({ user, body }) => {
  const t = 'nxp_' + token(24);
  q("INSERT INTO api_tokens(hash, user_id, kind, name, created) VALUES (?, ?, 'pat', ?, ?)").run(sha(t), user.id, String(body.name || 'Quick capture').slice(0, 60), Date.now());
  return { token: t };
});
route('DELETE', '/api/tokens/:id', ({ user, params }) => { q("DELETE FROM api_tokens WHERE id = ? AND user_id = ? AND kind = 'pat'").run(+params.id, user.id); return { ok: true }; });
route('DELETE', '/api/apps/:client', ({ user, params }) => { q("DELETE FROM api_tokens WHERE user_id = ? AND client_id = ? AND kind IN ('access','refresh')").run(user.id, decodeURIComponent(params.client)); return { ok: true }; });

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
route('GET', '/api/settings', () => ({ ai_excluded_folders: aiExcluded, daily_template: q("SELECT v FROM kv WHERE k = 'daily_template'").get()?.v ?? '## Focus\n- [ ] \n\n## Log\n- \n' }));
route('PUT', '/api/settings', ({ body }) => { if (Array.isArray(body.ai_excluded_folders)) { q("INSERT OR REPLACE INTO kv(k, v) VALUES ('ai_excluded_folders', ?)").run(JSON.stringify(body.ai_excluded_folders.map((f) => String(f).trim().replace(/^\/+|\/+$/g, '')).filter(Boolean))); loadAiExcluded(); } if (typeof body.daily_template === 'string') q("INSERT OR REPLACE INTO kv(k, v) VALUES ('daily_template', ?)").run(body.daily_template); return { ok: true }; });

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  try {
    if (!path.startsWith('/api/') && !path.startsWith('/ics/') && !path.startsWith('/oauth/') && !path.startsWith('/.well-known/') && !path.startsWith('/files/') && path !== '/mcp') {
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
    const body = r.rawBody ? null : req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' ? await readBody(req) : {};
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
async function backup({ force = false } = {}) {
  const keep = Math.max(1, +(process.env.BACKUP_KEEP ?? 14) || 0);
  if (+(process.env.BACKUP_KEEP ?? 14) === 0 && !force) return;
  const dir = join(DATA, 'backups');
  mkdirSync(dir, { recursive: true });
  const day = new Date().toLocaleDateString('sv');
  const name = `nexus-${day}.db`;
  const files = readdirSync(dir).filter((f) => /^nexus-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  if (!files.includes(name)) {
    store.db.exec(`VACUUM INTO '${join(dir, name).replace(/'/g, "''")}'`);
    for (const f of files.concat(name).slice(0, -keep)) unlinkSync(join(dir, f));
    console.log(`[backup] wrote ${name}`);
  }
  if (offsiteConfigured() && (force || q("SELECT v FROM kv WHERE k = 'offsite_day'").get()?.v !== day)) await offsiteBackup(join(dir, name), name, day);
}

// ---- notifications: morning summary, event/task reminders, homelab alerts, backup problems, weekly review
const DEFAULT_PREFS = { notify: {}, digest: { on: true, time: '07:00' }, remind: { events: 30 }, homelab: true, weekly: true };
const prefsOf = (u) => {
  const p = typeof u.prefs === 'string' ? JSON.parse(u.prefs || '{}') : u.prefs || {};
  return { ...DEFAULT_PREFS, ...p, notify: { ...(p.notify || {}) }, digest: { ...DEFAULT_PREFS.digest, ...(p.digest || {}) }, remind: { ...DEFAULT_PREFS.remind, ...(p.remind || {}) } };
};
const TZN = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const localDay = (ms = Date.now()) => new Date(ms).toLocaleDateString('sv', { timeZone: TZN });
const dayStart = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return zonedToUtc(y, m, d, 0, 0, 0, TZN); };
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZN, hour: 'numeric', minute: '2-digit' });
const link = (path) => (PUBLIC_URL ? `${PUBLIC_URL}/#${path}` : undefined);
async function notifyUser(u, msg) {
  const prefs = prefsOf(u);
  if (!hasChannel(prefs)) return [];
  const r = await deliver(prefs, msg);
  for (const x of r) if (!x.ok) console.warn(`[notify] ${u.name} via ${x.channel}: ${x.error}`);
  return r;
}
let notifyAll = async (kind, title, body, extra = {}) => {
  for (const u of q('SELECT * FROM users').all()) {
    const p = prefsOf(u);
    if ((kind === 'homelab' && !p.homelab) || (kind === 'weekly' && !p.weekly)) continue;
    await notifyUser(u, { title, body, ...extra }).catch(() => {});
  }
};
// Who an event is for: its "who" list, else the owner of a personal calendar, else (Household calendars) everyone.
const involves = (e, uid) => { if (e.who?.length) return e.who.includes(uid); const owner = q('SELECT user_id FROM calendars WHERE id = ?').get(e.calendar_id)?.user_id; return owner ? owner === uid : true; };

function digestFor(u) {
  const today = localDay(), start = dayStart(today), end = dayStart(localDay(start + 36 * 3600e3));
  const names = new Map(q('SELECT id, name FROM users').all().map((x) => [x.id, x.name]));
  const cals = new Map(q('SELECT id, user_id, name FROM calendars').all().map((c) => [c.id, c]));
  const { events } = eventsInRange(u.id, start, end);
  const todays = events.filter((e) => (e.all_day ? e.start <= today && e.end > today : Date.parse(e.start) < end && Date.parse(e.end) > start))
    .sort((a, b) => (a.all_day ? -1 : b.all_day ? 1 : a.start < b.start ? -1 : 1));
  const who = (e) => { const w = e.who?.length ? e.who : cals.get(e.calendar_id)?.user_id ? [cals.get(e.calendar_id).user_id] : []; return w.map((id) => names.get(id)).filter(Boolean).join(' & ') || 'Everyone'; };
  const tasks = q(`SELECT t.text, t.due, t.time, n.title FROM tasks t JOIN notes n ON n.id = t.note_id WHERE ${visible} AND t.done = 0 AND t.due IS NOT NULL AND t.due <= :today ORDER BY t.due, t.time`).all({ uid: u.id, today });
  const cards = q(`SELECT COUNT(*) c FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.active = 1 AND c.due <= :now AND ${visible}`).get({ now: Date.now(), uid: u.id }).c;
  const down = [...health.entries()].filter(([, h]) => h.down).map(([id]) => q('SELECT title FROM notes WHERE id = ?').get(id)?.title).filter(Boolean);
  const exams = q(`SELECT n.title, f.value AS d FROM fields f JOIN notes n ON n.id = f.note_id JOIN tags t ON t.note_id = n.id AND t.tag = 'cert' WHERE f.key = 'exam date' AND f.value >= :today AND ${visible} ORDER BY f.value LIMIT 3`).all({ today, uid: u.id });
  const L = [];
  L.push(todays.length ? `📅 Today:\n${todays.map((e) => `• ${e.all_day ? 'All day' : fmtTime(e.start)} – ${e.title}${e.location ? ` @ ${e.location}` : ''} (${who(e)})`).join('\n')}` : '📅 Nothing on the calendar today.');
  if (tasks.length) L.push(`✅ Due${tasks.some((t) => t.due < today) ? ' & overdue' : ''}:\n${tasks.slice(0, 12).map((t) => `• ${t.text}${t.due < today ? ` (was due ${t.due})` : t.time ? ` at ${t.time}` : ''}`).join('\n')}${tasks.length > 12 ? `\n…and ${tasks.length - 12} more` : ''}`);
  if (cards) L.push(`🃏 ${cards} flashcard${cards === 1 ? '' : 's'} due for review.`);
  for (const x of exams) { const days = Math.round((dayStart(x.d) - start) / DAY); if (days <= 30) L.push(`🎓 ${x.title}: exam in ${days} day${days === 1 ? '' : 's'}.`); }
  if (down.length) L.push(`🔴 Down: ${down.join(', ')}`);
  if (unraidStatus) { const pr = unraid.problems(unraidStatus); if (pr.length) L.push(`🖥️ Unraid: ${pr.map((p) => p.text).join('; ')}`); }
  const title = `☀️ ${new Date(start + 12 * 3600e3).toLocaleDateString('en-US', { timeZone: TZN, weekday: 'long', month: 'short', day: 'numeric' })}`;
  const body = L.join('\n\n');
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;max-width:560px"><h2 style="margin:0 0 12px">${escH(title)}</h2>${L.map((x) => `<p style="margin:0 0 14px;white-space:pre-line">${escH(x)}</p>`).join('')}${link('/home') ? `<p><a href="${link('/home')}">Open Nexus</a></p>` : ''}</div>`;
  return { title, body, html, url: link('/home'), tags: ['sunny'] };
}

async function notificationTick() {
  const now = Date.now(), today = localDay(now);
  const w = wallParts(now, TZN), hhmm = `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
  const once = (key) => { const r = q('INSERT OR IGNORE INTO notify_log(key, at) VALUES (?, ?)').run(key, now); return r.changes > 0; };
  for (const u of q('SELECT * FROM users').all()) {
    const p = prefsOf(u);
    if (!hasChannel(p)) continue;
    // Morning summary
    if (p.digest.on && hhmm >= (p.digest.time || '07:00') && once(`digest:${u.id}:${today}`)) await notifyUser(u, digestFor(u)).catch(() => {});
    // Event & timed-task reminders
    const lead = +p.remind.events || 0;
    if (lead > 0) {
      const { events, tasks } = eventsInRange(u.id, now, now + lead * 60000 + 60000);
      for (const e of events) {
        if (e.all_day || !involves(e, u.id)) continue;
        const st = Date.parse(e.start);
        if (st <= now || st > now + lead * 60000) continue;
        if (!once(`rem:${u.id}:${e.id}:${e.start}`)) continue;
        const mins = Math.round((st - now) / 60000);
        await notifyUser(u, { title: `⏰ ${e.title} at ${fmtTime(e.start)}`, body: `Starts in ${mins} minute${mins === 1 ? '' : 's'}${e.location ? ` · ${e.location}` : ''}.`, url: link('/calendar'), tags: ['alarm_clock'] }).catch(() => {});
      }
      for (const t of tasks) {
        if (t.done || !t.time || (t.owner_id && t.owner_id !== u.id)) continue;
        const [y, m, d] = t.due.split('-').map(Number), [hh, mm] = t.time.split(':').map(Number);
        const at = zonedToUtc(y, m, d, hh, mm, 0, TZN);
        if (at <= now || at > now + lead * 60000 || !once(`remt:${u.id}:${t.note_id}:${t.text}:${t.due}`)) continue;
        await notifyUser(u, { title: `⏰ ${t.text}`, body: `Due at ${t.time} (in [[${t.note_title}]]).`, url: link(`/note/${t.note_id}`), tags: ['alarm_clock'] }).catch(() => {});
      }
    }
  }
  // Weekly review (default: Sundays at 18:00 server time)
  const wd = new Date(dayStart(today) + 12 * 3600e3).getUTCDay();
  if (process.env.WEEKLY_REVIEW !== 'off' && wd === +(process.env.WEEKLY_REVIEW_DAY ?? 0) && hhmm >= (process.env.WEEKLY_REVIEW_TIME || '18:00') && once(`weekly:${isoWeek(now)}`)) await weeklyReview().catch((e) => console.warn(`[weekly] ${e.message}`));
  q('DELETE FROM notify_log WHERE at < ? AND key NOT LIKE \'offsite:%\'').run(now - 14 * DAY);
}

// ---- Unraid server status (polled; alerts on new problems and on containers that stop)
let unraidStatus = null, unraidProblems = new Set(), unraidRunning = null;
async function pollUnraid() {
  if (!unraid.unraidConfigured()) return;
  const s = await unraid.fetchStatus();
  const probs = unraid.problems(s);
  const keys = new Set(probs.map((p) => p.key));
  // New problems, plus ones already present at startup – each at most once a day (so restarts don't re-alert).
  const day = localDay();
  const fresh = probs.filter((p) => !unraidProblems.has(p.key) && q('INSERT OR IGNORE INTO notify_log(key, at) VALUES (?, ?)').run(`unraid:${p.key}:${day}`, Date.now()).changes);
  if (fresh.length) notifyAll('homelab', `🖥️ Unraid: ${fresh[0].text}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`, fresh.map((p) => `• ${p.text}`).join('\n'), { url: link('/home'), priority: 'high', tags: ['warning'] });
  if (s.containers) {
    const running = new Set(s.containers.filter((c) => c.state === 'RUNNING').map((c) => c.name));
    const stopped = unraidRunning ? [...unraidRunning].filter((n) => !running.has(n) && s.containers.some((c) => c.name === n)) : [];
    if (stopped.length) notifyAll('homelab', `🐳 Container stopped: ${stopped.join(', ')}`, `${stopped.join(', ')} ${stopped.length > 1 ? 'are' : 'is'} no longer running on Unraid.`, { url: link('/home'), tags: ['whale'] });
    unraidRunning = running;
  }
  unraidStatus = s; unraidProblems = keys;
  broadcast('services', {});
}
route('GET', '/api/unraid', () => ({ configured: unraid.unraidConfigured(), status: unraidStatus, problems: unraidStatus ? unraid.problems(unraidStatus) : [] }));
route('POST', '/api/unraid/refresh', async () => { await pollUnraid().catch((e) => bad(e.message)); return { status: unraidStatus, problems: unraidStatus ? unraid.problems(unraidStatus) : [] }; });

// ---- weekly review: facts gathered here (household-shared notes only, respecting "hide from AI"), written up by Claude
const isoWeek = (ms = Date.now()) => {
  const [y, m, d] = localDay(ms).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d)); const dow = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dow);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / DAY + 1) / 7)).padStart(2, '0')}`;
};
function weeklyFacts() {
  const now = Date.now(), today = localDay(), weekAgo = now - 7 * DAY, start = dayStart(today);
  const shared = `(n.deleted IS NULL AND n.private = 0 AND ai_hidden(n.folder, n.noai) = 0)`;
  const names = new Map(q('SELECT id, name FROM users').all().map((x) => [x.id, x.name]));
  const F = [];
  const edited = q(`SELECT n.title, n.folder, n.created, n.updated_by FROM notes n WHERE ${shared} AND n.updated >= ? AND n.title NOT LIKE 'Weekly review %' ORDER BY n.updated DESC LIMIT 60`).all(weekAgo);
  F.push(`Notes created or edited in the last 7 days (${edited.length}):\n${edited.map((n) => `- [[${n.title}]]${n.folder ? ` (${n.folder})` : ''} – ${n.created >= weekAgo ? 'new' : 'edited'} by ${names.get(n.updated_by) || '?'}`).join('\n') || '- none'}`);
  const cals = new Map(q('SELECT id, user_id, name FROM calendars').all().map((c) => [c.id, c]));
  const { events, tasks } = eventsInRange(0, start, start + 8 * DAY);
  const who = (e) => { const w = e.who?.length ? e.who : cals.get(e.calendar_id)?.user_id ? [cals.get(e.calendar_id).user_id] : []; return w.map((i) => names.get(i)).filter(Boolean).join(' & ') || 'everyone'; };
  const fmt = (e) => (e.all_day ? `${e.start} (all day)` : new Date(e.start).toLocaleString('en-US', { timeZone: TZN, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  F.push(`Calendar, next 7 days:\n${events.filter((e) => (e.all_day ? e.end > today : Date.parse(e.end) > now)).sort((a, b) => (a.start < b.start ? -1 : 1)).map((e) => `- ${fmt(e)}: ${e.title} – for ${who(e)}${e.location ? ` @ ${e.location}` : ''}`).join('\n') || '- nothing scheduled'}`);
  const open = q(`SELECT t.text, t.due, n.title FROM tasks t JOIN notes n ON n.id = t.note_id WHERE ${shared} AND t.done = 0 AND t.due IS NOT NULL AND t.due <= ? ORDER BY t.due`).all(localDay(now + 7 * DAY));
  F.push(`Open tasks overdue or due within 7 days (today is ${today}):\n${open.map((t) => `- ${t.text} – due ${t.due}${t.due < today ? ' (OVERDUE)' : ''} – in [[${t.title}]]`).join('\n') || '- none'}`);
  const stale = q(`SELECT n.title, n.updated, (SELECT value FROM fields f WHERE f.note_id = n.id AND f.key = 'reviewed') AS reviewed FROM notes n JOIN tags t ON t.note_id = n.id AND t.tag = 'kb' WHERE ${shared}`).all()
    .filter((n) => (n.reviewed ? n.reviewed < localDay(now - 180 * DAY) : n.updated < now - 180 * DAY));
  if (stale.length) F.push(`Knowledge-base articles not reviewed in 6+ months:\n${stale.slice(0, 20).map((n) => `- [[${n.title}]] (last reviewed ${n.reviewed || localDay(n.updated)})`).join('\n')}`);
  const certs = q(`SELECT n.id, n.title, (SELECT value FROM fields f WHERE f.note_id = n.id AND f.key = 'exam date') AS exam, (SELECT value FROM fields f WHERE f.note_id = n.id AND f.key = 'status') AS status FROM notes n JOIN tags t ON t.note_id = n.id AND t.tag = 'cert' WHERE ${shared}`).all();
  const reviews = q('SELECT user_id, COUNT(*) c FROM card_reviews WHERE at >= ? GROUP BY user_id').all(weekAgo);
  const dueCards = q(`SELECT COUNT(*) c FROM cards c JOIN notes n ON n.id = c.note_id WHERE c.active = 1 AND c.due <= ? AND ${shared}`).get(now).c;
  if (certs.length || reviews.length) F.push(`Study:\n${certs.map((c) => `- [[${c.title}]]: status ${c.status || '?'}${c.exam ? `, exam ${c.exam} (${Math.round((dayStart(c.exam) - start) / DAY)} days away)` : ''}`).join('\n')}\n- Flashcard reviews this week: ${reviews.map((r) => `${names.get(r.user_id)} ${r.c}`).join(', ') || 'none'}; cards due now: ${dueCards}`);
  const down = [...health.entries()].filter(([, h]) => h.down).map(([id]) => q('SELECT title FROM notes WHERE id = ?').get(id)?.title).filter(Boolean);
  const ur = unraidStatus ? unraid.problems(unraidStatus).map((p) => p.text) : [];
  if (down.length || ur.length) F.push(`Homelab problems:\n${[...down.map((d) => `- ${d} is down`), ...ur.map((u) => `- Unraid: ${u}`)].join('\n')}`);
  return F.join('\n\n');
}
async function weeklyReview() {
  const week = isoWeek(), facts = weeklyFacts();
  let body, byClaude = false;
  if (assistant.configured()) {
    try { body = await assistant.writeWeeklyReview(facts, week); byClaude = true; } catch (e) { console.warn(`[weekly] Claude: ${e.message}`); }
  }
  if (!body) body = `## The week in facts\n\n${facts.replace(/^([^\n-][^\n]*:)$/gm, '### $1')}`; // plain version without Claude
  const owner = q('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
  const title = `Weekly review ${week}`;
  const content = `${body}\n\n---\n*${byClaude ? 'Written by Claude from' : 'Generated from'} this week's notes, calendar and tasks · ${localDay()}*`;
  const ex = q('SELECT id FROM notes WHERE lower(title) = lower(?) AND deleted IS NULL').get(title);
  const note = ex ? saveNote(owner, { id: ex.id, content, revReason: 'Before the weekly review was rewritten' }, null) : saveNote(owner, { title, folder: 'Reviews', icon: '🗓️', content }, null);
  await notifyAll('weekly', `🗓️ ${title} is ready`, (body.match(/## This week at a glance\s+([^\n#]+)/) || [null, 'Your weekly review is in Nexus.'])[1].trim().slice(0, 300), { url: link(`/note/${note.id}`), tags: ['spiral_calendar'] });
  return note;
}
route('POST', '/api/review/weekly', async () => weeklyReview());

// ---- email → calendar (Outlook folder, read by Claude)
async function processMail(cal) {
  const cfg = JSON.parse(cal.config || '{}'), w = cfg.mailWatch || {};
  if (!cfg.mail || !w.enabled) return null;
  const status = { at: Date.now(), ok: true, processed: 0, added: 0, error: null };
  try {
    if (!assistant.configured()) throw new Error('Email → calendar uses Claude to read the emails – add ANTHROPIC_API_KEY first.');
    const household = q("SELECT * FROM calendars WHERE user_id IS NULL AND kind = 'local' ORDER BY id LIMIT 1").get();
    const msgs = await outlookMail(store, cal, { folder: w.folder || 'Nexus' });
    for (const m of msgs) {
      if (!q('INSERT OR IGNORE INTO notify_log(key, at) VALUES (?, ?)').run(`mail:${m.id}`, Date.now()).changes) { await outlookMarkRead(store, cal, m.id).catch(() => {}); continue; }
      const x = await assistant.extractEventsFromEmail({ ...m, today: localDay(), tz: TZN });
      const added = [];
      for (const e of x.events) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
        const [y, mo, d] = e.date.split('-').map(Number);
        const tm = (t) => /^\d{1,2}:\d{2}$/.test(t || '') ? t.split(':').map(Number) : null;
        const st = tm(e.start_time), en = tm(e.end_time);
        const allDay = !st;
        const start = allDay ? e.date : new Date(zonedToUtc(y, mo, d, st[0], st[1], 0, TZN)).toISOString();
        const end = allDay ? localDay(dayStart(e.date) + 36 * 3600e3) : en ? new Date(zonedToUtc(y, mo, d, en[0], en[1], 0, TZN)).toISOString() : new Date(Date.parse(start) + 3600e3).toISOString();
        await createEvent(cal.user_id, { calendar_id: household.id, title: e.title, start, end, all_day: allDay, tz: TZN, who: [cal.user_id], location: e.location || '',
          description: [e.details, `From email: “${m.subject}” (${m.from})`].filter(Boolean).join('\n\n') }, null);
        added.push(`${e.title} (${allDay ? e.date : new Date(start).toLocaleString('en-US', { timeZone: TZN, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})`);
      }
      const daily = ensureDaily(cal.user_id, localDay(), null);
      const time = new Date().toLocaleTimeString('en-GB', { timeZone: TZN, hour: '2-digit', minute: '2-digit' });
      const cur = getNote(daily.id, cal.user_id);
      saveNote(cal.user_id, { id: daily.id, content: appendUnder(cur.content, 'Inbox', `- ${time} 📧 ${m.subject} → ${added.length ? `added to calendar: ${added.join('; ')}` : `no appointment found (${x.summary})`}`), revReason: 'Before a capture' }, null);
      await outlookMarkRead(store, cal, m.id);
      status.processed++; status.added += added.length;
    }
  } catch (e) { status.ok = false; status.error = e.message; console.warn(`[mail] ${cal.name}: ${e.message}`); }
  q('INSERT OR REPLACE INTO kv(k, v) VALUES (?, ?)').run(`mail_status:${cal.id}`, JSON.stringify(status));
  if (status.added) broadcast('events', {});
  return status;
}
route('POST', '/api/calendars/:id/mail/check', async ({ user, params }) => {
  const c = q('SELECT * FROM calendars WHERE id = ? AND user_id = ?').get(+params.id, user.id) || notFound();
  return (await processMail(c)) || bad('Turn on email → calendar for this calendar first');
});

route('GET', '/api/notify', ({ user }) => ({ prefs: prefsOf(q('SELECT prefs FROM users WHERE id = ?').get(user.id)), smtp: smtpConfigured(), pushover: pushoverConfigured() }));
route('PUT', '/api/notify', ({ user, body }) => {
  const p = prefsOf({ prefs: body });
  const clean = { notify: { ntfy: String(p.notify.ntfy || '').trim(), ntfyToken: String(p.notify.ntfyToken || '').trim(), pushover: String(p.notify.pushover || '').trim(), email: String(p.notify.email || '').trim() },
    digest: { on: !!p.digest.on, time: /^\d{2}:\d{2}$/.test(p.digest.time) ? p.digest.time : '07:00' }, remind: { events: Math.max(0, Math.min(1440, +p.remind.events || 0)) }, homelab: !!p.homelab, weekly: !!p.weekly };
  q('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(clean), user.id);
  return { prefs: clean };
});
route('POST', '/api/notify/test', async ({ user, body }) => {
  const u = q('SELECT * FROM users WHERE id = ?').get(user.id);
  const msg = body.digest ? digestFor(u) : { title: '👋 Nexus test notification', body: 'Notifications are working. You can change what you get in Settings → Notifications.', url: link('/settings'), tags: ['tada'] };
  const r = await notifyUser(u, msg);
  if (!r.length) bad('Add at least one way to reach you first (ntfy, Pushover or email), then save.');
  return { results: r };
});

// ---- off-server backups (encrypted) to S3-compatible storage and/or a folder on another disk
const OFF = {
  endpoint: process.env.BACKUP_S3_ENDPOINT, bucket: process.env.BACKUP_S3_BUCKET, region: process.env.BACKUP_S3_REGION || 'us-east-1',
  accessKeyId: process.env.BACKUP_S3_KEY_ID, secretAccessKey: process.env.BACKUP_S3_SECRET, prefix: (process.env.BACKUP_S3_PREFIX || 'nexus').replace(/^\/|\/$/g, ''),
  pass: process.env.BACKUP_PASSPHRASE, dir: process.env.BACKUP_COPY_DIR, keep: +(process.env.BACKUP_REMOTE_KEEP || 30),
};
const s3Configured = () => !!(OFF.endpoint && OFF.bucket && OFF.accessKeyId && OFF.secretAccessKey);
const offsiteConfigured = () => s3Configured() || !!OFF.dir;
async function offsiteBackup(file, name, day) {
  const status = { at: Date.now(), ok: true, targets: [], files: 0, error: null };
  try {
    if (s3Configured() && !OFF.pass) throw new Error('Set BACKUP_PASSPHRASE – Nexus only uploads encrypted backups to cloud storage.');
    const pack = (buf) => (OFF.pass ? encrypt(buf, OFF.pass) : buf);
    const ext = OFF.pass ? '.enc' : '';
    const dbBuf = pack(readFileSync(file));
    const s3 = s3Configured() ? s3Client(OFF) : null;
    const pending = q('SELECT id, path FROM attachments WHERE id NOT IN (SELECT CAST(substr(key, 14) AS INTEGER) FROM notify_log WHERE key LIKE \'offsite:file:%\') ORDER BY id LIMIT 2000').all();
    if (s3) {
      await s3.put(`${OFF.prefix}/db/${name}${ext}`, dbBuf);
      for (const a of pending) { try { await s3.put(`${OFF.prefix}/files/${a.path}${ext}`, pack(readFileSync(join(FILES, a.path)))); } catch (e) { if (!/ENOENT/.test(e.message)) throw e; } }
      const old = (await s3.list(`${OFF.prefix}/db/`)).filter((k) => /nexus-\d{4}-\d{2}-\d{2}\.db/.test(k)).sort();
      for (const k of old.slice(0, Math.max(0, old.length - OFF.keep))) await s3.del(k);
      status.targets.push(`${OFF.bucket} (${new URL(OFF.endpoint).hostname})`);
    }
    if (OFF.dir) {
      mkdirSync(join(OFF.dir, 'db'), { recursive: true });
      writeFileSync(join(OFF.dir, 'db', name + ext), dbBuf);
      for (const a of pending) {
        try { const dest = join(OFF.dir, 'files', a.path + ext); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, pack(readFileSync(join(FILES, a.path)))); } catch (e) { if (!/ENOENT/.test(e.message)) throw e; }
      }
      const old = readdirSync(join(OFF.dir, 'db')).filter((f) => /^nexus-\d{4}-\d{2}-\d{2}\.db/.test(f)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - OFF.keep))) unlinkSync(join(OFF.dir, 'db', f));
      status.targets.push(OFF.dir);
    }
    for (const a of pending) q('INSERT OR IGNORE INTO notify_log(key, at) VALUES (?, ?)').run(`offsite:file:${a.id}`, Date.now());
    status.files = pending.length; status.encrypted = !!OFF.pass; status.bytes = dbBuf.length;
    q("INSERT OR REPLACE INTO kv(k, v) VALUES ('offsite_day', ?)").run(day);
    console.log(`[backup] off-server copy to ${status.targets.join(' + ')} (${pending.length} new files)`);
  } catch (e) {
    status.ok = false; status.error = e.message;
    console.warn(`[backup] off-server copy failed: ${e.message}`);
    notifyAll?.('backup', '⚠️ Nexus backup failed', `The off-server backup didn't complete: ${e.message}`);
  }
  q("INSERT OR REPLACE INTO kv(k, v) VALUES ('offsite_status', ?)").run(JSON.stringify(status));
  return status;
}
route('GET', '/api/backup', () => ({
  local: (() => { try { return readdirSync(join(DATA, 'backups')).filter((f) => f.endsWith('.db')).sort().reverse().slice(0, 3); } catch { return []; } })(),
  offsite: { configured: offsiteConfigured(), s3: s3Configured(), folder: !!OFF.dir, encrypted: !!OFF.pass, status: JSON.parse(q("SELECT v FROM kv WHERE k = 'offsite_status'").get()?.v || 'null') },
}));
route('POST', '/api/backup/run', async () => { await backup({ force: true }); return JSON.parse(q("SELECT v FROM kv WHERE k = 'offsite_status'").get()?.v || '{"ok":true}'); });

async function syncAll() {
  for (const c of q("SELECT * FROM calendars WHERE kind != 'local'").all()) {
    try { await syncCalendar(store, c); } catch (e) { console.warn(`[sync] ${c.name}: ${e.message}`); }
    if (c.kind === 'outlook') await processMail(c).catch(() => {});
  }
  broadcast('events', {});
}
if (process.env.NODE_ENV !== 'test') {
  setInterval(syncAll, +(process.env.SYNC_MINUTES || 10) * 60000).unref();
  setInterval(() => checkServices().catch(() => {}), +(process.env.HEALTH_SECONDS || 120) * 1000).unref();
  setInterval(() => {
    q('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    for (const n of q('SELECT id FROM notes WHERE deleted IS NOT NULL AND deleted < ?').all(Date.now() - 30 * DAY)) purgeNote(n.id); // empty trash after 30 days
    q('DELETE FROM note_revisions WHERE created < ?').run(Date.now() - 180 * DAY);
  }, 3600000).unref();
  setInterval(() => backup().catch((e) => console.warn(`[backup] ${e.message}`)), 3600000).unref();
  setTimeout(() => backup().catch((e) => console.warn(`[backup] ${e.message}`)), 60000).unref();
  setInterval(() => notificationTick().catch((e) => console.warn(`[notify] ${e.message}`)), 60000).unref();
  if (unraid.unraidConfigured()) { setInterval(() => pollUnraid().catch((e) => console.warn(`[unraid] ${e.message}`)), +(process.env.UNRAID_POLL_SECONDS || 300) * 1000).unref(); setTimeout(() => pollUnraid().catch(() => {}), 5000).unref(); }
  setTimeout(() => notificationTick().catch(() => {}), 15000).unref();
  setTimeout(() => { syncAll(); checkServices().catch(() => {}); }, 3000).unref();
}

seedV2();
server.keepAliveTimeout = 65000;
server.listen(PORT, HOST, () => console.log(`Nexus listening on http://${HOST}:${PORT}  (data: ${DATA})`));

const shutdown = () => { server.close(); for (const c of clients) c.res.end(); store.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, store };
