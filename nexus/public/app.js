import { render, inline, outline, esc } from './md.js';
import { enhanceEditor, fuzzy } from './editor.js';
import { mountCalendar, openEventModal, loadItems, invalidateEvents, dstr } from './calendar.js';

// ------------------------------------------------------------------ core utilities
const $ = (s, r = document) => r.querySelector(s);
const clientId = Math.random().toString(36).slice(2);
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = (...a) => { clearTimeout(t); fn(...a); }; d.cancel = () => clearTimeout(t); return d; };
const today = () => dstr(new Date());
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : s < 604800 ? `${Math.floor(s / 86400)}d ago` : new Date(ms).toLocaleDateString(); };
const hashColor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return `hsl(${Math.abs(h) % 360} 60% 55%)`; };

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-client-id': clientId }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && !path.startsWith('/api/login')) { showAuth(); throw new Error('Signed out'); }
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function toast(msg, type = '') {
  const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.classList.add('out'), 3200); setTimeout(() => t.remove(), 3600);
}

function modal(title, html, onMount, cls = '') {
  const wrap = document.createElement('div'); wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal ${cls}" role="dialog" aria-label="${esc(title)}"><div class="mhead"><h3>${esc(title)}</h3><button class="x" aria-label="Close">✕</button></div><div class="mbody">${html}</div></div>`;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', esc_); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc_);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  $('.x', wrap).onclick = close;
  onMount?.($('.modal', wrap), close);
  $('[autofocus]', wrap)?.focus();
  return close;
}

const listeners = {};
const on = (t, f) => (listeners[t] ||= new Set()).add(f);
const emit = (t, d) => listeners[t]?.forEach((f) => f(d));

// ------------------------------------------------------------------ state
const state = { me: null, users: [], notes: [], byId: new Map(), byTitle: new Map(), supertags: [], calendars: [], integrations: {}, tagCounts: [], due: 0 };
const app = { api, state, toast, modal, emit, on, go: (p) => { location.hash = '#' + p; }, userById: (id) => state.users.find((u) => u.id === +id) };
window.nexus = app;
app.mdctx = (extra) => mdctx(extra);
app.openByTitle = (t) => openByTitle(t);
app.setTitle = (t) => setTitle(t);

function setNotes(list) {
  state.notes = list;
  state.byId = new Map(list.map((n) => [n.id, n]));
  state.byTitle = new Map(list.map((n) => [n.title.toLowerCase(), n]));
}
const exists = (t) => state.byTitle.has(String(t).toLowerCase());
const stByName = (n) => state.supertags.find((s) => s.name === n);
const tagStyle = (t) => { const s = stByName(t); return s ? `--tc:${s.color}` : ''; };
const mdctx = (extra = {}) => ({ exists, tagStyle, ...extra });

async function loadNotes() { setNotes(await api('GET', '/api/notes')); renderSidebar(); }
async function loadMeta() {
  const [st, cals, tags, stats] = await Promise.all([api('GET', '/api/supertags'), api('GET', '/api/calendars'), api('GET', '/api/tags'), api('GET', '/api/cards/stats')]);
  state.supertags = st; state.calendars = cals; state.tagCounts = tags; state.due = stats.due || 0;
}
const refreshNotes = debounce(async () => { await loadNotes(); state.tagCounts = await api('GET', '/api/tags'); renderSidebar(); }, 250);

// ------------------------------------------------------------------ auth
async function showAuth() {
  const { setup } = await fetch('/api/status').then((r) => r.json());
  document.body.className = 'auth';
  document.body.innerHTML = `<div class="authbox"><div class="logo">◆</div><h1>Nexus</h1>
    <p class="muted">${setup ? 'Create the first account for your household. You can invite your partner from Settings.' : 'Sign in to your household workspace.'}</p>
    <form>${setup ? '<input name="name" placeholder="Your name" required autocomplete="name">' : ''}
      <input name="email" type="email" placeholder="Email" required autocomplete="username">
      <input name="password" type="password" placeholder="Password${setup ? ' (8+ characters)' : ''}" required minlength="${setup ? 8 : 1}" autocomplete="${setup ? 'new-password' : 'current-password'}">
      <input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code from your authenticator app" hidden>
      <button class="btn primary">${setup ? 'Create workspace' : 'Sign in'}</button><p class="err"></p></form></div>`;
  const f = $('form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    if (!body.code) delete body.code;
    try {
      const r = await api('POST', setup ? '/api/setup' : '/api/login', body);
      if (r.totp) { const c = f.code; c.hidden = false; c.required = true; c.focus(); $('.err').textContent = 'Two-step sign-in is on – enter the code from your authenticator app (or a recovery code).'; return; }
      location.reload();
    } catch (err) { $('.err').textContent = err.message; }
  };
}

// ------------------------------------------------------------------ layout & sidebar
function shell() {
  document.body.className = '';
  document.body.innerHTML = `
  <div id="app">
    <aside id="side">
      <div class="brand"><span class="logo">◆</span> Nexus <button class="iconbtn" id="themeBtn" title="Toggle theme">◐</button></div>
      <button class="searchbtn" id="searchBtn">🔍 <span>Search or jump…</span><kbd>Ctrl K</kbd></button>
      <nav id="nav"></nav>
      <div id="tree"></div>
      <div class="me" id="meBox"></div>
    </aside>
    <div id="scrim"></div>
    <div id="mainwrap"><header id="topbar"><button class="iconbtn" id="menuBtn" aria-label="Menu">☰</button><span id="toptitle">Nexus</span><button class="iconbtn" id="topSearch" aria-label="Search">🔍</button><button class="iconbtn" id="topNew" aria-label="New note">＋</button></header>
    <main id="main"></main></div>
  </div><div id="toasts"></div>`;
  $('#searchBtn').onclick = $('#topSearch').onclick = () => palette();
  $('#topNew').onclick = () => newNote();
  $('#menuBtn').onclick = () => document.body.classList.toggle('sideopen');
  $('#scrim').onclick = () => document.body.classList.remove('sideopen');
  $('#themeBtn').onclick = () => { const t = { auto: 'dark', dark: 'light', light: 'auto' }[LS.get('theme', 'auto')]; LS.set('theme', t); applyTheme(); toast(`Theme: ${t}`); };
  $('#side').addEventListener('click', sideClick);
  $('#side').addEventListener('dragstart', (e) => { const n = e.target.closest('[data-note]'); if (n) e.dataTransfer.setData('text/nexus-note', n.dataset.note); });
  $('#side').addEventListener('dragover', (e) => { const f = e.target.closest('[data-folder]'); if (f && e.dataTransfer.types.includes('text/nexus-note')) { e.preventDefault(); f.classList.add('drop'); } });
  $('#side').addEventListener('dragleave', (e) => e.target.closest('[data-folder]')?.classList.remove('drop'));
  $('#side').addEventListener('drop', async (e) => {
    const f = e.target.closest('[data-folder]'); if (!f) return;
    e.preventDefault(); f.classList.remove('drop');
    const id = +e.dataTransfer.getData('text/nexus-note');
    await api('PUT', `/api/notes/${id}`, { folder: f.dataset.folder });
    state.byId.get(id).folder = f.dataset.folder; renderSidebar();
  });
}
function applyTheme() { const t = LS.get('theme', 'auto'); document.documentElement.dataset.theme = t === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t; }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

const openFolders = new Set(LS.get('tree.open', ['Certifications', 'Work KB', 'Homelab']));
function renderSidebar() {
  if (!$('#nav')) return;
  const route = location.hash.slice(1) || '/home';
  const navItem = (href, icon, label, badge) => `<a href="#${href}" class="${route.startsWith(href) ? 'active' : ''}"><span class="ni">${icon}</span>${label}${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
  $('#nav').innerHTML = navItem('/home', '🏠', 'Home') + navItem('/calendar', '📅', 'Calendar') + navItem('/claude', '✨', 'Ask Claude') + `<a href="#/daily" class="${route.startsWith('/daily') ? 'active' : ''}"><span class="ni">📓</span>Today's note</a>` +
    navItem('/tasks', '✅', 'Tasks') + navItem('/review', '🃏', 'Review', state.due || '') + navItem('/graph', '🕸️', 'Graph') + navItem('/settings', '⚙️', 'Settings') + navItem('/trash', '🗑️', 'Trash');

  const counts = new Map(state.tagCounts.map((t) => [t.tag, t.count]));
  const supers = state.supertags.map((s) => `<a href="#/db/${encodeURIComponent(s.name)}" class="${route === '/db/' + s.name ? 'active' : ''}"><span class="ni">${esc(s.icon || '#')}</span>${esc(s.name)}<span class="cnt">${counts.get(s.name) || 0}</span></a>`).join('');
  const pinned = state.notes.filter((n) => n.pinned).sort((a, b) => a.title.localeCompare(b.title));
  const curId = +(/^\/note\/(\d+)/.exec(route)?.[1] || 0);

  // Folder tree
  const root = { folders: new Map(), notes: [] };
  for (const n of state.notes) {
    let node = root;
    if (n.folder) for (const part of n.folder.split('/')) { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), notes: [] }); node = node.folders.get(part); }
    node.notes.push(n);
  }
  const noteRow = (n, depth) => `<a href="#/note/${n.id}" class="nrow${n.id === curId ? ' active' : ''}" data-note="${n.id}" draggable="true" style="--d:${depth}"><span class="ni">${esc(n.icon || '📄')}</span><span class="nt">${esc(n.title)}</span>${n.private ? '<span class="lock">🔒</span>' : ''}</a>`;
  const walk = (node, path, depth) => {
    let h = '';
    for (const [name, child] of [...node.folders].sort((a, b) => a[0].localeCompare(b[0]))) {
      const p = path ? `${path}/${name}` : name, open = openFolders.has(p);
      h += `<div class="frow${open ? ' open' : ''}" data-folder="${esc(p)}" style="--d:${depth}"><span class="caret">▸</span><span class="ni">📁</span><span class="nt">${esc(name)}</span><button class="iconbtn sm" data-newin="${esc(p)}" title="New note here">＋</button></div>`;
      if (open) h += walk(child, p, depth + 1);
    }
    for (const n of node.notes.sort((a, b) => a.title.localeCompare(b.title))) h += noteRow(n, depth);
    return h;
  };
  $('#tree').innerHTML = `
    <div class="sect"><div class="sh">Databases <a href="#/tags" class="shl">all tags</a><button class="iconbtn sm" id="newSuper" title="New supertag">＋</button></div>${supers}</div>
    ${pinned.length ? `<div class="sect"><div class="sh">Pinned</div>${pinned.map((n) => noteRow(n, 0)).join('')}</div>` : ''}
    <div class="sect"><div class="sh" data-folder="">Notes <button class="iconbtn sm" data-newin="" title="New note">＋</button></div>${walk(root, '', 0)}</div>`;
  if (state.me) $('#meBox').innerHTML = `<span class="avatar" style="background:${state.me.color}">${esc(state.me.name[0] || '?')}</span><span>${esc(state.me.name)}</span><button class="iconbtn sm" id="logoutBtn" title="Sign out">⎋</button>`;
}

function sideClick(e) {
  const nb = e.target.closest('[data-newin]');
  if (nb) { e.preventDefault(); e.stopPropagation(); return newNote({ folder: nb.dataset.newin }); }
  if (e.target.closest('#newSuper')) return editSupertag(null);
  if (e.target.closest('#logoutBtn')) return api('POST', '/api/logout').then(() => location.reload());
  const f = e.target.closest('.frow');
  if (f) {
    const p = f.dataset.folder;
    openFolders.has(p) ? openFolders.delete(p) : openFolders.add(p);
    LS.set('tree.open', [...openFolders]); renderSidebar(); return;
  }
  if (e.target.closest('a')) document.body.classList.remove('sideopen');
}

// ------------------------------------------------------------------ router
let current = null; // { name, teardown }
async function route() {
  const h = location.hash.slice(1) || '/home';
  if (current?.teardown) { try { await current.teardown(); } catch {} }
  current = null;
  const main = $('#main');
  main.className = '';
  main.scrollTop = 0;
  let m;
  try {
    if ((m = /^\/note\/(\d+)/.exec(h))) await viewNote(main, +m[1]);
    else if (h.startsWith('/calendar')) await viewCalendar(main);
    else if (h.startsWith('/daily')) { const d = h.split('/')[2] || today(); const r = await api('GET', `/api/daily/${d}`); if (!state.byId.has(r.id)) await loadNotes(); location.replace(`#/note/${r.id}`); return; }
    else if ((m = /^\/db\/([^?]+)/.exec(h))) await viewDb(main, decodeURIComponent(m[1]));
    else if (h.startsWith('/tags')) await viewTags(main);
    else if (h.startsWith('/tasks')) await viewTasks(main);
    else if (h.startsWith('/review')) await viewReview(main, new URLSearchParams(h.split('?')[1] || ''));
    else if (h.startsWith('/graph')) await viewGraph(main);
    else if (h.startsWith('/claude')) { const { viewClaude } = await import('./claude.js'); current = { name: 'claude', ...(await viewClaude(main, app, new URLSearchParams(h.split('?')[1] || ''))) }; }
    else if (h.startsWith('/settings')) await viewSettings(main, new URLSearchParams(h.split('?')[1] || ''));
    else if (h.startsWith('/trash')) await viewTrash(main);
    else await viewHome(main);
  } catch (err) {
    if (err.status === 404) main.innerHTML = `<div class="page"><div class="empty-state">That page doesn't exist (anymore). <a href="#/home">Go home</a></div></div>`;
    else if (err.message !== 'Signed out') { console.error(err); main.innerHTML = `<div class="page"><div class="empty-state">Something went wrong: ${esc(err.message)}</div></div>`; }
  }
  renderSidebar();
}
const setTitle = (t) => { document.title = t ? `${t} · Nexus` : 'Nexus'; $('#toptitle').textContent = t || 'Nexus'; };

