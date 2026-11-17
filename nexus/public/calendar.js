// Household calendar: month / week / agenda views, per-person filters, conflict detection, two-way event editing.
import { esc } from './md.js';

const DAYMS = 86400000;
export const dstr = (d) => d.toLocaleDateString('sv');
const parseDay = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase();
const hhmm = (d) => d.toTimeString().slice(0, 5);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const REPEAT = { '': 'Does not repeat', 'FREQ=DAILY': 'Daily', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR': 'Every weekday', 'FREQ=WEEKLY': 'Weekly',
  'FREQ=WEEKLY;INTERVAL=2': 'Every 2 weeks', 'FREQ=MONTHLY': 'Monthly', 'FREQ=YEARLY': 'Yearly' };

const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

const cache = new Map();
export function invalidateEvents() { cache.clear(); }

export async function loadItems(app, from, to) {
  const key = `${from.toISOString()}|${to.toISOString()}`;
  if (!cache.has(key)) cache.set(key, app.api('GET', `/api/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`).catch((e) => { cache.delete(key); throw e; }));
  const { events, tasks } = await cache.get(key);
  const cals = new Map(app.state.calendars.map((c) => [c.id, c]));
  const items = [];
  for (const e of events) {
    const cal = cals.get(e.calendar_id) || {};
    const allDay = !!e.all_day;
    items.push({
      kind: 'event', id: e.id, title: e.title, allDay, raw: e, cal,
      start: allDay ? parseDay(e.start) : new Date(e.start), end: allDay ? parseDay(e.end) : new Date(e.end),
      color: cal.color || '#64748b', people: e.who?.length ? e.who : cal.user_id ? [cal.user_id] : [],
    });
  }
  for (const t of tasks) {
    const s = t.time ? new Date(`${t.due}T${t.time}`) : parseDay(t.due);
    items.push({ kind: 'task', title: t.text || t.note_title, allDay: !t.time, start: s, end: t.time ? new Date(+s + 30 * 60000) : addDays(s, 1), raw: t,
      color: '#94a3b8', people: t.owner_id ? [t.owner_id] : [], done: !!t.done });
  }
  items.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start) || a.title.localeCompare(b.title));
  markConflicts(items);
  return items;
}

// Same person double-booked (timed events only).
function markConflicts(items) {
  const timed = items.filter((i) => !i.allDay && i.kind === 'event' && i.people.length);
  for (let a = 0; a < timed.length; a++) {
    for (let b = a + 1; b < timed.length && timed[b].start < timed[a].end; b++) {
      if (timed[b].start < timed[a].end && timed[a].start < timed[b].end && timed[a].people.some((p) => timed[b].people.includes(p))) {
        timed[a].conflict = timed[b].conflict = true;
      }
    }
  }
}

const dayItems = (items, day) => { const s = day, e = addDays(day, 1); return items.filter((i) => i.start < e && i.end > s || (+i.start === +s && +i.end === +s)); };

function chip(app, it) {
  const people = it.people.map((p) => app.userById(p)).filter(Boolean);
  const dots = people.map((u) => `<i class="pdot" style="background:${u.color}" title="${esc(u.name)}"></i>`).join('');
  const t = it.allDay ? '' : `<b>${fmtTime(it.start)}</b> `;
  const cls = `ev${it.kind === 'task' ? ' task' : ''}${it.done ? ' done' : ''}${it.conflict ? ' conflict' : ''}${it.allDay ? ' allday' : ''}`;
  const data = it.kind === 'task' ? `data-note="${it.raw.note_id}"` : `data-ev="${it.id}" data-occ="${esc(it.raw.occurrence || '')}"`;
  return `<div class="${cls}" ${data} style="--c:${it.color}" title="${esc(it.title)}${it.conflict ? ' — overlaps another event for the same person' : ''}">${it.kind === 'task' ? (it.done ? '☑ ' : '☐ ') : ''}${t}${esc(it.title)}${dots}${it.conflict ? ' ⚠' : ''}</div>`;
}

