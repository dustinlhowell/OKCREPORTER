// iCalendar (RFC 5545) parser + generator.
import { normalizeTz, zonedToUtc, wallParts, iso, ymd, dateStrToUtcMs, utcMsToDateStr, DAY } from './time.js';

const unescapeText = (s) => s.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
const escapeText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

function parseLine(line) {
  let i = 0, q = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) break;
  }
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = head.split(';');
  const params = {};
  for (const p of parts.slice(1)) { const eq = p.indexOf('='); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, ''); }
  return { name: parts[0].toUpperCase(), params, value };
}

// Returns { allDay, value } where value is 'YYYY-MM-DD' or ISO UTC string.
export function parseDate(value, params, defaultTz) {
  const v = value.trim();
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) return { allDay: true, value: ymd(+v.slice(0, 4), +v.slice(4, 6), +v.slice(6, 8)) };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) { const t = Date.parse(v); return { allDay: false, value: iso(isNaN(t) ? Date.now() : t) }; }
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
  if (m[7]) return { allDay: false, value: iso(Date.UTC(y, mo - 1, d, h, mi, s)), tz: 'UTC' };
  const tz = normalizeTz(params.TZID, defaultTz);
  return { allDay: false, value: iso(zonedToUtc(y, mo, d, h, mi, s, tz)), tz };
}

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const ms = (((+m[2] || 0) * 7 + (+m[3] || 0)) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

export function parseICS(text, defaultTz = 'UTC') {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null, depth = 0;
  for (const raw of lines) {
    if (!raw) continue;
    const { name, params, value } = parseLine(raw);
    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT') { cur = { exdates: [], tz: defaultTz }; depth = 0; }
      else if (cur) depth++;
      continue;
    }
    if (name === 'END') {
      if (value.toUpperCase() === 'VEVENT' && cur) { finish(cur); cur = null; }
      else if (cur) depth--;
      continue;
    }
    if (!cur || depth > 0) continue; // skip VALARM etc.
    switch (name) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.title = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'DESCRIPTION': cur.description = unescapeText(value); break;
      case 'STATUS': cur.status = value.toUpperCase(); break;
      case 'RRULE': cur.rrule = value; break;
      case 'DURATION': cur.duration = parseDuration(value); break;
      case 'DTSTART': { const d = parseDate(value, params, defaultTz); cur.start = d.value; cur.all_day = d.allDay; if (d.tz) cur.tz = d.tz; break; }
      case 'DTEND': cur.end = parseDate(value, params, defaultTz).value; break;
      case 'EXDATE': for (const v of value.split(',')) cur.exdates.push(parseDate(v, params, defaultTz).value); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDate(value, params, defaultTz).value; break;
    }
  }
  function finish(ev) {
    if (!ev.start || ev.status === 'CANCELLED' && !ev.recurrenceId) return;
    if (!ev.end) {
      if (ev.all_day) ev.end = utcMsToDateStr(dateStrToUtcMs(ev.start) + Math.max(DAY, ev.duration || DAY));
      else ev.end = iso(Date.parse(ev.start) + (ev.duration || 0));
    }
    ev.title = ev.title || '(untitled)';
    events.push(ev);
  }
  // Fold RECURRENCE-ID overrides into their master's exdates.
  const masters = new Map(events.filter((e) => e.rrule && !e.recurrenceId).map((e) => [e.uid, e]));
  const out = [];
  for (const e of events) {
    if (e.recurrenceId) {
      const m = masters.get(e.uid);
      if (m) m.exdates.push(e.recurrenceId);
      if (e.status === 'CANCELLED') continue;
      e.ext_id = `${e.uid}#${e.recurrenceId}`;
    } else e.ext_id = e.uid || `${e.title}@${e.start}`;
    out.push(e);
  }
  return out;
}

function fold(line) {
  if (line.length <= 74) return line;
  const parts = [];
  for (let i = 0; i < line.length; i += 73) parts.push((i ? ' ' : '') + line.slice(i, i + 73));
  return parts.join('\r\n');
}
const pad = (n) => String(n).padStart(2, '0');
const wallStamp = (v, tz) => { const w = wallParts(Date.parse(v), tz); return `${w.y}${pad(w.m)}${pad(w.d)}T${pad(w.h)}${pad(w.mi)}${pad(w.s)}`; };
const icsDate = (v, allDay) => allDay ? v.replace(/-/g, '').slice(0, 8) : new Date(v).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function generateICS(name, events) {
  const now = icsDate(new Date().toISOString());
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nexus//Household Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`, 'X-PUBLISHED-TTL:PT15M', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M'];
  for (const e of events) {
    L.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${now}`);
    if (e.all_day) L.push(`DTSTART;VALUE=DATE:${icsDate(e.start, true)}`, `DTEND;VALUE=DATE:${icsDate(e.end, true)}`);
    else if (e.rrule && e.tz && e.tz !== 'UTC') L.push(`DTSTART;TZID=${e.tz}:${wallStamp(e.start, e.tz)}`, `DTEND;TZID=${e.tz}:${wallStamp(e.end, e.tz)}`);
    else L.push(`DTSTART:${icsDate(e.start)}`, `DTEND:${icsDate(e.end)}`);
    L.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.location) L.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) L.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.rrule) L.push(`RRULE:${e.rrule.replace(/^RRULE:/i, '')}`);
    for (const x of e.exdates || []) L.push(e.all_day ? `EXDATE;VALUE=DATE:${icsDate(x, true)}` : e.rrule && e.tz && e.tz !== 'UTC' ? `EXDATE;TZID=${e.tz}:${wallStamp(x, e.tz)}` : `EXDATE:${icsDate(x)}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