// ------------------------------------------------------------------ notes
async function newNote({ title = 'Untitled', folder, supertag, content } = {}) {
  if (folder === undefined) { const cur = /^#\/note\/(\d+)/.exec(location.hash); folder = cur ? state.byId.get(+cur[1])?.folder || '' : ''; }
  const n = await api('POST', '/api/notes', { title, folder, supertag, content });
  await loadNotes();
  LS.set('focusTitle', n.id);
  app.go(`/note/${n.id}`);
}
async function openByTitle(title) {
  const n = state.byTitle.get(title.toLowerCase());
  if (n) return app.go(`/note/${n.id}`);
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(title);
  if (isDate) return app.go(`/daily/${title}`);
  const r = await api('POST', '/api/notes', { title, folder: '' });
  await loadNotes(); app.go(`/note/${r.id}`);
}

const FIELD_RE = /^\s*(?:[-*]\s+)?([\p{L}\p{N}_][\p{L}\p{N}_ \-]{0,40}?)::\s*(.*)$/u;
function setFieldText(content, key, value) {
  const lines = content.split('\n'), lk = key.toLowerCase();
  let code = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { code = !code; continue; }
    const m = !code && FIELD_RE.exec(lines[i]);
    if (m && m[1].trim().toLowerCase() === lk) { lines[i] = lines[i].replace(/::\s*.*$/, `:: ${value}`); return lines.join('\n'); }
  }
  let at = 0;
  while (at < lines.length && (FIELD_RE.test(lines[at]) || /^\s*(#[\p{L}\p{N}_][^\s]*\s*)+$/u.test(lines[at]))) at++;
  lines.splice(at, 0, `${key}:: ${value}`);
  return lines.join('\n');
}
function fieldInput(f, value, attrs = '') {
  const v = esc(value ?? '');
  if (f.type === 'select') return `<select ${attrs}><option value=""></option>${(f.options || []).map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}${value && !(f.options || []).includes(value) ? `<option selected>${v}</option>` : ''}</select>`;
  const type = { date: 'date', number: 'number', url: 'url' }[f.type] || 'text';
  return `<input type="${type}" value="${v}" ${attrs} placeholder="—">`;
}

async function viewNote(main, id) {
  const n = await api('GET', `/api/notes/${id}`);
  setTitle(n.title);
  main.className = 'notemain';
  let mode = LS.get('note.mode', innerWidth > 1200 ? 'split' : 'read');
  if (!n.content.trim() && mode === 'read') mode = 'edit';
  let dirty = false, saving = false, base = n.updated, alive = true;
  const isDaily = /^\d{4}-\d{2}-\d{2}$/.test(n.title);
  const schema = () => {
    const tags = new Set((n.content.match(/(?:^|[\s(,])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu) || []).map((t) => t.trim().replace(/^[(,]?#/, '').toLowerCase()));
    return state.supertags.filter((s) => tags.has(s.name) && s.fields.length);
  };

  main.innerHTML = `<div class="note">
    <div class="ntop"><span class="crumb" title="Move to folder">📁 ${esc(n.folder || 'Notes')}</span><span class="status" id="saveState"></span><span class="sp"></span>
      <div class="seg" id="modeSeg">${['edit', 'split', 'read'].map((m) => `<button data-m="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>
      <button class="iconbtn" id="attachBtn" title="Attach a file or record a voice memo">📎</button>
      <a class="iconbtn" href="#/claude?note=${n.id}" title="Ask Claude about this note">✨</a>
      <button class="iconbtn" id="pinBtn" title="Pin">${n.pinned ? '📌' : '📍'}</button>
      <button class="iconbtn" id="moreBtn" title="More">⋯</button></div>
    <div id="conflict"></div>
    <div class="nhead"><button class="nicon" id="iconBtn" title="Change icon">${esc(n.icon || '📄')}</button><input class="ntitle" id="titleIn" value="${esc(n.title)}" spellcheck="false"></div>
    ${isDaily ? `<div class="dailynav"><a href="#/daily/${dstr(new Date(new Date(n.title + 'T12:00').getTime() - 864e5))}">‹ Previous day</a><span>${new Date(n.title + 'T12:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span><a href="#/daily/${dstr(new Date(new Date(n.title + 'T12:00').getTime() + 864e5))}">Next day ›</a></div>` : ''}
    <div id="propForm"></div>
    <div class="nbody" id="nbody"><textarea class="editor" id="ed" spellcheck="true" placeholder="Start writing…  Type / for commands, [[ to link, # to tag."></textarea><article class="preview md" id="pv"></article></div>
    <div class="nfoot muted">Edited ${ago(n.updated)}${n.updated_by_name ? ` by ${esc(n.updated_by_name)}` : ''} · ${n.private ? '🔒 Private to you' : '👥 Shared with household'}${n.ai_hidden ? ` · 🙈 Hidden from AI${n.noai ? '' : ' (folder setting)'}` : ''}</div>
  </div>
  <aside class="rpanel" id="rpanel"></aside>`;

  const ed = $('#ed'), pv = $('#pv');
  ed.value = n.content;
  // Auto-grow the textarea so the page (not the textarea) scrolls, like a document.
  let growQueued = false;
  const grow = () => { if (growQueued) return; growQueued = true; requestAnimationFrame(() => { growQueued = false; const sc = $('.note', main); if (!sc) return; const y = sc.scrollTop; ed.style.height = 'auto'; ed.style.height = ed.scrollHeight + 'px'; sc.scrollTop = y; }); };
  ed.addEventListener('input', grow);
  new ResizeObserver(grow).observe(ed.parentElement);

  const drawProps = () => {
    const sch = schema();
    if (!sch.length) { $('#propForm').innerHTML = ''; return; }
    const fields = {};
    for (const l of ed.value.split('\n')) { const m = FIELD_RE.exec(l); if (m && !(m[1].trim().toLowerCase() in fields)) fields[m[1].trim().toLowerCase()] = m[2].trim(); }
    $('#propForm').innerHTML = sch.map((s) => `<div class="propcard" style="--tc:${s.color}"><div class="propst"><a href="#/db/${encodeURIComponent(s.name)}">${esc(s.icon)} #${esc(s.name)}</a></div>
      <div class="propgrid">${s.fields.map((f) => `<label>${esc(f.name)}</label>${fieldInput(f, fields[f.name.toLowerCase()], `data-k="${esc(f.name)}"`)}`).join('')}</div></div>`).join('');
  };
  const hideKeys = () => new Set(schema().flatMap((s) => s.fields.map((f) => f.name.toLowerCase())));
  const drawPreview = () => {
    pv.innerHTML = render(ed.value, mdctx({ hide: hideKeys() })) || '<p class="muted">Empty note. Switch to Edit (Ctrl+E) to start writing.</p>';
    pv.querySelectorAll('.props').forEach((p) => {
      const hide = hideKeys(); const kids = [...p.children];
      for (let i = 0; i < kids.length; i += 2) if (hide.has(kids[i].textContent.trim().toLowerCase())) { kids[i].remove(); kids[i + 1].remove(); }
      if (!p.children.length) p.remove();
    });
  };
  const drawRight = async () => {
    const ol = outline(ed.value);
    const cardCount = (ed.value.match(/^\s*(?:[-*]\s+)?.+?\s+\?\?\s+.+$/gm) || []).length + (ed.value.match(/^\s*A:\s+/gm) || []).length;
    let html = '';
    if (isDaily) html += `<div class="rsec"><h4>Agenda</h4><div id="dayAgenda" class="muted">Loading…</div></div>`;
    if (ol.length) html += `<div class="rsec"><h4>Outline</h4>${ol.map((h) => `<a class="ol" data-line="${h.line}" style="--l:${h.level}">${esc(h.text)}</a>`).join('')}</div>`;
    html += `<div class="rsec"><h4>Backlinks <span class="cnt">${n.backlinks.length}</span></h4>${n.backlinks.length ? n.backlinks.map((b) => `<div class="bl" data-href="#/note/${b.id}"><b>${esc(b.icon || '📄')} ${esc(b.title)}</b><span>${inline(b.context.replace(/^\s*(?:[-*+]\s+|>\s*|\d+\.\s+)+/, '').replace(/\[!\w+\][+-]?\s*/, ''), mdctx())}</span></div>`).join('') : '<p class="muted">No other notes link here yet.</p>'}</div>`;
    if (n.events?.length) html += `<div class="rsec"><h4>Linked events</h4>${n.events.map((e) => `<div class="muted">📅 ${esc(e.title)} · ${new Date(e.start).toLocaleString([], { dateStyle: 'medium', timeStyle: e.all_day ? undefined : 'short' })}</div>`).join('')}</div>`;
    if (cardCount) html += `<div class="rsec"><h4>Flashcards</h4><p>${cardCount} card${cardCount > 1 ? 's' : ''} in this note.</p><a class="btn" href="#/review?note=${n.id}">Study this note</a></div>`;
    $('#rpanel').innerHTML = html;
    if (isDaily) {
      const d = new Date(n.title + 'T00:00');
      const items = await loadItems(app, d, new Date(+d + 864e5)).catch(() => []);
      const el = $('#dayAgenda'); if (!el) return;
      el.className = '';
      el.innerHTML = items.length ? items.map((it) => `<div class="mini${it.conflict ? ' conflict' : ''}" style="--c:${it.color}">${it.allDay ? '' : `<b>${it.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b> `}${it.kind === 'task' ? (it.done ? '☑ ' : '☐ ') : ''}${esc(it.title)} ${it.people.map((p) => app.userById(p)).filter(Boolean).map((u) => `<i class="pdot" style="background:${u.color}"></i>`).join('')}</div>`).join('') + '<a href="#/calendar" class="muted">Open calendar →</a>'
        : '<p class="muted">Nothing scheduled. <a href="#/calendar">Open calendar</a></p>';
    }
  };
  const setMode = (m) => {
    mode = m; LS.set('note.mode', m); if (m !== 'read') LS.set('note.lastEdit', m);
    $('#nbody').className = `nbody mode-${m}`;
    main.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    if (m !== 'edit') drawPreview();
    if (m !== 'read') { grow(); setTimeout(() => ed.focus({ preventScroll: true }), 0); }
  };

  const status = (t, cls = '') => { const s = $('#saveState'); if (s) { s.textContent = t; s.className = `status ${cls}`; } };
  async function save(force = false) {
    if (!dirty || saving) return;
    saving = true; dirty = false; status('Saving…');
    const content = ed.value;
    try {
      const r = await api('PUT', `/api/notes/${id}`, { content, base: force ? undefined : base });
      base = r.updated; n.content = r.content ?? content; status('Saved', 'ok');
      if (r.content !== undefined && ed.value === content) { // server added the next occurrence of a recurring task
        const sel = [ed.selectionStart, ed.selectionEnd]; ed.value = r.content; ed.setSelectionRange(...sel); drawPreview(); toast('Next occurrence added 🔁');
      }
      const ln = state.byId.get(id); if (ln) ln.updated = r.updated;
      refreshNotes();
    } catch (err) {
      dirty = true;
      if (err.status === 409) {
        const who = app.userById(err.data.current.updated_by)?.name || 'someone';
        $('#conflict').innerHTML = `<div class="conflictbar">⚠ ${esc(who)} changed this note while you were editing. <button class="btn" data-c="theirs">Load their version</button><button class="btn danger" data-c="mine">Keep mine</button></div>`;
        $('#conflict').onclick = async (e) => {
          const c = e.target.dataset.c; if (!c) return;
          $('#conflict').innerHTML = '';
          if (c === 'theirs') { ed.value = err.data.current.content; grow(); base = err.data.current.updated; dirty = false; drawPreview(); drawProps(); status('Loaded latest'); }
          else { base = 0; dirty = true; save(true); }
        };
        status('Conflict', 'err');
      } else status('Not saved – retrying', 'err');
    } finally { saving = false; if (dirty && !$('#conflict').innerHTML) autosave(); }
  }
  const autosave = debounce(() => save(), 700);
  const livePreview = debounce(() => { if (mode !== 'edit') drawPreview(); drawProps(); }, ed.value.length > 50000 ? 400 : 120);
  const rightLater = debounce(() => drawRight().then(drawFiles), 1500);

  ed.addEventListener('input', () => { dirty = true; status('Editing…'); autosave(); livePreview(); rightLater(); });
  enhanceEditor(ed, {
    titles: () => state.notes.map((x) => x.title),
    tags: () => { const s = new Map(state.supertags.map((t) => [t.name, { name: t.name, icon: t.icon, super: true }])); for (const t of state.tagCounts) if (!s.has(t.tag)) s.set(t.tag, { name: t.tag }); return [...s.values()]; },
    templates: () => state.supertags,
    onSave: () => autosave.flush(),
  });

  // ---- attachments: paste, drag & drop, 📎 menu, in-browser voice recorder
  const insertAtCursor = (text) => {
    if (mode === 'read') setMode('split');
    ed.focus();
    const pos = ed.selectionStart, before = ed.value.slice(0, pos);
    const pre = before && !before.endsWith('\n') ? '\n' : '';
    ed.setRangeText(`${pre}${text}\n`, pos, ed.selectionEnd, 'end');
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  };
  async function uploadFiles(files) {
    for (const f of files) {
      if (!f || !f.size) continue;
      status(`Uploading ${f.name}…`);
      try {
        const res = await fetch(`/api/files?note=${id}&name=${encodeURIComponent(f.name || 'file')}`, { method: 'POST', body: f, headers: { 'content-type': f.type || 'application/octet-stream', 'x-client-id': clientId } });
        const j = await res.json(); if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        insertAtCursor(j.markdown); status('Uploaded', 'ok');
      } catch (err) { toast(`Upload failed: ${err.message}`, 'error'); status('Upload failed', 'err'); }
    }
    drawFiles();
  }
  ed.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); uploadFiles(files); } });
  for (const el of [ed, pv]) {
    el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); el.classList.add('dropping'); } });
    el.addEventListener('dragleave', () => el.classList.remove('dropping'));
    el.addEventListener('drop', (e) => { el.classList.remove('dropping'); if (e.dataTransfer?.files.length) { e.preventDefault(); uploadFiles([...e.dataTransfer.files]); } });
  }
  $('#attachBtn').onclick = () => modal('Attach', `<div class="menu"><button data-x="file">📎 Attach files (images, PDFs, anything)</button><button data-x="rec">🎙️ Record a voice memo</button></div>`, (box, close) => {
    box.onclick = (e) => {
      const x = e.target.closest('[data-x]')?.dataset.x; if (!x) return;
      close();
      if (x === 'file') { const inp = Object.assign(document.createElement('input'), { type: 'file', multiple: true }); inp.onchange = () => uploadFiles([...inp.files]); inp.click(); }
      if (x === 'rec') recordMemo((file, note) => { uploadFiles([file]).then(() => note && insertAtCursor(note)); });
    };
  });
  const drawFiles = async () => {
    const files = await api('GET', `/api/notes/${id}/files`).catch(() => []);
    let box = $('#rfiles');
    if (!files.length) { box?.remove(); return; }
    if (!box) { box = document.createElement('div'); box.className = 'rsec'; box.id = 'rfiles'; $('#rpanel')?.prepend(box); }
    box.innerHTML = `<h4>Attachments <span class="cnt">${files.length}</span></h4>${files.map((f) => `<div class="fileitem"><a href="${esc(f.url)}" target="_blank" rel="noopener">${f.mime.startsWith('image/') ? '🖼️' : f.mime.startsWith('audio/') ? '🎙️' : f.mime === 'application/pdf' ? '📄' : '📎'} ${esc(f.name)}</a><span class="muted">${f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.ceil(f.size / 1024) + ' KB'}</span><button class="iconbtn sm" data-delfile="${f.id}" title="Delete file">✕</button></div>`).join('')}`;
  };
  $('#rpanel').addEventListener('click', async (e) => {
    const d = e.target.dataset.delfile;
    if (d && confirm('Delete this file? Links to it in the note will stop working.')) { await api('DELETE', `/api/files/${d}`); drawFiles(); }
  });

  $('#propForm').addEventListener('change', (e) => {
    const k = e.target.dataset.k; if (!k) return;
    ed.value = setFieldText(ed.value, k, e.target.value);
    dirty = true; autosave(); if (mode !== 'edit') drawPreview();
  });
  $('#modeSeg').onclick = (e) => e.target.dataset.m && setMode(e.target.dataset.m);
  const saveTitle = async () => {
    const t = $('#titleIn').value.trim();
    if (!t || t === n.title) return;
    try {
      const r = await api('PUT', `/api/notes/${id}`, { title: t });
      n.title = r.title; $('#titleIn').value = r.title; setTitle(r.title);
      if (r.title !== t) toast(`A note named “${t}” exists – saved as “${r.title}”`);
      await loadNotes();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#titleIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveTitle(); setMode(mode === 'read' ? 'edit' : mode); ed.focus(); } });
  $('#titleIn').addEventListener('blur', saveTitle);
  $('#iconBtn').onclick = async () => {
    const icons = ['📄', '📘', '🎓', '🖥️', '🧯', '🗓️', '💡', '🔐', '🧪', '📦', '🐳', '🌐', '🛠️', '📊', '🏠', '❤️', '⭐', '🔥', '✅', '📌', '🧠', '💼', '🎯', '📚'];
    modal('Choose icon', `<div class="icongrid">${icons.map((i) => `<button data-i="${i}">${i}</button>`).join('')}</div><input placeholder="…or type/paste any emoji" maxlength="4" id="customIcon">`, (box, close) => {
      const set = async (i) => { await api('PUT', `/api/notes/${id}`, { icon: i }); $('#iconBtn').textContent = i; state.byId.get(id).icon = i; renderSidebar(); close(); };
      box.onclick = (e) => e.target.dataset.i && set(e.target.dataset.i);
      $('#customIcon', box).onkeydown = (e) => e.key === 'Enter' && e.target.value && set(e.target.value);
    });
  };
  $('#pinBtn').onclick = async () => { n.pinned = !n.pinned; await api('PUT', `/api/notes/${id}`, { pinned: n.pinned }); $('#pinBtn').textContent = n.pinned ? '📌' : '📍'; state.byId.get(id).pinned = n.pinned ? 1 : 0; renderSidebar(); };
  $('.crumb', main).onclick = () => moveNote(n);
  $('#moreBtn').onclick = () => modal('Note', `<div class="menu">
      <button data-a="move">📁 Move to folder…</button>
      <button data-a="private">${n.private ? '👥 Share with household' : '🔒 Make private (only you)'}</button>
      <button data-a="noai">${n.noai ? '🤖 Allow Claude to read this note' : '🙈 Hide from AI (Claude can’t read it)'}</button>
      <button data-a="md">⬇️ Download as Markdown</button>
      <button data-a="copy">🔗 Copy link</button>
      <button data-a="history">🕘 Version history</button>
      <button data-a="del" class="danger">🗑️ Move to trash</button></div>`, (box, close) => {
    box.onclick = async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      close();
      if (a === 'move') moveNote(n);
      if (a === 'private') { n.private = !n.private; await api('PUT', `/api/notes/${id}`, { private: n.private }); toast(n.private ? 'Now private to you' : 'Shared with household'); route(); }
      if (a === 'md') { const b = new Blob([ed.value], { type: 'text/markdown' }); const u = URL.createObjectURL(b); Object.assign(document.createElement('a'), { href: u, download: `${n.title}.md` }).click(); URL.revokeObjectURL(u); }
      if (a === 'copy') { navigator.clipboard?.writeText(location.href); toast('Link copied'); }
      if (a === 'noai') { n.noai = !n.noai; await api('PUT', `/api/notes/${id}`, { noai: n.noai }); toast(n.noai ? 'Hidden from AI' : 'Claude can read this note again'); route(); }
      if (a === 'history') { await save(); showHistory(n, () => route()); }
      if (a === 'del' && confirm(`Move “${n.title}” to the trash? You can restore it for 30 days.`)) { await api('DELETE', `/api/notes/${id}`); dirty = false; await loadNotes(); toast('Moved to trash'); app.go('/home'); }
    };
  });

  // Preview interactions
  pv.addEventListener('click', async (e) => {
    const t = e.target;
    const wl = t.closest('.wl'); if (wl) { e.preventDefault(); await save(); return openByTitle(wl.dataset.title); }
    const tg = t.closest('.tag'); if (tg) { e.preventDefault(); return app.go(`/db/${encodeURIComponent(tg.dataset.tag)}`); }
    if (t.matches('input[type=checkbox][data-line]')) {
      const lines = ed.value.split('\n'), ln = +t.dataset.line;
      lines[ln] = lines[ln].replace(/\[([ xX])\]/, t.checked ? '[x]' : '[ ]');
      ed.value = lines.join('\n'); dirty = true; autosave(); t.closest('li')?.classList.toggle('done', t.checked); return;
    }
    if (t.classList.contains('fa')) { t.parentElement.classList.toggle('show'); t.textContent = t.parentElement.classList.contains('show') ? 'Hide answer' : 'Show answer'; return; }
    if (t.classList.contains('fold')) { t.parentElement.classList.toggle('collapsed'); return; }
    if (t.classList.contains('copy')) { navigator.clipboard?.writeText(t.parentElement.querySelector('code').textContent); toast('Copied'); }
  });
  pv.addEventListener('dblclick', (e) => {
    if (mode !== 'read' || e.target.closest('a,input,button')) return;
    const line = +(e.target.closest('[data-line]')?.dataset.line ?? -1);
    setMode('edit');
    if (line >= 0) { const pos = ed.value.split('\n').slice(0, line).join('\n').length + (line ? 1 : 0); ed.setSelectionRange(pos, pos); ed.blur(); ed.focus(); }
  });
  $('#rpanel').addEventListener('click', (e) => {
    const bl = e.target.closest('.bl');
    if (bl) { const wl = e.target.closest('.wl'); return wl ? openByTitle(wl.dataset.title) : (location.hash = bl.dataset.href); }
    const ol = e.target.closest('.ol'); if (!ol) return;
    const line = +ol.dataset.line;
    if (mode === 'edit') { const pos = ed.value.split('\n').slice(0, line).join('\n').length + 1; ed.setSelectionRange(pos, pos); ed.blur(); ed.focus(); }
    else pv.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  setMode(mode); drawProps(); drawRight().then(drawFiles);
  if (LS.get('focusTitle') === id) { LS.set('focusTitle', 0); $('#titleIn').focus(); $('#titleIn').select(); }

  const onRemote = async (d) => {
    if (d.id !== id || !alive) return;
    if (d.deleted) { toast('This note was deleted'); return app.go('/home'); }
    if (dirty || d.updated <= base) return;
    const fresh = await api('GET', `/api/notes/${id}`);
    if (dirty) return;
    const sel = [ed.selectionStart, ed.selectionEnd];
    Object.assign(n, fresh); base = fresh.updated; ed.value = fresh.content; grow();
    if (document.activeElement === ed) ed.setSelectionRange(...sel);
    drawPreview(); drawProps(); drawRight().then(drawFiles);
    status(`Updated by ${fresh.updated_by_name || 'someone'}`, 'ok');
  };
  const onEvents = () => isDaily && drawRight().then(drawFiles);
  on('remote-note', onRemote); on('events', onEvents);
  const beforeUnload = (e) => { if (dirty) { save(); e.preventDefault(); } };
  addEventListener('beforeunload', beforeUnload);
  current = { name: 'note', id, setMode: () => setMode(mode === 'read' ? LS.get('note.lastEdit', 'split') : 'read'), save: () => autosave.flush(),
    teardown: async () => { alive = false; listeners['remote-note']?.delete(onRemote); listeners.events?.delete(onEvents); removeEventListener('beforeunload', beforeUnload); autosave.cancel(); if (dirty) await save(); } };
}

// In-browser voice memo recorder (works on iPhone Safari 14.3+, Android, desktop).
function recordMemo(onDone) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Recording isn’t supported in this browser – use the 📎 button to attach a recording instead.', 'error');
  modal('Voice memo', `<div class="rec"><div class="rtime" id="rtime">0:00</div><div class="rlevel"><i id="rlevel"></i></div>
    <button class="btn primary big" id="rbtn">● Start recording</button>
    <textarea id="rnote" rows="2" placeholder="Optional: a line about this memo"></textarea><p class="small muted">Recordings are saved into this note as playable audio. Nexus doesn't transcribe audio; for text, dictate with your keyboard's mic.</p></div>`, (box, close) => {
    let rec, stream, chunks = [], t0, timer, raf;
    const btn = box.querySelector('#rbtn');
    const stopAll = () => { clearInterval(timer); cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
    box.closest('.overlay').addEventListener('click', (e) => { if (e.target.classList.contains('overlay')) stopAll(); });
    box.querySelector('.x')?.addEventListener('click', stopAll);
    btn.onclick = async () => {
      if (rec?.state === 'recording') { rec.stop(); btn.disabled = true; btn.textContent = 'Saving…'; return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Microphone permission was denied.', 'error'); }
      const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
      rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stopAll();
        const mime = (rec.mimeType || type || 'audio/webm').split(';')[0];
        const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        const stamp = new Date().toLocaleString('sv').slice(0, 16).replace(' ', '-').replace(':', '');
        const file = new File(chunks, `voice-memo-${stamp}.${ext}`, { type: mime });
        const note = box.querySelector('#rnote').value.trim();
        close(); onDone(file, note);
      };
      rec.start(1000); t0 = Date.now();
      btn.textContent = '■ Stop and save';
      timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); box.querySelector('#rtime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 250);
      try {
        const ctx = new AudioContext(), an = ctx.createAnalyser(); ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => { an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); const lvl = box.querySelector('#rlevel'); if (lvl) lvl.style.width = Math.min(100, m * 1.6) + '%'; raf = requestAnimationFrame(tick); };
        tick();
      } catch {}
    };
  });
}

function moveNote(n) {
  const folders = [...new Set(state.notes.map((x) => x.folder).filter(Boolean))].sort();
  modal('Move to folder', `<form><input name="f" list="folderlist" value="${esc(n.folder)}" placeholder="Folder path, e.g. Homelab/Docker" autofocus><datalist id="folderlist">${folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
    <div class="actions"><span class="sp"></span><button class="btn primary">Move</button></div></form>`, (box, close) => {
    $('form', box).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.f.value.trim().replace(/^\/+|\/+$/g, '');
      await api('PUT', `/api/notes/${n.id}`, { folder: f }); n.folder = f;
      if (f) f.split('/').reduce((p, s) => { const x = p ? `${p}/${s}` : s; openFolders.add(x); return x; }, '');
      LS.set('tree.open', [...openFolders]);
      close(); await loadNotes(); route();
    };
  });
}

// ------------------------------------------------------------------ version history & trash
async function showHistory(n, onRestore) {
  const revs = await api('GET', `/api/notes/${n.id}/revisions`);
  if (!revs.length) return toast('No earlier versions yet – they are saved as you edit.');
  modal(`History · ${n.title}`, `<div class="hist"><div class="hlist">${revs.map((r, i) => `<button class="hitem${i ? '' : ' on'}" data-r="${r.id}"><b>${new Date(r.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</b><span>${esc(r.author || '')}${r.reason ? ` · ${esc(r.reason)}` : ''}</span></button>`).join('')}</div>
    <div class="hview"><div class="hbar"><span class="muted small">Showing the note as it was at this time.</span><button class="btn primary sm" id="hRestore">Restore this version</button></div><article class="md" id="hPrev"></article></div></div>`, async (box, close) => {
    let cur = revs[0].id;
    const show = async (rid) => {
      cur = rid; box.querySelectorAll('.hitem').forEach((b) => b.classList.toggle('on', +b.dataset.r === rid));
      const r = await api('GET', `/api/notes/${n.id}/revisions/${rid}`);
      box.querySelector('#hPrev').innerHTML = (r.title !== n.title ? `<p class="muted">Title: <b>${esc(r.title)}</b></p>` : '') + render(r.content, mdctx());
    };
    box.querySelector('.hlist').onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) show(+b.dataset.r); };
    box.querySelector('#hRestore').onclick = async () => {
      if (!confirm('Restore this version? The current version is kept in the history.')) return;
      await api('POST', `/api/notes/${n.id}/revisions/${cur}/restore`); close(); toast('Version restored', 'ok'); await loadNotes(); onRestore?.();
    };
    show(cur);
  }, 'wide');
}

async function viewTrash(main) {
  setTitle('Trash');
  const items = await api('GET', '/api/trash');
  main.innerHTML = `<div class="page"><div class="dbhead"><h1>🗑️ Trash</h1><span class="sp"></span>${items.length ? '<button class="btn danger" id="emptyTrash">Empty trash</button>' : ''}</div>
    <p class="muted">Deleted notes stay here for 30 days, then they're removed for good.</p>
    ${items.map((n) => `<div class="calrow"><span>${esc(n.icon || '📄')}</span><div class="cinfo"><b>${esc(n.title)}</b><span class="muted">${esc(n.folder || 'Notes')} · deleted ${ago(n.deleted)}${n.deleted_by ? ` by ${esc(n.deleted_by)}` : ''} · ${Math.max(0, 30 - Math.floor((Date.now() - n.deleted) / 864e5))} days left</span></div>
      <button class="btn sm" data-restore="${n.id}">Restore</button><button class="btn sm danger" data-purge="${n.id}">Delete forever</button></div>`).join('') || '<div class="empty-state">The trash is empty.</div>'}</div>`;
  main.onclick = async (e) => {
    const r = e.target.dataset.restore, p = e.target.dataset.purge;
    if (r) { const x = await api('POST', `/api/trash/${r}/restore`); await loadNotes(); toast(`Restored “${x.title}”`, 'ok'); viewTrash(main); }
    if (p && confirm('Delete this note forever? This can’t be undone.')) { await api('DELETE', `/api/trash/${p}`); viewTrash(main); }
    if (e.target.id === 'emptyTrash' && confirm('Delete everything in the trash forever?')) { await api('DELETE', '/api/trash'); viewTrash(main); }
  };
  current = { name: 'trash', teardown: () => { main.onclick = null; } };
}

// ------------------------------------------------------------------ home dashboard
async function viewHome(main) {
  setTitle('Home');
  const now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const hour = now.getHours();
  main.innerHTML = `<div class="page home">
    <h1>${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${esc(state.me.name)}</h1>
    <p class="muted">${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
    <div class="quick"><button class="btn" data-q="note">＋ Note</button><button class="btn" data-q="event">＋ Event</button><a class="btn" href="#/daily">📓 Today's note</a>${state.supertags.slice(0, 4).map((s) => `<button class="btn" data-q="st" data-st="${esc(s.name)}">${esc(s.icon)} New ${esc(s.name)}</button>`).join('')}</div>
    <div class="grid">
      <section class="panel span2"><h3>Our next 7 days <a href="#/calendar">Calendar →</a></h3><div id="hAgenda" class="muted">Loading…</div></section>
      <section class="panel"><h3>Tasks <a href="#/tasks">All →</a></h3><div id="hTasks" class="muted">Loading…</div></section>
      <section class="panel"><h3>Study <a href="#/review">Review →</a></h3><div id="hStudy" class="muted">Loading…</div></section>
      <section class="panel"><h3>Homelab <a href="#/db/service">Services →</a></h3><div id="hLab" class="muted">Loading…</div></section>
      <section class="panel"><h3>Recently edited</h3>${state.notes.slice(0, 8).map((n) => `<a class="rlink" href="#/note/${n.id}">${esc(n.icon || '📄')} ${esc(n.title)}<span class="muted">${ago(n.updated)}</span></a>`).join('') || '<p class="muted">No notes yet.</p>'}</section>
    </div></div>`;
  main.querySelector('.quick').onclick = (e) => {
    const b = e.target.closest('[data-q]'); if (!b) return;
    if (b.dataset.q === 'note') newNote({ folder: '' });
    if (b.dataset.q === 'event') openEventModal(app, { date: today() });
    if (b.dataset.q === 'st') newNote({ supertag: b.dataset.st, title: `New ${b.dataset.st}` });
  };
  const fill = async () => {
    const items = await loadItems(app, start, new Date(+start + 7 * 864e5)).catch(() => []);
    const byDay = new Map();
    for (const it of items) { const k = dstr(it.start < start ? start : it.start); (byDay.get(k) || byDay.set(k, []).get(k)).push(it); }
    $('#hAgenda') && ($('#hAgenda').className = '', $('#hAgenda').innerHTML = byDay.size ? [...byDay].sort().map(([d, its]) => `<div class="hday"><div class="hdl">${d === today() ? 'Today' : new Date(d + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div><div>${its.map((it) => `<div class="mini${it.conflict ? ' conflict' : ''}" style="--c:${it.color}" ${it.kind === 'event' ? `data-ev="${it.id}"` : `data-note="${it.raw.note_id}"`}>${it.allDay ? '' : `<b>${it.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b> `}${it.kind === 'task' ? (it.done ? '☑ ' : '☐ ') : ''}${esc(it.title)}${it.conflict ? ' ⚠' : ''} ${it.people.length ? it.people.map((p) => app.userById(p)).filter(Boolean).map((u) => `<span class="who" style="--c:${u.color}">${esc(u.name)}</span>`).join('') : '<span class="who" style="--c:#f59e0b">Everyone</span>'}</div>`).join('')}</div></div>`).join('') : '<p class="muted">Nothing on the calendar this week. 🎉</p>');
    if ($('#hAgenda')) $('#hAgenda').onclick = (e) => { const t = e.target.closest('[data-ev],[data-note]'); if (!t) return; if (t.dataset.note) return app.go(`/note/${t.dataset.note}`); const it = items.find((i) => i.kind === 'event' && i.id === +t.dataset.ev); it && openEventModal(app, { item: it }); };
  };
  fill();
  const fillRest = async () => {
    const [tasks, stats, svc, certs] = await Promise.all([api('GET', '/api/tasks'), api('GET', '/api/cards/stats'), api('GET', '/api/db/service'), api('GET', '/api/db/cert')]);
    state.due = stats.due || 0;
    const soon = dstr(new Date(Date.now() + 7 * 864e5));
    const tl = tasks.filter((t) => t.due && t.due <= soon).slice(0, 8);
    $('#hTasks') && ($('#hTasks').className = '', $('#hTasks').innerHTML = tl.length ? tl.map((t) => `<label class="trow"><input type="checkbox" data-n="${t.note_id}" data-l="${t.line}"> <span>${inline(t.text, mdctx())}</span><span class="due${t.due < today() ? ' over' : t.due === today() ? ' today' : ''}">${t.due}</span></label>`).join('') : `<p class="muted">Nothing due this week. ${tasks.length} open task${tasks.length === 1 ? '' : 's'} total.</p>`);
    const certRows = certs.rows.filter((r) => r.fields['exam date'] || r.fields.status);
    $('#hStudy') && ($('#hStudy').className = '', $('#hStudy').innerHTML = `<div class="stat"><b>${stats.due || 0}</b> cards due <a class="btn sm primary" href="#/review?go=1">Start</a></div>` + certRows.map((r) => {
      const d = r.fields['exam date'], days = d ? Math.ceil((new Date(d + 'T00:00') - start) / 864e5) : null;
      return `<a class="rlink" href="#/note/${r.id}">🎓 ${esc(r.title)}<span class="muted">${esc(r.fields.status || '')}${days !== null ? ` · ${days >= 0 ? `exam in ${days}d` : 'exam passed'}` : ''}</span></a>`;
    }).join(''));
    const ur = await api('GET', '/api/unraid').catch(() => null);
    const tb = (kb) => `${(kb / 1024 ** 3).toFixed(1)} TB`;
    const unraidHtml = ur?.configured ? (ur.status ? `<div class="unraid"><div class="urow"><b>🖥️ Unraid</b><span class="muted">${esc((ur.status.state || '?').toLowerCase())}${ur.status.capacity ? ` · ${tb(ur.status.capacity.free)} free of ${tb(ur.status.capacity.total)}` : ''}</span></div>
      ${ur.status.capacity ? `<div class="ubar"><i style="width:${Math.round(ur.status.capacity.used / ur.status.capacity.total * 100)}%"></i></div>` : ''}
      <div class="udisks">${ur.status.disks.map((d) => `<span class="udisk${d.status && !/DISK_OK|DISK_NP/.test(d.status) ? ' bad' : d.temp >= 50 ? ' hot' : ''}" title="${esc(d.kind)} · ${esc(d.status || '')}">${esc(d.name)} <small>${d.temp != null ? d.temp + '°' : 'zz'}</small></span>`).join('')}</div>
      ${ur.status.containers ? `<div class="muted small">🐳 ${ur.status.containers.filter((c) => c.state === 'RUNNING').length}/${ur.status.containers.length} containers running</div>` : ''}
      ${ur.problems.length ? `<div class="err small">⚠ ${ur.problems.map((p) => esc(p.text)).join(' · ')}</div>` : ''}</div>` : '<p class="muted small">🖥️ Unraid: waiting for first status…</p>') : '';
    $('#hLab') && ($('#hLab').className = '', $('#hLab').innerHTML = unraidHtml + (svc.rows.length ? svc.rows.map((r) => `<a class="rlink" href="#/note/${r.id}"><span class="hdot ${r.health ? (r.health.ok ? 'up' : 'down') : ''}"></span>${esc(r.title)}<span class="muted">${r.health ? (r.health.ok ? `${r.health.ms} ms` : esc(r.health.error || `HTTP ${r.health.status}`)) : esc(r.fields.host || '')}</span></a>`).join('') : '<p class="muted">Tag a note #service with a <code>url::</code> to monitor it.</p>'));
    if ($('#hTasks')) $('#hTasks').onchange = async (e) => { const c = e.target; await api('POST', `/api/notes/${c.dataset.n}/task`, { line: +c.dataset.l, done: c.checked }); toast(c.checked ? 'Task completed' : 'Task reopened'); };
  };
  fillRest().catch(() => {});
  const onEv = () => fill(); on('events', onEv); const onSvc = () => fillRest().catch(() => {}); on('services', onSvc);
  current = { name: 'home', teardown: () => { listeners.events.delete(onEv); listeners.services.delete(onSvc); } };
}

// ------------------------------------------------------------------ calendar
async function viewCalendar(main) {
  setTitle('Calendar');
  main.className = 'calmain';
  main.innerHTML = '<div class="cal"></div>';
  const c = await mountCalendar($('.cal', main), app);
  const onEv = () => c.refresh(); on('events', onEv);
  current = { name: 'calendar', teardown: () => listeners.events.delete(onEv) };
}

// ------------------------------------------------------------------ databases (supertag views)
async function viewDb(main, tag) {
  const data = await api('GET', `/api/db/${encodeURIComponent(tag)}`);
  const st = data.supertag;
  setTitle(`#${tag}`);
  const cfgKey = `db.${tag}`;
  const cfg = LS.get(cfgKey, { view: 'table', sort: 'title', dir: 1, filter: '', group: '' });
  const schemaFields = st?.fields || [];
  const cols = [...schemaFields, ...data.keys.filter((k) => !schemaFields.some((f) => f.name.toLowerCase() === k)).map((k) => ({ name: k, type: 'text' }))];
  const selects = cols.filter((f) => f.type === 'select');
  if (!cfg.group && selects.length) cfg.group = selects[0].name;
  const isService = tag === 'service';

  const draw = () => {
    LS.set(cfgKey, cfg);
    const fq = cfg.filter.toLowerCase();
    let rows = data.rows.filter((r) => !fq || r.title.toLowerCase().includes(fq) || Object.values(r.fields).some((v) => v.toLowerCase().includes(fq)));
    const val = (r, k) => (k === 'title' ? r.title : k === 'updated' ? r.updated : r.fields[k.toLowerCase()] ?? '');
    rows.sort((a, b) => { const x = val(a, cfg.sort), y = val(b, cfg.sort); const nx = +x, ny = +y; return (x === '' ? 1 : y === '' ? -1 : !isNaN(nx) && !isNaN(ny) && x !== '' ? nx - ny : String(x).localeCompare(String(y))) * cfg.dir; });
    let body;
    if (cfg.view === 'board' && cfg.group) {
      const gf = cols.find((c) => c.name === cfg.group) || { options: [] };
      const groups = [...(gf.options || []), ...new Set(rows.map((r) => r.fields[cfg.group.toLowerCase()]).filter((v) => v && !(gf.options || []).includes(v))), ''];
      body = `<div class="board">${groups.map((g) => { const its = rows.filter((r) => (r.fields[cfg.group.toLowerCase()] || '') === g);
        return `<div class="bcol" data-g="${esc(g)}"><div class="bh">${esc(g || 'No ' + cfg.group)} <span class="cnt">${its.length}</span></div>${its.map((r) => `<a class="bcard" draggable="true" data-id="${r.id}" href="#/note/${r.id}"><b>${esc(r.icon || '')} ${esc(r.title)}</b>${cols.filter((c) => c.name !== cfg.group && r.fields[c.name.toLowerCase()]).slice(0, 3).map((c) => `<span><em>${esc(c.name)}</em> ${esc(r.fields[c.name.toLowerCase()])}</span>`).join('')}</a>`).join('')}</div>`; }).join('')}</div>`;
    } else {
      const th = (k, label) => `<th data-sort="${esc(k)}" class="${cfg.sort === k ? 'sorted' : ''}">${esc(label)}${cfg.sort === k ? (cfg.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
      body = `<div class="tablewrap dbt"><table><thead><tr>${isService ? '<th></th>' : ''}${th('title', 'Name')}${cols.map((c) => th(c.name, c.name)).join('')}${th('updated', 'Updated')}</tr></thead><tbody>
        ${rows.map((r) => `<tr data-id="${r.id}">${isService ? `<td><span class="hdot ${r.health ? (r.health.ok ? 'up' : 'down') : ''}" title="${r.health ? esc(r.health.ok ? `${r.health.status} · ${r.health.ms} ms` : r.health.error || r.health.status) : 'Not checked'}"></span></td>` : ''}<td class="tname"><a href="#/note/${r.id}">${esc(r.icon || '📄')} ${esc(r.title)}</a></td>
          ${cols.map((c) => { const v = r.fields[c.name.toLowerCase()] ?? ''; return `<td class="cell" data-k="${esc(c.name)}">${c.type === 'url' && v ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v.replace(/^https?:\/\//, ''))}</a>` : c.type === 'select' && v ? `<span class="opt" style="--c:${hashColor(v)}">${esc(v)}</span>` : inline(v, mdctx())}</td>`; }).join('')}
          <td class="muted">${ago(r.updated)}</td></tr>`).join('')}
        <tr class="addrow"><td colspan="${cols.length + 2 + (isService ? 1 : 0)}"><button class="linkbtn" data-a="new">＋ New ${esc(tag)}</button></td></tr></tbody></table></div>`;
    }
    main.innerHTML = `<div class="page wide"><div class="dbhead" style="--tc:${st?.color || '#64748b'}"><h1><span>${esc(st?.icon || '#')}</span> ${esc(tag)}</h1><span class="muted">${data.rows.length} item${data.rows.length === 1 ? '' : 's'}</span><span class="sp"></span>
      <input class="filter" placeholder="Filter…" value="${esc(cfg.filter)}">
      <div class="seg"><button data-view="table" class="${cfg.view === 'table' ? 'on' : ''}">Table</button><button data-view="board" class="${cfg.view === 'board' ? 'on' : ''}" ${selects.length ? '' : 'disabled title="Add a select field to use the board"'}>Board</button></div>
      ${cfg.view === 'board' && selects.length > 1 ? `<select class="groupsel">${selects.map((s) => `<option ${s.name === cfg.group ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : ''}
      ${isService ? '<button class="btn" data-a="check">⟳ Check now</button>' : ''}
      <button class="btn" data-a="schema">${st ? '⚙ Fields' : '⚙ Make supertag'}</button><button class="btn primary" data-a="new">＋ New</button></div>${body}</div>`;
    const fi = $('.filter', main); fi.oninput = debounce(() => { cfg.filter = fi.value; draw(); const f2 = $('.filter', main); f2.focus(); f2.setSelectionRange(f2.value.length, f2.value.length); }, 150);
    $('.groupsel', main)?.addEventListener('change', (e) => { cfg.group = e.target.value; draw(); });
  };
  main.onclick = async (e) => {
    const t = e.target;
    const s = t.closest('[data-sort]'); if (s) { cfg.dir = cfg.sort === s.dataset.sort ? -cfg.dir : 1; cfg.sort = s.dataset.sort; return draw(); }
    const v = t.closest('[data-view]'); if (v && !v.disabled) { cfg.view = v.dataset.view; return draw(); }
    const a = t.closest('[data-a]')?.dataset.a;
    if (a === 'new') return newNote({ supertag: tag, title: `New ${tag}`, folder: st?.folder || undefined });
    if (a === 'schema') return editSupertag(st || { name: tag, color: '#8b5cf6', icon: '', fields: cols, template: '', folder: '' });
    if (a === 'check') { toast('Checking services…'); const h = await api('POST', '/api/services/check'); for (const r of data.rows) r.health = h[r.id] || null; return draw(); }
    const cell = t.closest('td.cell');
    if (cell && !t.closest('a') && !cell.querySelector('input,select')) {
      const id = +cell.parentElement.dataset.id, k = cell.dataset.k, row = data.rows.find((r) => r.id === id);
      const f = cols.find((c) => c.name === k) || { type: 'text' };
      cell.innerHTML = fieldInput(f, row.fields[k.toLowerCase()] ?? '', 'class="cellin"');
      const inp = cell.firstElementChild; inp.focus();
      let done = false;
      const commit = async () => {
        if (done) return; done = true;
        const nv = inp.value.trim();
        if (nv !== (row.fields[k.toLowerCase()] ?? '')) {
          try { await api('POST', `/api/notes/${id}/field`, { key: k, value: nv }); row.fields[k.toLowerCase()] = nv; if (!nv) delete row.fields[k.toLowerCase()]; row.updated = Date.now(); }
          catch (err) { toast(err.message, 'error'); }
        }
        draw();
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('change', () => f.type === 'select' && commit());
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') { done = true; draw(); } });
    }
  };
  main.ondragstart = (e) => { const c = e.target.closest('.bcard'); if (c) e.dataTransfer.setData('text/nexus-row', c.dataset.id); };
  main.ondragover = (e) => { const c = e.target.closest('.bcol'); if (c) { e.preventDefault(); c.classList.add('drop'); } };
  main.ondragleave = (e) => e.target.closest('.bcol')?.classList.remove('drop');
  main.ondrop = async (e) => {
    const c = e.target.closest('.bcol'); if (!c) return;
    e.preventDefault();
    const id = +e.dataTransfer.getData('text/nexus-row'), row = data.rows.find((r) => r.id === id);
    if (!row) return;
    await api('POST', `/api/notes/${id}/field`, { key: cfg.group, value: c.dataset.g });
    if (c.dataset.g) row.fields[cfg.group.toLowerCase()] = c.dataset.g; else delete row.fields[cfg.group.toLowerCase()];
    draw();
  };
  draw();
  const reload = debounce(async () => { const d = await api('GET', `/api/db/${encodeURIComponent(tag)}`); data.rows = d.rows; data.keys = d.keys; if (!$('.cellin', main)) draw(); }, 400);
  on('remote-note', reload); on('services', reload);
  current = { name: 'db', teardown: () => { listeners['remote-note'].delete(reload); listeners.services.delete(reload); main.onclick = main.ondrop = main.ondragover = main.ondragstart = main.ondragleave = null; } };
}

function editSupertag(st) {
  const isNew = !st;
  st = st || { name: '', color: '#8b5cf6', icon: '🏷️', fields: [], template: '', folder: '' };
  const types = ['text', 'select', 'date', 'number', 'url'];
  const row = (f = { name: '', type: 'text', options: [] }) => `<div class="frowed"><input class="fname" placeholder="Field name" value="${esc(f.name)}"><select class="ftype">${types.map((t) => `<option ${t === f.type ? 'selected' : ''}>${t}</option>`).join('')}</select><input class="fopts" placeholder="Options (comma separated)" value="${esc((f.options || []).join(', '))}" ${f.type === 'select' ? '' : 'hidden'}><button type="button" class="iconbtn sm" data-rm>✕</button></div>`;
  modal(isNew ? 'New supertag' : `Supertag #${st.name}`, `<form class="stform">
    <div class="row"><input name="icon" value="${esc(st.icon)}" class="iconin" maxlength="4"><input name="name" value="${esc(st.name)}" placeholder="name (e.g. book)" ${isNew ? '' : 'readonly'} required><input name="color" type="color" value="${esc(st.color)}"></div>
    <label class="lbl">Fields <small class="muted">— become database columns and are stored in the note as <code>field:: value</code></small></label>
    <div id="frows">${st.fields.map(row).join('')}</div><button type="button" class="linkbtn" id="addF">＋ Add field</button>
    <label class="lbl">Default folder for new items</label><input name="folder" value="${esc(st.folder || '')}" placeholder="e.g. Certifications">
    <label class="lbl">Template (inserted when you create a new #${esc(st.name || 'item')})</label><textarea name="template" rows="7">${esc(st.template)}</textarea>
    <div class="actions">${isNew ? '' : '<button type="button" class="btn danger" id="delSt">Delete supertag</button>'}<span class="sp"></span><button class="btn primary">Save</button></div></form>`, (box, close) => {
    const f = $('form', box);
    $('#addF', box).onclick = () => $('#frows', box).insertAdjacentHTML('beforeend', row());
    box.addEventListener('click', (e) => { if (e.target.dataset.rm !== undefined) e.target.parentElement.remove(); });
    box.addEventListener('change', (e) => { if (e.target.classList.contains('ftype')) e.target.parentElement.querySelector('.fopts').hidden = e.target.value !== 'select'; });
    $('#delSt', box)?.addEventListener('click', async () => { if (!confirm(`Delete supertag #${st.name}? Notes keep their tag and fields.`)) return; await api('DELETE', `/api/supertags/${encodeURIComponent(st.name)}`); await loadMeta(); renderSidebar(); close(); route(); });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fields = [...box.querySelectorAll('.frowed')].map((r) => ({ name: $('.fname', r).value.trim(), type: $('.ftype', r).value, options: $('.fopts', r).value.split(',').map((x) => x.trim()).filter(Boolean) })).filter((x) => x.name);
      const name = f.name.value.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
      let template = f.template.value;
      if (isNew && !template.trim()) template = fields.map((x) => `${x.name}:: `).join('\n') + '\n\n';
      await api('PUT', `/api/supertags/${encodeURIComponent(name)}`, { color: f.color.value, icon: f.icon.value, fields, template, folder: f.folder.value.trim() });
      await loadMeta(); renderSidebar(); close();
      if (isNew) app.go(`/db/${encodeURIComponent(name)}`); else route();
    };
  }, 'wide');
}

async function viewTags(main) {
  setTitle('Tags');
  const tags = await api('GET', '/api/tags');
  state.tagCounts = tags;
  main.innerHTML = `<div class="page"><h1>Tags</h1><p class="muted">Every tag is a live database. Supertags add typed fields and templates.</p>
    <div class="taglist">${tags.map((t) => { const s = stByName(t.tag); return `<a class="tagcard${s ? ' super' : ''}" href="#/db/${encodeURIComponent(t.tag)}" style="--tc:${s?.color || hashColor(t.tag)}"><b>${esc(s?.icon || '#')} ${esc(t.tag)}</b><span>${t.count}</span></a>`; }).join('') || '<p class="muted">No tags yet. Add #tags anywhere in a note.</p>'}</div></div>`;
}

// ------------------------------------------------------------------ tasks
async function viewTasks(main) {
  setTitle('Tasks');
  let showDone = false;
  const draw = async () => {
    const tasks = await api('GET', `/api/tasks${showDone ? '?all=1' : ''}`);
    const t0 = today(), week = dstr(new Date(Date.now() + 7 * 864e5));
    const groups = [['Overdue', (t) => t.due && t.due < t0 && !t.done], ['Today', (t) => t.due === t0], ['Next 7 days', (t) => t.due > t0 && t.due <= week], ['Later', (t) => t.due > week], ['No date', (t) => !t.due], ...(showDone ? [['Done (overdue)', (t) => t.done && t.due && t.due < t0]] : [])];
    main.innerHTML = `<div class="page"><div class="dbhead"><h1>Tasks</h1><span class="sp"></span><label><input type="checkbox" id="showDone" ${showDone ? 'checked' : ''}> Show completed</label></div>
      <p class="muted">Collected from every note. Add <code>@YYYY-MM-DD</code> to a task to put it on the calendar.</p>
      ${groups.map(([name, fn]) => { const its = tasks.filter(fn); return its.length ? `<h3>${name} <span class="cnt">${its.length}</span></h3>${its.map((t) => `<div class="trow${t.done ? ' done' : ''}"><input type="checkbox" data-n="${t.note_id}" data-l="${t.line}" ${t.done ? 'checked' : ''}><span>${inline(t.text, mdctx())}</span><a href="#/note/${t.note_id}" class="muted">${esc(t.icon || '📄')} ${esc(t.note_title)}</a>${t.due ? `<span class="due${t.due < t0 ? ' over' : t.due === t0 ? ' today' : ''}">${t.due}${t.time ? ' ' + t.time : ''}</span>` : ''}</div>`).join('')}` : ''; }).join('') || '<div class="empty-state">No open tasks. Write <code>- [ ] something</code> in any note.</div>'}</div>`;
    $('#showDone').onchange = (e) => { showDone = e.target.checked; draw(); };
  };
  main.onchange = async (e) => {
    const c = e.target; if (!c.dataset.n) return;
    await api('POST', `/api/notes/${c.dataset.n}/task`, { line: +c.dataset.l, done: c.checked });
    c.closest('.trow').classList.toggle('done', c.checked);
  };
  await draw();
  current = { name: 'tasks', teardown: () => { main.onchange = null; } };
}

// ------------------------------------------------------------------ flashcard review
async function viewReview(main, params) {
  setTitle('Review');
  if (params.get('note') || params.get('go') || params.get('scope')) return studySession(main, params);
  const [s, hist] = await Promise.all([api('GET', '/api/cards/stats'), api('GET', '/api/cards/history')]);
  state.due = s.due || 0;
  main.innerHTML = `<div class="page"><h1>Review</h1><p class="muted">Spaced repetition for everything you're studying. Cards come from <code>Question ?? Answer</code> lines and <code>Q:</code>/<code>A:</code> pairs in any note.</p>
    <div class="tiles"><div class="tile"><b>${hist.streak ? '🔥 ' + hist.streak : 0}</b><span>day streak</span></div><div class="tile"><b>${hist.week}</b><span>reviewed this week</span></div><div class="tile"><b>${hist.retention == null ? '–' : hist.retention + '%'}</b><span>recalled (30 days)</span></div><div class="tile"><b>${s.due || 0}</b><span>due now</span></div></div>
    ${studyChart(hist.days)}
    <div class="tiles"><div class="tile"><b>${s.new || 0}</b><span>new</span></div><div class="tile"><b>${s.mature || 0}</b><span>mature</span></div><div class="tile"><b>${s.total || 0}</b><span>total</span></div></div>
    ${s.due ? '<a class="btn primary big" href="#/review?go=1">Study all due cards</a>' : '<p>🎉 Nothing due. Come back later, or cram a deck below.</p>'}
    <h3>Decks</h3><div class="decks">${s.decks.map((d) => `<div class="deck"><a href="#/note/${d.id}">${esc(d.icon || '📄')} ${esc(d.title)}</a><span class="muted">${d.due || 0} due · ${d.total} cards</span><a class="btn sm" href="#/review?note=${d.id}">${d.due ? 'Study' : 'Cram'}</a></div>`).join('') || '<p class="muted">No flashcards yet.</p>'}</div></div>`;
}
// 30-day review history: one series, columns (<=24px, 4px rounded tops, square at the baseline), recessive axis,
// only the peak labelled, hover/focus tooltip, and a table view.
function studyChart(days) {
  const max = Math.max(...days.map((d) => d.count));
  if (!max) return '<p class="muted small">Your daily review chart appears here once you start studying.</p>';
  const W = 600, H = 150, top = 18, base = H - 22, n = days.length, slot = W / n, bw = Math.min(24, slot * 0.62); // capped column width; the rest of the slot is air
  const yMax = Math.max(4, Math.ceil(max / 4) * 4), y = (v) => base - (v / yMax) * (base - top);
  const fmt = (d) => new Date(d + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
  const peak = days.reduce((a, b) => (b.count >= a.count ? b : a));
  const bars = days.map((d, i) => {
    const x = i * slot + (slot - bw) / 2, h = base - y(d.count), r = Math.min(4, h);
    const path = d.count ? `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + bw - r} Q${x + bw},${base - h} ${x + bw},${base - h + r} V${base} Z` : '';
    return `<g class="sbar" tabindex="0" data-tip="${fmt(d.date)}: ${d.count} card${d.count === 1 ? '' : 's'}" aria-label="${fmt(d.date)}: ${d.count} cards reviewed">
      <rect x="${i * slot}" y="${top}" width="${slot}" height="${base - top}" fill="transparent"/>${path ? `<path d="${path}"/>` : ''}
      ${d === peak ? `<text x="${x + bw / 2}" y="${y(d.count) - 5}" text-anchor="middle" class="sval">${d.count}</text>` : ''}</g>`;
  }).join('');
  const ticks = [0, yMax / 2, yMax].map((v) => `<line x1="0" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="sgrid"/><text x="0" y="${y(v) - 3}" class="saxis">${v}</text>`).join('');
  const labels = [0, Math.floor(n / 2), n - 1].map((i) => `<text x="${i * slot + slot / 2}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" class="saxis">${i === n - 1 ? 'Today' : fmt(days[i].date)}</text>`).join('');
  return `<figure class="schart"><figcaption>Cards reviewed per day · last 30 days</figcaption>
    <div class="swrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cards reviewed per day over the last 30 days, peak ${peak.count} on ${fmt(peak.date)}">${ticks}${bars}${labels}</svg><div class="stip" hidden></div></div>
    <details><summary class="small muted">Show as table</summary><table class="stable"><thead><tr><th>Day</th><th>Cards reviewed</th></tr></thead><tbody>${days.slice().reverse().map((d) => `<tr><td>${fmt(d.date)}</td><td>${d.count}</td></tr>`).join('')}</tbody></table></details></figure>`;
}
document.addEventListener('pointerover', (e) => chartTip(e.target.closest?.('.sbar')));
document.addEventListener('focusin', (e) => chartTip(e.target.closest?.('.sbar')));
document.addEventListener('pointerout', (e) => { if (e.target.closest?.('.sbar')) chartTip(null); });
function chartTip(g) {
  document.querySelectorAll('.sbar.on').forEach((x) => x.classList.remove('on'));
  const wrap = g?.closest('.swrap') || document.querySelector('.swrap'); const tip = wrap?.querySelector('.stip');
  if (!tip) return;
  if (!g) { tip.hidden = true; return; }
  g.classList.add('on');
  const r = g.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  tip.textContent = g.dataset.tip; tip.hidden = false;
  tip.style.left = Math.max(0, Math.min(wr.width - tip.offsetWidth, r.left - wr.left + r.width / 2 - tip.offsetWidth / 2)) + 'px';
}

async function studySession(main, params) {
  const cards = params.get('note') ? await api('GET', `/api/cards/due?note=${params.get('note')}`) : await api('GET', `/api/cards/due${params.get('scope') ? `?scope=${encodeURIComponent(params.get('scope'))}` : ''}`);
  let i = 0, shown = false, done = 0;
  const ivl = (days) => (days < 1 ? `${Math.round(days * 1440)}m` : days < 30 ? `${Math.round(days)}d` : days < 365 ? `${Math.round(days / 30)}mo` : `${(days / 365).toFixed(1)}y`);
  const preview = (c, g) => { if (g === 0) return '10m'; const r = c.reps + 1; return ivl(r === 1 ? (g === 3 ? 3 : 1) : r === 2 ? (g === 1 ? 3 : g === 3 ? 8 : 6) : c.interval * (g === 1 ? 1.2 : g === 3 ? c.ease * 1.3 : c.ease)); };
  const draw = () => {
    if (i >= cards.length) { main.innerHTML = `<div class="page center"><h1>Session complete</h1><p>You reviewed ${done} card${done === 1 ? '' : 's'}. 🎉</p><a class="btn primary" href="#/review">Back to decks</a></div>`; return; }
    const c = cards[i];
    main.innerHTML = `<div class="page study"><div class="progress"><i style="width:${i / cards.length * 100}%"></i></div><p class="muted">${i + 1} / ${cards.length} · <a href="#/note/${c.note_id}">${esc(c.title)}</a></p>
      <div class="flash"><div class="front">${inline(c.front, mdctx())}</div>${shown ? `<hr><div class="back">${inline(c.back, mdctx())}</div>` : ''}</div>
      ${shown ? `<div class="grades">${['Again', 'Hard', 'Good', 'Easy'].map((g, k) => `<button class="btn g${k}" data-g="${k}">${g}<small>${preview(c, k)}</small></button>`).join('')}</div><p class="muted center">Keys 1–4</p>` : '<button class="btn primary big" data-show>Show answer <small>(Space)</small></button>'}</div>`;
  };
  const grade = async (g) => { const c = cards[i]; await api('POST', `/api/cards/${c.id}/review`, { grade: g }); if (g === 0 && !params.get('note')) cards.push(c); i++; done++; shown = false; draw(); };
  main.onclick = (e) => { if (e.target.closest('[data-show]')) { shown = true; draw(); } const g = e.target.closest('[data-g]'); if (g) grade(+g.dataset.g); };
  const key = (e) => { if (e.target.matches('input,textarea')) return; if (e.key === ' ' && !shown) { e.preventDefault(); shown = true; draw(); } else if (shown && /^[1-4]$/.test(e.key)) grade(+e.key - 1); };
  document.addEventListener('keydown', key);
  if (!cards.length) { main.innerHTML = '<div class="page center"><h1>No cards due</h1><a class="btn" href="#/review">Back</a></div>'; }
  else draw();
  current = { name: 'review', teardown: () => { document.removeEventListener('keydown', key); main.onclick = null; api('GET', '/api/cards/stats').then((s) => { state.due = s.due || 0; renderSidebar(); }); } };
}

// ------------------------------------------------------------------ graph
async function viewGraph(main) {
  setTitle('Graph');
  main.className = 'graphmain';
  main.innerHTML = '<div class="graphwrap"><canvas id="graph"></canvas><div class="graphhint muted">Scroll to zoom · drag to pan · click a note to open</div></div>';
  const [{ mountGraph }, data] = await Promise.all([import('./graph.js'), api('GET', '/api/graph')]);
  const g = mountGraph($('#graph'), data, { onOpen: (n) => app.go(`/note/${n.id}`), colorFor: (n) => (n.tag ? stByName(n.tag)?.color || hashColor(n.tag) : '#94a3b8') });
  current = { name: 'graph', teardown: () => g.destroy() };
}

// ------------------------------------------------------------------ settings
async function viewSettings(main, params) {
  setTitle('Settings');
  if (params.get('connected')) toast(`${params.get('connected') === 'google' ? 'Google' : 'Outlook'} calendar connected`, 'ok');
  if (params.get('error')) toast(params.get('error'), 'error');
  if (params.toString()) history.replaceState(null, '', '#/settings');
  await loadMeta();
  const me = state.me;
  const feed = `${location.origin}/ics/${me.ics_token}.ics`;
  const settings = await api('GET', '/api/settings');
  const integ = state.integrations;
  const calRow = (c) => `<div class="calrow" data-id="${c.id}"><span class="cdot" style="background:${c.color}"></span><div class="cinfo"><b>${esc(c.name)}</b><span class="muted">${{ local: 'Nexus calendar', ics: 'ICS subscription (read-only)', google: 'Google Calendar · two-way', outlook: 'Outlook · two-way' }[c.kind]}${c.account ? ` · ${esc(c.account)}` : ''}${c.owner ? ` · ${esc(c.owner)}` : ' · Household'}${c.last_sync ? ` · synced ${ago(c.last_sync)}` : ''}</span>${c.sync_error ? `<span class="err">${esc(c.sync_error)}</span>` : ''}</div>
    ${c.mine || c.user_id === null ? `<input type="color" value="${c.color}" data-color title="Color">` : ''}
    ${c.mine && c.kind !== 'local' ? '<button class="btn sm" data-sync>Sync</button>' : ''}
    ${c.mine && (c.kind === 'google' || c.kind === 'outlook') ? '<button class="btn sm" data-pick>Choose calendar</button>' : ''}
    ${c.mine && c.kind === 'outlook' ? `<button class="btn sm" data-mail>📧 Email → calendar${c.mailWatch?.enabled ? ' ✓' : ''}</button>` : ''}
    ${c.mine ? `<label class="sm"><input type="checkbox" data-shared ${c.shared ? 'checked' : ''}> Visible to household</label>` : ''}
    ${c.mine || (c.user_id === null && c.kind !== 'local') ? '<button class="iconbtn sm" data-del title="Remove">🗑</button>' : ''}</div>`;
  main.innerHTML = `<div class="page settings"><h1>Settings</h1>
  <section class="panel"><h3>Calendars</h3>
    <div id="cals">${state.calendars.map(calRow).join('')}</div>
    <div class="connect">
      <a class="btn ${integ.google?.configured ? 'primary' : 'disabled'}" ${integ.google?.configured ? 'href="/api/oauth/google/start"' : ''}>Connect Google Calendar</a>
      <a class="btn ${integ.outlook?.configured ? 'primary' : 'disabled'}" ${integ.outlook?.configured ? 'href="/api/oauth/outlook/start"' : ''}>Connect Outlook / Microsoft 365</a>
      <button class="btn" id="addIcs">Subscribe to ICS URL</button><button class="btn" id="addLocal">New shared calendar</button>
    </div>
    ${!integ.google?.configured || !integ.outlook?.configured ? `<p class="muted small">Two-way Google/Outlook sync needs OAuth credentials on the server (see README → <i>Calendar integrations</i>). Until then, use <b>Subscribe to ICS URL</b> with your Google “secret address in iCal format” or Outlook “published calendar” ICS link — read-only, but zero setup.</p>` : ''}
  </section>
  <section class="panel"><h3>Household feed</h3><p class="muted">Subscribe to this URL in Google Calendar (“From URL”), Outlook (“Subscribe from web”), or your iPhone (Settings → Calendar → Accounts → Add Subscribed Calendar) so everything shows on your phone. Your own Google/Outlook events are left out to avoid duplicates.</p>
    <div class="copyrow"><input readonly value="${esc(feed)}" id="feed"><button class="btn" id="copyFeed">Copy</button><a class="btn" href="${esc(feed.replace(/^https?:/, 'webcal:'))}">Open in calendar app</a><button class="btn" id="rotate" title="Invalidate the old link">New link</button></div></section>
  <section class="panel" id="phone"><h3>Phone &amp; Claude app</h3>
    <p><b>Claude app connector.</b> Add Nexus to your Claude app so you can say or type <i>"save this to Nexus: …"</i> or <i>"add a task to call the vet Friday"</i> from your phone. Thoughts land in today's note under <b>Inbox</b>; tasks with dates show up on the calendar.</p>
    <ol class="small"><li>On <b>claude.ai</b> (web or desktop): <b>Settings → Connectors → Add custom connector</b>.</li>
      <li>Name it <b>Nexus</b> and paste this URL:</li></ol>
    <div class="copyrow"><input readonly value="${esc(state.publicUrl || location.origin)}/mcp" id="mcpUrl"><button class="btn" id="copyMcp">Copy</button></div>
    <ol class="small" start="3"><li>Click <b>Connect</b>, sign in to Nexus and click <b>Allow</b>. The connector then works in the Claude app on your phone too.</li></ol>
    <div id="apps" class="small muted">Loading…</div>
    <p style="margin-top:18px"><b>Siri / Shortcuts quick capture</b> (no AI): dictate a thought and it goes straight into today's Inbox. Starting with "remind me to…" or "todo…" makes it a task.</p>
    <div class="row wrap"><button class="btn" id="newPat">Create capture token</button></div>
    <div id="pats" class="small"></div>
  </section>
  <section class="panel"><h3>Household members</h3>${state.users.map((u) => `<div class="calrow"><span class="avatar" style="background:${u.color}">${esc(u.name[0])}</span><b>${esc(u.name)}</b>${u.id === me.id ? '<span class="muted">(you)</span>' : ''}</div>`).join('')}
    <form id="addUser" class="row wrap"><input name="name" placeholder="Name" required><input name="email" type="email" placeholder="Email" required><input name="password" type="password" placeholder="Temporary password (8+)" minlength="8" required><button class="btn primary">Add member</button></form></section>
  <section class="panel" id="notif"><h3>Notifications</h3><div id="notifBody" class="muted small">Loading…</div></section>
  <section class="panel" id="security"><h3>Two-step sign-in</h3>
    ${state.security?.totp
      ? `<p>✅ <b>On.</b> Signing in needs your password and a code from your authenticator app. ${state.security.recoveryLeft} recovery code${state.security.recoveryLeft === 1 ? '' : 's'} left.</p>
         <div class="row wrap"><button class="btn" id="newRecovery">New recovery codes</button><button class="btn danger" id="disable2fa">Turn off</button></div>`
      : `<p>Protect your account with a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, Authy…) in addition to your password. Strongly recommended, since Nexus is reachable from the internet.</p>
         <button class="btn primary" id="enable2fa">Turn on two-step sign-in</button>`}
  </section>
  <section class="panel"><h3>Your profile</h3><form id="profile" class="row wrap"><input name="name" value="${esc(me.name)}"><input name="color" type="color" value="${esc(me.color)}"><button class="btn">Save</button></form>
    <form id="pw" class="row wrap"><input name="current" type="password" placeholder="Current password" required><input name="password" type="password" placeholder="New password (8+)" minlength="8" required><button class="btn">Change password</button></form></section>
  <section class="panel" id="aipriv"><h3>AI privacy</h3>
    <p class="muted">Notes in these folders (and their subfolders) are never read by Claude: not by Ask Claude, the phone connector or the weekly review. Use it for work notes your employer doesn't want shared with AI services. You can also hide single notes from a note's ⋯ menu.</p>
    <div class="row wrap"><input id="aiFolders" list="aiFolderList" placeholder="e.g. Work KB, Finance" value="${esc((settings.ai_excluded_folders || []).join(', '))}"><datalist id="aiFolderList">${[...new Set(state.notes.map((x) => x.folder).filter(Boolean))].sort().map((f) => `<option value="${esc(f)}">`).join('')}</datalist><button class="btn" id="saveAi">Save</button></div>
  </section>
  <section class="panel"><h3>Daily note template</h3><textarea id="dailyTpl" rows="6">${esc(settings.daily_template)}</textarea><button class="btn" id="saveTpl">Save template</button></section>
  <section class="panel" id="backups"><h3>Backups</h3><div id="bkStatus" class="small muted">Loading…</div></section>
  <section class="panel"><h3>Import & export</h3><p class="muted">Import an <b>Obsidian vault</b> or a <b>Notion</b> “Markdown & CSV” export (unzipped). Frontmatter becomes properties and tags; folders are kept.</p>
    <div class="row wrap"><label class="btn">📁 Import folder<input type="file" id="impDir" webkitdirectory hidden></label><label class="btn">📄 Import .md files<input type="file" id="impFiles" accept=".md,.markdown,.txt" multiple hidden></label><a class="btn" href="/api/export">⬇️ Export everything (JSON)</a></div></section>
  </div>`;

  main.onclick = async (e) => {
    const row = e.target.closest('.calrow[data-id]'), id = row?.dataset.id;
    if (e.target.matches('[data-sync]')) { e.target.textContent = 'Syncing…'; try { const r = await api('POST', `/api/calendars/${id}/sync`); toast(`Synced ${r.count} events`, 'ok'); } catch (err) { toast(err.message, 'error'); } invalidateEvents(); return route(); }
    if (e.target.matches('[data-del]')) { if (confirm('Remove this calendar and its events from Nexus? (Nothing is deleted from Google/Outlook.)')) { await api('DELETE', `/api/calendars/${id}`); invalidateEvents(); route(); } return; }
    if (e.target.matches('[data-pick]')) {
      const list = await api('GET', `/api/calendars/${id}/remote`).catch((err) => toast(err.message, 'error'));
      if (!list) return;
      modal('Which calendar should sync?', `<div class="menu">${list.map((c) => `<button data-cid="${esc(c.id)}">${c.primary ? '⭐ ' : ''}${esc(c.name)}</button>`).join('')}</div><p class="muted small">Tip: pick a shared “Family” calendar so both of you see the same events in Google/Outlook too.</p>`, (box, close) => {
        box.onclick = async (ev) => { const b = ev.target.closest('[data-cid]'); if (!b) return; await api('PATCH', `/api/calendars/${id}`, { calendarId: b.dataset.cid, name: `${me.name} · ${b.textContent.replace('⭐ ', '')}` }); close(); invalidateEvents(); route(); };
      });
    }
    if (e.target.matches('[data-mail]')) {
      const c = state.calendars.find((x) => x.id === +id);
      const st = c.mailStatus;
      modal('Email → calendar', `<p>Move or forward appointment emails (doctor, school, reservations, deliveries…) into an Outlook folder, and Nexus has Claude read them every 10 minutes: appointments go on the <b>Household</b> calendar for you, and a note goes in today's Inbox. Each email is read once, then marked as read.</p>
        <ol class="small"><li>In Outlook, create a folder named e.g. <b>Nexus</b> (tip: add a rule to move confirmations there automatically).</li>
        <li>In the Microsoft Entra app for Nexus → <b>API permissions</b> → add Microsoft Graph delegated permission <b>Mail.ReadWrite</b>.</li>
        <li>${c.mailAccess ? '✅ Email access granted.' : '<a class="btn primary sm" href="/api/oauth/outlook/start?mail=1">Grant email access</a> (signs in to Microsoft again)'}</li></ol>
        <form class="row wrap"><label><input type="checkbox" name="on" ${c.mailWatch?.enabled ? 'checked' : ''} ${c.mailAccess ? '' : 'disabled'}> Watch folder</label><input name="folder" value="${esc(c.mailWatch?.folder || 'Nexus')}" style="max-width:160px"><button class="btn" ${c.mailAccess ? '' : 'disabled'}>Save</button><button type="button" class="btn" id="mailNow" ${c.mailWatch?.enabled ? '' : 'disabled'}>Check now</button></form>
        ${st ? `<p class="small ${st.ok ? 'muted' : 'err'}">Last check ${ago(st.at)}: ${st.ok ? `${st.processed} email${st.processed === 1 ? '' : 's'} read, ${st.added} event${st.added === 1 ? '' : 's'} added` : esc(st.error)}</p>` : ''}
        ${state.claude?.configured ? '' : '<p class="err small">Needs Ask Claude (ANTHROPIC_API_KEY) to read the emails.</p>'}`, (box, close) => {
        box.querySelector('form').onsubmit = async (ev) => { ev.preventDefault(); await api('PATCH', `/api/calendars/${id}`, { mailWatch: { enabled: ev.target.on.checked, folder: ev.target.folder.value } }); toast('Saved', 'ok'); close(); await loadMeta(); route(); };
        box.querySelector('#mailNow').onclick = async () => { try { const r = await api('POST', `/api/calendars/${id}/mail/check`); toast(r.ok ? `${r.processed} email(s) read, ${r.added} event(s) added` : r.error, r.ok ? 'ok' : 'error'); close(); await loadMeta(); route(); } catch (err) { toast(err.message, 'error'); } };
      });
    }
    if (e.target.id === 'copyFeed') { navigator.clipboard?.writeText(feed); toast('Feed URL copied'); }
    if (e.target.id === 'rotate' && confirm('Create a new feed link? Existing subscriptions will stop updating.')) { const u = await api('PATCH', '/api/users/me', { rotateIcs: true }); state.me = { ...state.me, ...u }; route(); }
    if (e.target.id === 'addIcs') modal('Subscribe to calendar', `<form><input name="name" placeholder="Name (e.g. Work Outlook)" required autofocus><input name="url" placeholder="https://… or webcal://… .ics" required><input name="color" type="color" value="#0ea5e9">
      <p class="muted small"><b>Google:</b> Calendar settings → your calendar → “Secret address in iCal format”.<br><b>Outlook:</b> Settings → Calendar → Shared calendars → Publish a calendar → ICS link.</p><div class="actions"><span class="sp"></span><button class="btn primary">Subscribe</button></div></form>`, (box, close) => {
      $('form', box).onsubmit = async (ev) => { ev.preventDefault(); const f = ev.target; try { await api('POST', '/api/calendars', { kind: 'ics', name: f.name.value, url: f.url.value, color: f.color.value }); close(); invalidateEvents(); route(); } catch (err) { toast(err.message, 'error'); } };
    });
    if (e.target.id === 'addLocal') modal('New calendar', `<form><input name="name" placeholder="Name (e.g. Kids, Bills, Trips)" required autofocus><input name="color" type="color" value="#22c55e"><label><input type="checkbox" name="household" checked> Household calendar (owned by everyone)</label><div class="actions"><span class="sp"></span><button class="btn primary">Create</button></div></form>`, (box, close) => {
      $('form', box).onsubmit = async (ev) => { ev.preventDefault(); const f = ev.target; await api('POST', '/api/calendars', { kind: 'local', name: f.name.value, color: f.color.value, household: f.household.checked }); close(); route(); };
    });
    if (e.target.id === 'saveAi') { await api('PUT', '/api/settings', { ai_excluded_folders: $('#aiFolders').value.split(',').map((x) => x.trim()).filter(Boolean) }); toast('AI privacy saved', 'ok'); }
    if (e.target.id === 'saveTpl') { await api('PUT', '/api/settings', { daily_template: $('#dailyTpl').value }); toast('Saved', 'ok'); }
  };
  main.onchange = async (e) => {
    const id = e.target.closest('.calrow[data-id]')?.dataset.id;
    if (e.target.matches('[data-color]')) { await api('PATCH', `/api/calendars/${id}`, { color: e.target.value }); invalidateEvents(); await loadMeta(); }
    if (e.target.matches('[data-shared]')) { await api('PATCH', `/api/calendars/${id}`, { shared: e.target.checked }); toast(e.target.checked ? 'Visible to household' : 'Hidden from household'); }
    if (e.target.id === 'impDir' || e.target.id === 'impFiles') {
      const files = [...e.target.files].filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
      if (!files.length) return toast('No Markdown files found', 'error');
      toast(`Importing ${files.length} files…`);
      const payload = await Promise.all(files.map(async (f) => ({ path: f.webkitRelativePath || `import/${f.name}`, content: await f.text() })));
      let total = 0;
      for (let k = 0; k < payload.length; k += 300) total += (await api('POST', '/api/import', { files: payload.slice(k, k + 300) })).count;
      toast(`Imported ${total} notes`, 'ok'); await loadNotes(); await loadMeta(); renderSidebar();
    }
  };
  const showCodes = (codes) => modal('Save your recovery codes', `<p>Each code works once if you lose your phone. Store them somewhere safe, e.g. your password manager.</p>
    <pre class="codes">${codes.join('\n')}</pre><div class="actions"><button class="btn" id="copyCodes">Copy</button><span class="sp"></span><button class="btn primary" id="doneCodes">I've saved them</button></div>`, (box, close) => {
    box.querySelector('#copyCodes').onclick = () => { navigator.clipboard?.writeText(codes.join('\n')); toast('Copied'); };
    box.querySelector('#doneCodes').onclick = () => { close(); boot(true).then(() => route()); };
  });
  $('#security').addEventListener('click', async (e) => {
    if (e.target.id === 'enable2fa') {
      const { secret, uri } = await api('POST', '/api/2fa/setup');
      modal('Turn on two-step sign-in', `<ol class="small"><li>Open your authenticator app and add an account by scanning this code:</li></ol>
        <div class="qr" id="qr"></div><p class="small muted center">Can't scan? On your phone, <a href="${esc(uri)}">tap here</a>, or enter this key manually:<br><code class="key">${esc(secret.replace(/(.{4})/g, '$1 ').trim())}</code></p>
        <ol class="small" start="2"><li>Enter the 6-digit code it shows:</li></ol>
        <form class="row"><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" maxlength="7" required autofocus><button class="btn primary">Turn on</button></form>`, (box, close) => {
        const s = document.createElement('script'); s.src = '/vendor/qrcode.js';
        s.onload = () => { const qr = window.qrcode(0, 'M'); qr.addData(uri); qr.make(); box.querySelector('#qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true }); };
        document.head.appendChild(s);
        box.querySelector('form').onsubmit = async (ev) => {
          ev.preventDefault();
          try { const { codes } = await api('POST', '/api/2fa/enable', { code: ev.target.code.value }); close(); showCodes(codes); }
          catch (err) { toast(err.message, 'error'); }
        };
      });
    }
    if (e.target.id === 'disable2fa') {
      const password = prompt('Enter your password to turn off two-step sign-in'); if (!password) return;
      try { await api('POST', '/api/2fa/disable', { password }); toast('Two-step sign-in is off'); await boot(true); route(); } catch (err) { toast(err.message, 'error'); }
    }
    if (e.target.id === 'newRecovery') {
      const password = prompt('Enter your password to create new recovery codes (old ones stop working)'); if (!password) return;
      try { const { codes } = await api('POST', '/api/2fa/recovery', { password }); showCodes(codes); } catch (err) { toast(err.message, 'error'); }
    }
  });
  const drawNotif = async () => {
    const { prefs: p, smtp, pushover } = await api('GET', '/api/notify');
    const el = $('#notifBody'); el.className = '';
    el.innerHTML = `<p class="muted">Get your morning summary, reminders and alerts on your phone. Each household member sets up their own.</p>
      <form id="notifForm">
      <label class="lbl">Push via ntfy <small class="muted">— free app. Pick a hard-to-guess topic, e.g. <code>https://ntfy.sh/nexus-${esc(me.name.toLowerCase())}-${Math.random().toString(36).slice(2, 8)}</code>, and subscribe to it in the ntfy app (or use your own ntfy server).</small></label>
      <div class="row wrap"><input name="ntfy" placeholder="https://ntfy.sh/your-secret-topic" value="${esc(p.notify.ntfy || '')}"><input name="ntfyToken" placeholder="Access token (optional)" value="${esc(p.notify.ntfyToken || '')}" style="max-width:220px"></div>
      ${pushover ? `<label class="lbl">Push via Pushover <small class="muted">— your user key from the Pushover app</small></label><input name="pushover" value="${esc(p.notify.pushover || '')}" placeholder="User key">` : ''}
      ${smtp ? `<label class="lbl">Email</label><input name="email" type="email" value="${esc(p.notify.email || '')}" placeholder="you@example.com">` : '<p class="small muted">Email is available once SMTP is set up on the server (see README → Notifications).</p>'}
      <label class="lbl">What to send</label>
      <div class="checks">
        <label><input type="checkbox" name="digest" ${p.digest.on ? 'checked' : ''}> ☀️ Morning summary at <input type="time" name="time" value="${esc(p.digest.time)}"> — today's events for both of you, tasks due, flashcards, anything down</label>
        <label>⏰ Remind me before events <select name="lead">${[[0, 'Off'], [10, '10 min'], [15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours']].map(([v, l]) => `<option value="${v}" ${+p.remind.events === v ? 'selected' : ''}>${l}</option>`).join('')}</select> (and timed tasks)</label>
        <label><input type="checkbox" name="homelab" ${p.homelab ? 'checked' : ''}> 🔴 Homelab alerts when a #service goes down or comes back</label>
        <label><input type="checkbox" name="weekly" ${p.weekly ? 'checked' : ''}> 🗓️ Weekly review ready</label>
      </div>
      <div class="actions"><button class="btn primary">Save</button><button type="button" class="btn" id="notifTest">Send a test</button><button type="button" class="btn" id="notifDigest">Send today's summary now</button></div></form>
      <p class="small muted">Phone calendar alerts: the household calendar feed includes a 30-minute alert on each event (add <code>?alarm=10</code> to the feed URL to change it, <code>?alarm=0</code> for none). On iPhone, turn off "Remove Alerts" for the subscribed calendar.</p>`;
    $('#notifForm').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      await api('PUT', '/api/notify', { notify: { ntfy: f.ntfy.value, ntfyToken: f.ntfyToken.value, pushover: f.pushover?.value || '', email: f.email?.value || '' },
        digest: { on: f.digest.checked, time: f.time.value }, remind: { events: +f.lead.value }, homelab: f.homelab.checked, weekly: f.weekly.checked });
      toast('Notification settings saved', 'ok');
    };
    const test = async (digest) => {
      $('#notifForm').requestSubmit(); await new Promise((r) => setTimeout(r, 300));
      try { const r = await api('POST', '/api/notify/test', { digest }); const bad = r.results.filter((x) => !x.ok); toast(bad.length ? `Failed: ${bad.map((x) => `${x.channel}: ${x.error}`).join('; ')}` : `Sent via ${r.results.map((x) => x.channel).join(' + ')}`, bad.length ? 'error' : 'ok'); }
      catch (err) { toast(err.message, 'error'); }
    };
    $('#notifTest').onclick = () => test(false);
    $('#notifDigest').onclick = () => test(true);
  };
  drawNotif().catch(() => {});
  const drawBackups = async () => {
    const b = await api('GET', '/api/backup'), st = b.offsite.status;
    $('#bkStatus').className = 'small';
    $('#bkStatus').innerHTML = `<p>📁 <b>On this server:</b> nightly snapshots in <code>appdata/nexus/backups</code>${b.local.length ? ` (latest ${esc(b.local[0].replace(/^nexus-|\.db$/g, ''))})` : ''}.</p>
      ${b.offsite.configured
        ? `<p>☁️ <b>Off-server:</b> ${b.offsite.s3 ? 'cloud storage' : ''}${b.offsite.s3 && b.offsite.folder ? ' + ' : ''}${b.offsite.folder ? 'backup folder' : ''}, ${b.offsite.encrypted ? '🔐 encrypted' : '⚠️ not encrypted'}.
           ${st ? (st.ok ? `Last copy ${ago(st.at)} ✅${st.files ? ` (${st.files} new files)` : ''}` : `<span class="err">Last attempt ${ago(st.at)} failed: ${esc(st.error)}</span>`) : 'No copy yet.'}</p>
           <button class="btn" id="bkNow">Back up now</button>`
        : `<p>☁️ <b>Off-server: not set up.</b> If this server's disks fail, the backups go with them. Add cloud storage (e.g. Backblaze B2, about $6/TB/month) or a folder on another disk in the container settings – see the README → Backups.</p>`}`;
  };
  drawBackups().catch(() => {});
  $('#backups').addEventListener('click', async (e) => {
    if (e.target.id !== 'bkNow') return;
    e.target.disabled = true; e.target.textContent = 'Backing up…';
    const r = await api('POST', '/api/backup/run').catch((err) => ({ ok: false, error: err.message }));
    toast(r.ok ? 'Backup copied off-server' : `Backup failed: ${r.error}`, r.ok ? 'ok' : 'error'); drawBackups();
  });
  const drawTokens = async () => {
    const t = await api('GET', '/api/tokens');
    $('#apps').innerHTML = t.apps.length ? '<b>Connected apps</b>' + t.apps.map((a) => `<div class="calrow"><span>🔗</span><div class="cinfo"><b>${esc(a.name || 'App')}</b><span class="muted">connected ${ago(a.created)}${a.last_used ? ` · last used ${ago(a.last_used)}` : ''}</span></div><button class="btn sm danger" data-app="${esc(a.client_id)}">Disconnect</button></div>`).join('') : 'No apps connected yet.';
    $('#pats').innerHTML = t.tokens.map((k) => `<div class="calrow"><span>🔑</span><div class="cinfo"><b>${esc(k.name)}</b><span class="muted">created ${ago(k.created)}${k.last_used ? ` · last used ${ago(k.last_used)}` : ' · never used'}</span></div><button class="btn sm danger" data-pat="${k.id}">Revoke</button></div>`).join('');
  };
  drawTokens().catch(() => {});
  $('#phone').addEventListener('click', async (e) => {
    if (e.target.id === 'copyMcp') { navigator.clipboard?.writeText($('#mcpUrl').value); toast('Connector URL copied'); }
    if (e.target.dataset.app && confirm('Disconnect this app? It will need to sign in again.')) { await api('DELETE', `/api/apps/${encodeURIComponent(e.target.dataset.app)}`); drawTokens(); }
    if (e.target.dataset.pat && confirm('Revoke this token? Shortcuts using it will stop working.')) { await api('DELETE', `/api/tokens/${e.target.dataset.pat}`); drawTokens(); }
    if (e.target.id === 'newPat') {
      const name = prompt('Name this token (e.g. "Dustin iPhone")', `${me.name}'s phone`); if (!name) return;
      const { token: tk } = await api('POST', '/api/tokens', { name });
      drawTokens();
      modal('Capture token created', `<p>Copy it now – it won't be shown again.</p><div class="copyrow"><input readonly value="${esc(tk)}" id="patVal"><button class="btn" id="copyPat">Copy</button></div>
        <h4>iPhone Shortcut (2 minutes)</h4><ol class="small">
        <li>Open <b>Shortcuts</b> → <b>＋</b> → name it <b>Nexus note</b>.</li>
        <li>Add action <b>Dictate Text</b> (or <b>Ask for Input</b> to type).</li>
        <li>Add action <b>Get Contents of URL</b>: URL <code>${esc(state.publicUrl || location.origin)}/api/capture</code>, Method <b>POST</b>, Headers: <code>Authorization</code> = <code>Bearer</code> + space + your token. Request Body <b>JSON</b>: key <code>text</code> = <i>Dictated Text</i>.</li>
        <li>Optional: add <b>Show Notification</b> with the result. Then say <b>"Hey Siri, Nexus note"</b>, or add it to your Home Screen / Action Button.</li></ol>
        <p class="small muted">Android: any "HTTP request" shortcut app works the same way (POST JSON <code>{"text": "…"}</code> with that header).</p>`, (box) => {
        box.querySelector('#copyPat').onclick = () => { navigator.clipboard?.writeText(tk); toast('Token copied'); };
      });
    }
  });
  $('#addUser').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/users', Object.fromEntries(new FormData(e.target))); toast('Member added – they can sign in now', 'ok'); await boot(true); route(); } catch (err) { toast(err.message, 'error'); } };
  $('#profile').onsubmit = async (e) => { e.preventDefault(); const u = await api('PATCH', '/api/users/me', Object.fromEntries(new FormData(e.target))); state.me = { ...state.me, ...u }; await boot(true); toast('Saved', 'ok'); route(); };
  $('#pw').onsubmit = async (e) => { e.preventDefault(); try { await api('PATCH', '/api/users/me', Object.fromEntries(new FormData(e.target))); toast('Password changed', 'ok'); e.target.reset(); } catch (err) { toast(err.message, 'error'); } };
  current = { name: 'settings', teardown: () => { main.onclick = main.onchange = null; } };
}

// ------------------------------------------------------------------ command palette
const COMMANDS = [
  { label: 'New note', icon: '＋', run: () => newNote() },
  { label: "Open today's daily note", icon: '📓', run: () => app.go('/daily') },
  { label: 'New event', icon: '📅', run: () => openEventModal(app, { date: today() }) },
  { label: 'Go to Home', icon: '🏠', run: () => app.go('/home') },
  { label: 'Go to Calendar', icon: '📅', run: () => app.go('/calendar') },
  { label: 'Go to Tasks', icon: '✅', run: () => app.go('/tasks') },
  { label: 'Review flashcards', icon: '🃏', run: () => app.go('/review') },
  { label: 'Open graph view', icon: '🕸️', run: () => app.go('/graph') },
  { label: 'Settings', icon: '⚙️', run: () => app.go('/settings') },
  { label: 'New supertag', icon: '🏷️', run: () => editSupertag(null) },
  { label: 'Ask Claude', icon: '✨', run: () => app.go('/claude') },
  { label: 'Toggle theme', icon: '◐', run: () => $('#themeBtn').click() },
];
function palette() {
  if ($('.palette')) return;
  const cmds = [...COMMANDS, ...state.supertags.map((s) => ({ label: `New #${s.name}`, icon: s.icon, run: () => newNote({ supertag: s.name, title: `New ${s.name}` }) })), ...state.supertags.map((s) => ({ label: `Open #${s.name} database`, icon: s.icon, run: () => app.go(`/db/${encodeURIComponent(s.name)}`) }))];
  let results = [], sel = 0, ftsSeq = 0;
  const close = modal('Search', `<input class="pin" placeholder="Search notes, or type > for commands…" autofocus><div class="pres"></div><div class="phint muted">↑↓ navigate · Enter open · Shift+Enter create note</div>`, (box, cl) => {
    const inp = $('.pin', box), res = $('.pres', box);
    const draw = () => { res.innerHTML = results.map((r, i) => r.header ? `<div class="phdr">${esc(r.header)}</div>` : `<div class="pr${i === sel ? ' sel' : ''}" data-i="${i}"><span class="pic">${esc(r.icon || '📄')}</span><span class="pt">${esc(r.label)}${r.sub ? `<small>${r.sub}</small>` : ''}</span>${r.hint ? `<span class="ph">${esc(r.hint)}</span>` : ''}</div>`).join(''); res.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }); };
    const move = (d) => { do { sel = (sel + d + results.length) % results.length; } while (results[sel]?.header && results.length > 1); draw(); };
    const update = () => {
      const qy = inp.value.trim();
      if (qy.startsWith('>')) { const c = qy.slice(1).trim(); results = cmds.map((x) => ({ ...x, s: fuzzy(c, x.label) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s); sel = 0; return draw(); }
      const notes = state.notes.map((n) => ({ n, s: fuzzy(qy, n.title) + (qy ? 0 : n.updated / 1e13) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, qy ? 12 : 8)
        .map(({ n }) => ({ label: n.title, icon: n.icon, hint: n.folder, run: () => app.go(`/note/${n.id}`), id: n.id }));
      const cm = qy ? cmds.map((x) => ({ ...x, s: fuzzy(qy, x.label) })).filter((x) => x.s > 20).slice(0, 3) : [];
      results = [...notes, ...cm];
      if (qy && !exists(qy)) results.push({ label: `Create “${qy}”`, icon: '＋', run: () => newNote({ title: qy }) });
      if (qy.length > 3 && state.claude?.configured) results.push({ label: `Ask Claude: “${qy}”`, icon: '✨', run: () => app.go(`/claude?q=${encodeURIComponent(qy)}`) });
      sel = 0; draw();
      if (qy.length >= 2) {
        const seq = ++ftsSeq;
        setTimeout(async () => {
          if (seq !== ftsSeq) return;
          const hits = await api('GET', `/api/search?q=${encodeURIComponent(qy)}`).catch(() => []);
          if (seq !== ftsSeq) return;
          const have = new Set(results.map((r) => r.id).filter(Boolean));
          const extra = hits.filter((h) => !have.has(h.id)).slice(0, 15).map((h) => ({ label: h.title, icon: h.icon, sub: esc(h.snip || '').replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>'), run: () => app.go(`/note/${h.id}`), id: h.id }));
          for (const r of results) { const h = hits.find((x) => x.id === r.id); if (h && h.snip) r.sub = esc(h.snip).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>'); }
          if (extra.length) { const createIdx = results.findIndex((r) => r.label.startsWith('Create “')); const ins = [{ header: 'Found in content' }, ...extra]; createIdx >= 0 ? results.splice(createIdx, 0, ...ins) : results.push(...ins); }
          draw();
        }, 90);
      }
    };
    inp.oninput = update;
    inp.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); const qy = inp.value.trim(); cl(); if (e.shiftKey && qy) newNote({ title: qy }); else results[sel]?.run?.(); }
    };
    res.onclick = (e) => { const r = e.target.closest('[data-i]'); if (r) { cl(); results[+r.dataset.i].run(); } };
    update();
  }, 'palette');
  return close;
}

// ------------------------------------------------------------------ live updates
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('note', (e) => { const d = JSON.parse(e.data); if (d.origin === clientId) return; refreshNotes(); emit('remote-note', d); });
  es.addEventListener('notes', (e) => { const d = JSON.parse(e.data); if (d.origin !== clientId) refreshNotes(); });
  es.addEventListener('events', () => { invalidateEvents(); emit('events'); });
  es.addEventListener('services', () => emit('services'));
  es.addEventListener('supertags', async () => { await loadMeta(); renderSidebar(); });
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(connectStream, 5000); };
}
on('events', () => { invalidateEvents(); });

// ------------------------------------------------------------------ keyboard
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'k' || (k === 'p' && !e.shiftKey) || k === 'o') { if (document.activeElement?.id === 'ed' && k === 'k' && document.activeElement.selectionStart !== document.activeElement.selectionEnd) return; e.preventDefault(); palette(); }
  else if (k === 'n' && !e.shiftKey) { e.preventDefault(); newNote(); }
  else if (k === 'd' && !e.shiftKey) { e.preventDefault(); app.go('/daily'); }
  else if (k === 'e' && current?.setMode) { e.preventDefault(); current.setMode(); }
  else if (k === 's') { e.preventDefault(); current?.save?.(); }
});

// ------------------------------------------------------------------ boot
async function boot(refreshOnly = false) {
  const me = await api('GET', '/api/me');
  state.me = me.user; state.users = me.users; state.integrations = me.integrations; state.claude = me.claude; state.publicUrl = me.publicUrl; state.security = me.security;
  if (refreshOnly) { renderSidebar(); return; }
  shell(); applyTheme();
  await Promise.all([loadNotes(), loadMeta()]);
  renderSidebar();
  connectStream();
  addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') navigator.serviceWorker?.register('/sw.js').catch(() => {});
}

applyTheme();
boot().catch((e) => { if (e.message !== 'Signed out') { console.error(e); document.body.innerHTML = `<div class="authbox"><h1>Nexus</h1><p>Couldn't reach the server: ${esc(e.message)}</p><button class="btn" onclick="location.reload()">Retry</button></div>`; } });
