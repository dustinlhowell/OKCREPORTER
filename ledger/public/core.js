// Shared browser utilities: API client, state, formatting, toasts, modals, sheets.
import * as B from './budget.js';
export { B };

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (c, o) => B.fmtMoney(c, o);
export const money0 = (c) => B.fmtMoney(c, { cents: Math.abs(c) < 100000 && c % 100 !== 0 });
// Inputs show dollars; the API takes cents as numbers.
export const toInput = (c) => (c ? (c / 100).toFixed(2).replace(/\.00$/, '') : '');
export const fromInput = (v) => { const c = B.parseMoney(v); return Number.isFinite(c) ? c : 0; };
export const clientId = Math.random().toString(36).slice(2);
export const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
export const state = { me: null, users: [], settings: {}, today: '', layout: { groups: [], items: [] }, accounts: [], online: navigator.onLine };
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const fmtDate = (d, o = { month: 'short', day: 'numeric' }) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
export const weekday = (d) => fmtDate(d, { weekday: 'short' });
export const curMonth = () => state.today.slice(0, 7);
export const clampMonth = (m) => { const s = state.settings; return m < s.start_month ? s.start_month : m > s.end_month ? s.end_month : m; };

const listeners = {};
export const on = (t, f) => (listeners[t] ||= new Set()).add(f);
export const off = (t, f) => listeners[t]?.delete(f);
export const emit = (t, d) => listeners[t]?.forEach((f) => f(d));

export async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-client-id': clientId }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && !path.startsWith('/api/login')) { emit('signedout'); throw new Error('Signed out'); }
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export function toast(msg, type = '', action) {
  const t = document.createElement('div'); t.className = `toast ${type}`;
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="linkbtn">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { action.run(); t.remove(); };
  $('#toasts').appendChild(t); setTimeout(() => t.classList.add('out'), action ? 6000 : 3500); setTimeout(() => t.remove(), action ? 6400 : 3900);
}

// Modal dialog; on phones it becomes a bottom sheet.
export function modal(title, html, onMount, cls = '') {
  const wrap = document.createElement('div'); wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="mhead"><h3>${esc(title)}</h3><button class="x" aria-label="Close">✕</button></div><div class="mbody">${html}</div></div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('noscroll');
  const close = () => { wrap.remove(); document.removeEventListener('keydown', k); if (!$('.overlay')) document.body.classList.remove('noscroll'); };
  const k = (e) => { if (e.key === 'Escape' && wrap === $$('.overlay').at(-1)) close(); };
  document.addEventListener('keydown', k);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  $('.x', wrap).onclick = close;
  onMount?.($('.modal', wrap), close);
  const af = $('[autofocus]', wrap); if (af && matchMedia('(pointer:fine)').matches) af.focus();
  return close;
}
export const confirmBox = (title, text, ok = 'OK', danger = false) => new Promise((resolve) => {
  let done = false;
  const close = modal(title, `<p>${text}</p><div class="row end"><button class="btn" data-a="0">Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-a="1">${esc(ok)}</button></div>`, (m, c) => {
    $$('[data-a]', m).forEach((b) => (b.onclick = () => { done = true; resolve(b.dataset.a === '1'); c(); }));
  }, 'small');
  const obs = new MutationObserver(() => { if (!document.body.contains($('.modal.small')) && !done) { done = true; resolve(false); obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
});

export function itemOptions(sel, { income = true, expense = true, none = 'Needs category', archived = false } = {}) {
  const groups = state.layout.groups.filter((g) => !g.archived && ((income && g.kind === 'income') || (expense && g.kind !== 'income')));
  return `${none ? `<option value="">${esc(none)}</option>` : ''}${groups.map((g) => `<optgroup label="${esc(`${g.emoji} ${g.name}`)}">${state.layout.items.filter((i) => i.group_id === g.id && (archived || !i.archived) || i.id === +sel && i.group_id === g.id).map((i) => `<option value="${i.id}" ${+sel === i.id ? 'selected' : ''}>${esc(`${i.emoji ? i.emoji + ' ' : ''}${i.name}`)}</option>`).join('')}</optgroup>`).join('')}`;
}
export const accountOptions = (sel, { blank = false, kinds } = {}) => `${blank ? '<option value="">—</option>' : ''}${state.accounts.filter((a) => !kinds || kinds.includes(a.kind)).map((a) => `<option value="${a.id}" ${+sel === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}`;
export const itemById = (id) => state.layout.items.find((i) => i.id === +id);
export const groupById = (id) => state.layout.groups.find((g) => g.id === +id);
export async function loadLayout() {
  const [layout, accounts] = await Promise.all([api('GET', '/api/layout'), api('GET', '/api/accounts')]);
  state.layout = layout; state.accounts = accounts;
}
export const bar = (pct, cls = '') => `<div class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
export const go = (p) => { location.hash = '#' + p; };
export const monthName = (m, style = 'long') => B.monthLabel(m, style);
export const shortMonth = (m) => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
export const isPhone = () => matchMedia('(max-width: 760px)').matches;
