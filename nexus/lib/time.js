// Time-zone helpers built on Intl (no dependencies).

const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

// Common Windows zone names (seen in Outlook ICS feeds) -> IANA.
const WINDOWS_TZ = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax',
  'GMT Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'E. Europe Standard Time': 'Europe/Bucharest', 'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
};

const validTz = new Map();
export function normalizeTz(tz, fallback = 'UTC') {
  if (!tz) return fallback;
  tz = String(tz).replace(/^"|"$/g, '').replace(/^\/+/, '');
  if (WINDOWS_TZ[tz]) return WINDOWS_TZ[tz];
  if (validTz.has(tz)) return validTz.get(tz) ? tz : fallback;
  let ok = true;
  try { fmt(tz); } catch { ok = false; }
  validTz.set(tz, ok);
  return ok ? tz : fallback;
}

export function wallParts(ms, tz) {
  if (!tz || tz === 'UTC') {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

function offset(ms, tz) {
  const w = wallParts(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

// Wall-clock time in `tz` -> UTC epoch ms (DST-correct).
export function zonedToUtc(y, m, d, h = 0, mi = 0, s = 0, tz = 'UTC') {
  const naive = Date.UTC(y, m - 1, d, h, mi, s);
  if (!tz || tz === 'UTC') return naive;
  const o1 = offset(naive, tz);
  let t = naive - o1;
  const o2 = offset(t, tz);
  if (o2 !== o1) t = naive - o2;
  return t;
}

export const iso = (ms) => new Date(ms).toISOString();
export const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export function dateStrToUtcMs(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
export function utcMsToDateStr(ms) { const d = new Date(ms); return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
export const DAY = 86400000;
