// Compact RFC 5545 RRULE expander. Supports FREQ (DAILY/WEEKLY/MONTHLY/YEARLY),
// INTERVAL, COUNT, UNTIL, BYDAY (incl. ordinals like 2TU / -1FR), BYMONTHDAY, BYMONTH.
// Expansion happens in the event's wall-clock time zone so DST is handled correctly.
import { wallParts, zonedToUtc, dateStrToUtcMs, utcMsToDateStr, iso, DAY } from './time.js';

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseRule(str) {
  const r = {};
  for (const part of String(str).replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v) r[k.toUpperCase()] = v;
  }
  return {
    freq: r.FREQ || 'DAILY',
    interval: Math.max(1, parseInt(r.INTERVAL || '1', 10)),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL ? parseUntil(r.UNTIL) : null,
    byday: r.BYDAY ? r.BYDAY.split(',').map((s) => {
      const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(s.trim());
      return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WD[m[2].toUpperCase()] } : null;
    }).filter(Boolean) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null,
  };
}

function parseUntil(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v);
  if (!m) return null;
  return m[4] ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.UTC(+m[1], m[2] - 1, +m[3], 23, 59, 59);
}

const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

function nthWeekday(y, m0, wd, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m0, 1)).getUTCDay();
    const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    return d <= daysInMonth(y, m0) ? d : null;
  }
  const dim = daysInMonth(y, m0);
  const last = new Date(Date.UTC(y, m0, dim)).getUTCDay();
  const d = dim - ((last - wd + 7) % 7) + (n + 1) * 7;
  return d >= 1 ? d : null;
}

// Yields candidate "naive" day timestamps (UTC midnight of wall date) in order.
function* candidates(rule, base) {
  const b = new Date(base);
  const by = b.getUTCFullYear(), bm = b.getUTCMonth(), bd = b.getUTCDate(), bw = b.getUTCDay();
  for (let k = 0; k < 20000; k++) {
    const step = k * rule.interval;
    if (rule.freq === 'DAILY') {
      yield base + step * DAY;
    } else if (rule.freq === 'WEEKLY') {
      const weekStart = base - ((bw + 6) % 7) * DAY + step * 7 * DAY; // Monday
      const days = (rule.byday?.length ? rule.byday.map((x) => x.wd) : [bw]).map((wd) => (wd + 6) % 7).sort((a, b2) => a - b2);
      for (const off of days) yield weekStart + off * DAY;
    } else if (rule.freq === 'MONTHLY') {
      const y = by + Math.floor((bm + step) / 12), m0 = (bm + step) % 12;
      const out = [];
      if (rule.byday?.length) {
        for (const { n, wd } of rule.byday) {
          if (n) { const d = nthWeekday(y, m0, wd, n); if (d) out.push(d); }
          else for (let d = 1; d <= daysInMonth(y, m0); d++) if (new Date(Date.UTC(y, m0, d)).getUTCDay() === wd) out.push(d);
        }
      } else if (rule.bymonthday?.length) {
        const dim = daysInMonth(y, m0);
        for (const md of rule.bymonthday) { const d = md < 0 ? dim + md + 1 : md; if (d >= 1 && d <= dim) out.push(d); }
      } else if (bd <= daysInMonth(y, m0)) out.push(bd);
      for (const d of out.sort((a, b2) => a - b2)) yield Date.UTC(y, m0, d);
    } else if (rule.freq === 'YEARLY') {
      const y = by + step;
      const months = rule.bymonth?.length ? rule.bymonth.map((m) => m - 1) : [bm];
      for (const m0 of months.sort((a, b2) => a - b2)) {
        if (rule.byday?.length && rule.byday[0].n) {
          const d = nthWeekday(y, m0, rule.byday[0].wd, rule.byday[0].n); if (d) yield Date.UTC(y, m0, d);
        } else if (bd <= daysInMonth(y, m0)) yield Date.UTC(y, m0, bd);
      }
    } else return;
  }
}

/**
 * Expand a recurring event into concrete instances overlapping [fromMs, toMs).
 * ev: { start, end, all_day, rrule, tz, exdates: [iso|date] }
 * Returns [{ start, end, recurrence: originalStart }]
 */
export function expand(ev, fromMs, toMs, max = 2000) {
  const rule = parseRule(ev.rrule);
  const out = [];
  const ex = new Set((ev.exdates || []).map((x) => (ev.all_day ? String(x).slice(0, 10) : Date.parse(x))));
  let n = 0;
  if (ev.all_day) {
    const base = dateStrToUtcMs(ev.start);
    const dur = Math.max(DAY, dateStrToUtcMs(ev.end) - base);
    for (const day of candidates(rule, base)) {
      if (day < base) continue;
      if (rule.until && day > rule.until) break;
      if (rule.count && n >= rule.count) break;
      n++;
      if (day >= toMs) break;
      const s = utcMsToDateStr(day);
      if (day + dur > fromMs && !ex.has(s)) out.push({ start: s, end: utcMsToDateStr(day + dur), recurrence: s });
      if (out.length >= max) break;
    }
    return out;
  }
  const tz = ev.tz || 'UTC';
  const startMs = Date.parse(ev.start);
  const dur = Math.max(0, Date.parse(ev.end) - startMs);
  const w = wallParts(startMs, tz);
  const base = Date.UTC(w.y, w.m - 1, w.d);
  for (const day of candidates(rule, base)) {
    if (day < base) continue;
    const d = new Date(day);
    const s = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), w.h, w.mi, w.s, tz);
    if (rule.until && s > rule.until) break;
    if (rule.count && n >= rule.count) break;
    n++;
    if (s >= toMs) break;
    if (s + dur > fromMs && !ex.has(s)) out.push({ start: iso(s), end: iso(s + dur), recurrence: iso(s) });
    if (out.length >= max) break;
  }
  return out;
}