export async function mountCalendar(el, app) {
  let view = LS.get('cal.view', innerWidth < 700 ? 'agenda' : 'month');
  let cursor = startOfDay(new Date());
  const hidden = new Set(LS.get('cal.hidden', []));
  let items = [];

  const range = () => {
    if (view === 'month') { const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1); const s = addDays(first, -first.getDay()); return [s, addDays(s, 42)]; }
    if (view === 'week') { const s = addDays(cursor, -cursor.getDay()); return [s, addDays(s, 7)]; }
    return [cursor, addDays(cursor, 60)];
  };
  const visible = (it) => {
    if (!it.people.length) return !hidden.has('h');
    return it.people.some((p) => !hidden.has(String(p)));
  };

  async function refresh() {
    const [s, e] = range();
    try { items = (await loadItems(app, s, e)).filter(visible); } catch (err) { app.toast(err.message, 'error'); items = []; }
    draw();
  }

  function header() {
    const [s] = range();
    const title = view === 'month' ? cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })
      : view === 'week' ? `${s.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${addDays(s, 6).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
      : `Agenda from ${cursor.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
    const people = [...app.state.users.map((u) => ({ k: String(u.id), name: u.name, color: u.color })), { k: 'h', name: 'Household', color: '#f59e0b' }];
    return `<div class="calbar">
      <div class="calnav"><button class="btn" data-a="prev">‹</button><button class="btn" data-a="today">Today</button><button class="btn" data-a="next">›</button><h2>${esc(title)}</h2></div>
      <div class="people">${people.map((p) => `<button class="pchip${hidden.has(p.k) ? ' off' : ''}" data-p="${p.k}" style="--c:${p.color}"><i></i>${esc(p.name)}</button>`).join('')}</div>
      <div class="seg">${['month', 'week', 'agenda'].map((v) => `<button class="${v === view ? 'on' : ''}" data-v="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      <button class="btn primary" data-a="new">+ Event</button></div>`;
  }

  function drawMonth() {
    const [s] = range(), today = dstr(new Date());
    let html = '<div class="month"><div class="dow">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div>${d}</div>`).join('') + '</div><div class="mgrid">';
    for (let i = 0; i < 42; i++) {
      const d = addDays(s, i), ds = dstr(d), its = dayItems(items, d);
      const max = 4;
      html += `<div class="mday${d.getMonth() !== cursor.getMonth() ? ' other' : ''}${ds === today ? ' today' : ''}" data-day="${ds}">
        <div class="mnum">${d.getDate()}</div>${its.slice(0, max).map((it) => chip(app, it)).join('')}${its.length > max ? `<div class="more" data-day="${ds}">+${its.length - max} more</div>` : ''}</div>`;
    }
    return html + '</div></div>';
  }

  function drawWeek() {
    const [s] = range(), today = dstr(new Date()), H = 48;
    const days = [...Array(7)].map((_, i) => addDays(s, i));
    let html = `<div class="week"><div class="wh"><div></div>${days.map((d) => `<div class="${dstr(d) === today ? 'today' : ''}" data-day="${dstr(d)}"><span>${d.toLocaleDateString([], { weekday: 'short' })}</span> <b>${d.getDate()}</b></div>`).join('')}</div>`;
    html += `<div class="wall"><div class="wlabel">all-day</div>${days.map((d) => `<div data-day="${dstr(d)}">${dayItems(items, d).filter((i) => i.allDay).map((it) => chip(app, it)).join('')}</div>`).join('')}</div>`;
    html += `<div class="wbody"><div class="hours">${[...Array(24)].map((_, h) => `<div style="height:${H}px">${h ? new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' }) : ''}</div>`).join('')}</div>`;
    for (const d of days) {
      const segs = dayItems(items, d).filter((i) => !i.allDay).map((it) => {
        const s0 = Math.max(+it.start, +d), e0 = Math.min(+it.end, +addDays(d, 1));
        return { it, top: (s0 - d) / 3600000 * H, h: Math.max(H / 2.2, (e0 - s0) / 3600000 * H), s0, e0 };
      }).sort((a, b) => a.s0 - b.s0 || b.e0 - a.e0);
      // Column layout for overlaps.
      const cols = []; let cluster = [], clusterEnd = 0;
      const flush = () => { const n = Math.max(...cluster.map((c) => c.col)) + 1; cluster.forEach((c) => (c.n = n)); cluster = []; };
      for (const sg of segs) {
        if (cluster.length && sg.s0 >= clusterEnd) { flush(); cols.length = 0; }
        let c = cols.findIndex((end) => end <= sg.s0); if (c < 0) c = cols.length;
        cols[c] = sg.e0; sg.col = c; cluster.push(sg); clusterEnd = Math.max(clusterEnd, sg.e0);
      }
      if (cluster.length) flush();
      const now = new Date();
      html += `<div class="wcol${dstr(d) === today ? ' today' : ''}" data-day="${dstr(d)}" style="height:${24 * H}px">${dstr(d) === today ? `<div class="nowline" style="top:${(now - d) / 3600000 * H}px"></div>` : ''}
        ${segs.map((sg) => { const it = sg.it; const w = 100 / sg.n;
          return `<div class="wev${it.kind === 'task' ? ' task' : ''}${it.conflict ? ' conflict' : ''}" ${it.kind === 'task' ? `data-note="${it.raw.note_id}"` : `data-ev="${it.id}" data-occ="${esc(it.raw.occurrence || '')}"`}
            style="--c:${it.color};top:${sg.top}px;height:${sg.h - 2}px;left:calc(${sg.col * w}% + 2px);width:calc(${w}% - 4px)">
            <b>${esc(it.title)}${it.conflict ? ' ⚠' : ''}</b><span>${fmtTime(it.start)}–${fmtTime(it.end)}${it.raw.location ? ' · ' + esc(it.raw.location) : ''}</span>
            <span class="wppl">${it.people.map((p) => app.userById(p)).filter(Boolean).map((u) => `<i class="pdot" style="background:${u.color}"></i>`).join('')}</span></div>`; }).join('')}</div>`;
    }
    return html + '</div></div>';
  }

  function drawAgenda() {
    let html = '<div class="agenda">', any = false;
    for (let i = 0; i < 60; i++) {
      const d = addDays(cursor, i), its = dayItems(items, d);
      if (!its.length) continue;
      any = true;
      const conflicts = its.filter((x) => x.conflict).length;
      html += `<div class="aday"><div class="adate${i === 0 && dstr(d) === dstr(new Date()) ? ' today' : ''}"><b>${d.toLocaleDateString([], { weekday: 'short' })}</b><span>${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>${conflicts ? '<em title="Double-booked">⚠</em>' : ''}</div><div class="aitems">`;
      for (const it of its) {
        const people = it.people.map((p) => app.userById(p)).filter(Boolean);
        html += `<div class="aitem${it.conflict ? ' conflict' : ''}${it.done ? ' done' : ''}" ${it.kind === 'task' ? `data-note="${it.raw.note_id}"` : `data-ev="${it.id}" data-occ="${esc(it.raw.occurrence || '')}"`} style="--c:${it.color}">
          <span class="atime">${it.allDay ? (it.kind === 'task' ? 'due' : 'all day') : `${fmtTime(it.start)} – ${fmtTime(it.end)}`}</span>
          <span class="atitle">${it.kind === 'task' ? (it.done ? '☑ ' : '☐ ') : ''}${esc(it.title)}${it.raw.location ? `<small> · ${esc(it.raw.location)}</small>` : ''}${it.kind === 'task' ? `<small> · ${esc(it.raw.note_title)}</small>` : ''}</span>
          <span class="awho">${people.length ? people.map((u) => `<span class="who" style="--c:${u.color}">${esc(u.name)}</span>`).join('') : `<span class="who" style="--c:#f59e0b">Everyone</span>`}</span></div>`;
      }
      html += '</div></div>';
    }
    if (!any) html += '<div class="empty-state">Nothing scheduled in the next 60 days.</div>';
    return html + '</div>';
  }

  function draw() {
    el.innerHTML = header() + (view === 'month' ? drawMonth() : view === 'week' ? drawWeek() : drawAgenda());
    if (view === 'week') { const b = el.querySelector('.wbody'); if (b) b.scrollTop = 7 * 48; }
  }

  el.onclick = (e) => {
    const t = e.target.closest('[data-a],[data-v],[data-p],[data-ev],[data-note],.more,[data-day]');
    if (!t) return;
    if (t.dataset.a === 'prev' || t.dataset.a === 'next') {
      const k = t.dataset.a === 'prev' ? -1 : 1;
      cursor = view === 'month' ? new Date(cursor.getFullYear(), cursor.getMonth() + k, 1) : addDays(cursor, k * (view === 'week' ? 7 : 30));
      return refresh();
    }
    if (t.dataset.a === 'today') { cursor = startOfDay(new Date()); return refresh(); }
    if (t.dataset.a === 'new') return openEventModal(app, { date: dstr(view === 'month' && cursor.getMonth() !== new Date().getMonth() ? cursor : new Date()) });
    if (t.dataset.v) { view = t.dataset.v; LS.set('cal.view', view); if (view !== 'month') cursor = startOfDay(view === 'agenda' ? new Date() : cursor); return refresh(); }
    if (t.dataset.p) { hidden.has(t.dataset.p) ? hidden.delete(t.dataset.p) : hidden.add(t.dataset.p); LS.set('cal.hidden', [...hidden]); return refresh(); }
    if (t.dataset.ev) { const it = items.find((i) => i.kind === 'event' && i.id === +t.dataset.ev && (i.raw.occurrence || '') === t.dataset.occ); return it && openEventModal(app, { item: it }); }
    if (t.dataset.note) return app.go(`/note/${t.dataset.note}`);
    if (t.classList.contains('more')) { cursor = parseDay(t.dataset.day); view = 'week'; return refresh(); }
    if (t.dataset.day) {
      if (t.classList.contains('wcol')) {
        const y = e.clientY - t.getBoundingClientRect().top;
        const mins = Math.floor(y / 48 * 2) * 30;
        return openEventModal(app, { date: t.dataset.day, time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` });
      }
      return openEventModal(app, { date: t.dataset.day });
    }
  };

  draw();
  await refresh();
  return { refresh: () => { invalidateEvents(); return refresh(); } };
}

export function openEventModal(app, { item, date, time }) {
  const me = app.state.me;
  const writable = app.state.calendars.filter((c) => c.kind !== 'ics' && (c.user_id === null || c.mine || (c.kind === 'local' && c.shared)));
  const ev = item?.raw;
  const cal = ev ? app.state.calendars.find((c) => c.id === ev.calendar_id) : null;
  const readOnly = ev && (!cal || !writable.includes(cal));
  const allDay = ev ? !!ev.all_day : false;
  const s = item ? item.start : new Date(`${date}T${time || '09:00'}`);
  const e = item ? (allDay ? addDays(item.end, -1) : item.end) : new Date(+s + 3600000);
  const who = ev ? (ev.who?.length ? ev.who : cal?.user_id ? [cal.user_id] : []) : [me.id];
  const defCal = ev ? ev.calendar_id : (writable.find((c) => c.mine && c.kind !== 'local') || writable.find((c) => c.mine) || writable[0])?.id;
  const repeat = ev?.rrule || '';

  const html = `<form class="evform">
    <input class="evtitle" name="title" placeholder="Add title" value="${esc(ev?.title || '')}" ${readOnly ? 'readonly' : ''} required autofocus>
    <label class="row"><input type="checkbox" name="all_day" ${allDay ? 'checked' : ''}> All day</label>
    <div class="row dt"><input type="date" name="sd" value="${dstr(s)}" required><input type="time" name="st" value="${hhmm(s)}" class="t">
      <span>→</span><input type="date" name="ed" value="${dstr(e)}" required><input type="time" name="et" value="${hhmm(e)}" class="t"></div>
    <div class="row"><select name="rrule" ${readOnly || (cal && cal.kind === 'outlook') ? 'disabled' : ''}>${Object.entries(REPEAT).map(([k, v]) => `<option value="${k}" ${k === repeat ? 'selected' : ''}>${v}</option>`).join('')}${repeat && !REPEAT[repeat] ? `<option selected value="${esc(repeat)}">Custom (${esc(repeat)})</option>` : ''}</select>
      <select name="calendar_id" ${readOnly ? 'disabled' : ''}>${(readOnly ? [cal] : writable).filter(Boolean).map((c) => `<option value="${c.id}" ${c.id === defCal ? 'selected' : ''}>${esc(c.name)}${c.kind !== 'local' ? ` (${c.kind})` : ''}</option>`).join('')}</select></div>
    <div class="row whopick"><span class="lbl">Who</span>${app.state.users.map((u) => `<label class="pchip" style="--c:${u.color}"><input type="checkbox" name="who" value="${u.id}" ${who.includes(u.id) ? 'checked' : ''} ${readOnly ? 'disabled' : ''}><i></i>${esc(u.name)}</label>`).join('')}</div>
    <input name="location" placeholder="Location" value="${esc(ev?.location || '')}" ${readOnly ? 'readonly' : ''}>
    <textarea name="description" rows="3" placeholder="Details" ${readOnly ? 'readonly' : ''}>${esc(ev?.description || '')}</textarea>
    ${readOnly ? `<p class="muted">Read-only: from “${esc(cal?.name || 'subscribed calendar')}”.</p>` : ''}
    <div class="actions">
      ${ev ? `<button type="button" class="btn" data-x="note">${ev.note_id ? '📝 Open notes' : '📝 Meeting notes'}</button>` : ''}
      ${ev && !readOnly ? `<button type="button" class="btn danger" data-x="del">Delete${ev.rrule ? ' series' : ''}</button>${ev.rrule && ev.occurrence && cal?.kind === 'local' ? '<button type="button" class="btn danger" data-x="delone">Delete this one</button>' : ''}` : ''}
      <span class="sp"></span><button type="button" class="btn" data-x="cancel">${readOnly ? 'Close' : 'Cancel'}</button>${readOnly ? '' : '<button class="btn primary">Save</button>'}
    </div></form>`;

  app.modal(ev ? 'Event' : 'New event', html, (box, close) => {
    const f = box.querySelector('form');
    const sync = () => box.querySelectorAll('.t').forEach((x) => (x.style.display = f.all_day.checked ? 'none' : ''));
    f.all_day.onchange = sync; sync();
    f.sd.onchange = () => { if (f.ed.value < f.sd.value) f.ed.value = f.sd.value; };
    box.querySelector('[data-x="cancel"]').onclick = close;
    box.querySelector('[data-x="note"]')?.addEventListener('click', async () => { const r = await app.api('POST', `/api/events/${ev.id}/note`); close(); app.go(`/note/${r.id}`); });
    box.querySelector('[data-x="del"]')?.addEventListener('click', async () => {
      if (!confirm(ev.rrule ? 'Delete every occurrence of this event?' : 'Delete this event?')) return;
      try { await app.api('DELETE', `/api/events/${ev.id}`); close(); app.emit('events'); } catch (err) { app.toast(err.message, 'error'); }
    });
    box.querySelector('[data-x="delone"]')?.addEventListener('click', async () => {
      try { await app.api('DELETE', `/api/events/${ev.id}?occurrence=${encodeURIComponent(ev.occurrence)}`); close(); app.emit('events'); } catch (err) { app.toast(err.message, 'error'); }
    });
    f.onsubmit = async (x) => {
      x.preventDefault();
      if (readOnly) return close();
      const ad = f.all_day.checked;
      let start = ad ? f.sd.value : new Date(`${f.sd.value}T${f.st.value || '09:00'}`).toISOString();
      let end = ad ? dstr(addDays(parseDay(f.ed.value), 1)) : new Date(`${f.ed.value}T${f.et.value || '10:00'}`).toISOString();
      if (!ad && end <= start) end = new Date(Date.parse(start) + 3600000).toISOString();
      // Editing one occurrence of a series shifts the whole series by the same delta.
      if (ev?.occurrence && ev.master_start) {
        if (ad && ev.all_day) {
          const lenDays = Math.round((parseDay(end) - parseDay(start)) / DAYMS);
          const shift = Math.round((parseDay(start) - parseDay(ev.start)) / DAYMS);
          start = dstr(addDays(parseDay(ev.master_start), shift)); end = dstr(addDays(parseDay(start), lenDays));
        }
        else if (!ad && !ev.all_day) { const d = Date.parse(start) - Date.parse(ev.start), len = Date.parse(end) - Date.parse(start); start = new Date(Date.parse(ev.master_start) + d).toISOString(); end = new Date(Date.parse(start) + len).toISOString(); }
      }
      const body = { title: f.title.value, all_day: ad, start, end, tz: TZ, rrule: f.rrule.value || null, calendar_id: +f.calendar_id.value,
        who: [...f.querySelectorAll('[name=who]:checked')].map((c) => +c.value), location: f.location.value, description: f.description.value };
      const btn = f.querySelector('.primary'); btn.disabled = true; btn.textContent = 'Saving…';
      try {
        if (ev) await app.api('PUT', `/api/events/${ev.id}`, body); else await app.api('POST', '/api/events', body);
        close(); app.emit('events');
      } catch (err) { app.toast(err.message, 'error'); btn.disabled = false; btn.textContent = 'Save'; }
    };
  });
}
