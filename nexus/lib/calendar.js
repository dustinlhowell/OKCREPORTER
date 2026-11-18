// Calendar sync engine: ICS subscriptions (read-only), Google Calendar and Outlook / Microsoft 365 (two-way).
import { parseICS } from './ics.js';
import { DAY } from './time.js';

export const PROVIDERS = {
  google: {
    label: 'Google Calendar',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
    extraAuth: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    env: () => ({ id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET }),
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    authUrl: `https://login.microsoftonline.com/${process.env.MS_TENANT || 'common'}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${process.env.MS_TENANT || 'common'}/oauth2/v2.0/token`,
    scope: 'offline_access openid email User.Read Calendars.ReadWrite',
    extraAuth: { response_mode: 'query', prompt: 'select_account' },
    env: () => ({ id: process.env.MS_CLIENT_ID, secret: process.env.MS_CLIENT_SECRET }),
  },
};

export const providerConfigured = (p) => { const e = PROVIDERS[p]?.env(); return !!(e && e.id && e.secret); };

export function authorizeUrl(provider, redirectUri, state) {
  const p = PROVIDERS[provider], { id } = p.env();
  const params = new URLSearchParams({ client_id: id, redirect_uri: redirectUri, response_type: 'code', scope: p.scope, state, ...p.extraAuth });
  return `${p.authUrl}?${params}`;
}

async function tokenRequest(provider, body) {
  const p = PROVIDERS[provider], { id, secret } = p.env();
  const res = await fetch(p.tokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...body }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`${provider} token error: ${j.error_description || j.error || res.status}`);
  return j;
}

export async function exchangeCode(provider, code, redirectUri) {
  const t = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const cfg = { access_token: t.access_token, refresh_token: t.refresh_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
  if (provider === 'google') {
    const r = await api(cfg, provider, 'https://www.googleapis.com/calendar/v3/calendars/primary');
    cfg.account = r.id; cfg.calendarId = 'primary';
  } else {
    const r = await api(cfg, provider, 'https://graph.microsoft.com/v1.0/me');
    cfg.account = r.mail || r.userPrincipalName;
  }
  return cfg;
}

async function accessToken(cfg, provider) {
  if (cfg.access_token && cfg.expires > Date.now()) return cfg.access_token;
  if (!cfg.refresh_token) throw new Error('Not connected – reconnect this calendar');
  const t = await tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: cfg.refresh_token });
  cfg.access_token = t.access_token;
  cfg.expires = Date.now() + (t.expires_in - 60) * 1000;
  if (t.refresh_token) cfg.refresh_token = t.refresh_token;
  cfg._dirty = true;
  return cfg.access_token;
}

async function api(cfg, provider, url, opts = {}) {
  const token = await accessToken(cfg, provider);
  const res = await fetch(url, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', Prefer: 'outlook.timezone="UTC"', ...(opts.headers || {}) },
  });
  if (res.status === 204 || res.status === 410 && opts.method === 'DELETE') return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${provider} API ${res.status}: ${j.error?.message || JSON.stringify(j.error || j).slice(0, 200)}`);
  return j;
}

// ---------- mapping ----------
const msDate = (s) => s.replace(/\.\d+$/, '') + 'Z';
function fromGoogle(e) {
  const allDay = !!e.start.date;
  return {
    ext_id: e.id, title: e.summary || '(busy)', all_day: allDay ? 1 : 0,
    start: allDay ? e.start.date : new Date(e.start.dateTime).toISOString(),
    end: allDay ? e.end.date : new Date(e.end.dateTime).toISOString(),
    tz: e.start.timeZone || null, location: e.location || null, description: e.description || null,
  };
}
function fromOutlook(e) {
  const allDay = !!e.isAllDay;
  return {
    ext_id: e.id, title: e.subject || '(busy)', all_day: allDay ? 1 : 0,
    start: allDay ? e.start.dateTime.slice(0, 10) : new Date(msDate(e.start.dateTime)).toISOString(),
    end: allDay ? e.end.dateTime.slice(0, 10) : new Date(msDate(e.end.dateTime)).toISOString(),
    tz: null, location: e.location?.displayName || null, description: e.bodyPreview || null,
  };
}
function toGoogle(ev) {
  const t = (v) => (ev.all_day ? { date: v.slice(0, 10) } : { dateTime: new Date(v).toISOString(), ...(ev.tz ? { timeZone: ev.tz } : {}) });
  const body = { summary: ev.title, location: ev.location || '', description: ev.description || '', start: t(ev.start), end: t(ev.end) };
  if (ev.rrule) body.recurrence = [`RRULE:${ev.rrule.replace(/^RRULE:/i, '')}`];
  return body;
}
function toOutlook(ev) {
  const t = (v) => ({ dateTime: ev.all_day ? `${v.slice(0, 10)}T00:00:00` : new Date(v).toISOString().replace('Z', ''), timeZone: 'UTC' });
  return { subject: ev.title, isAllDay: !!ev.all_day, location: { displayName: ev.location || '' }, body: { contentType: 'text', content: ev.description || '' }, start: t(ev.start), end: t(ev.end) };
}

// ---------- pull ----------
async function fetchRemote(cal, cfg, from, to) {
  if (cal.kind === 'ics') {
    const url = cfg.url.replace(/^webcal:/i, 'https:');
    const res = await fetch(url, { headers: { accept: 'text/calendar' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`ICS fetch failed: HTTP ${res.status}`);
    return parseICS(await res.text(), process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone).map((e) => ({
      ext_id: e.ext_id, title: e.title, start: e.start, end: e.end, all_day: e.all_day ? 1 : 0, tz: e.tz || null,
      location: e.location || null, description: e.description || null, rrule: e.rrule || null,
      exdates: e.exdates?.length ? JSON.stringify(e.exdates) : null,
    }));
  }
  const out = [];
  if (cal.kind === 'google') {
    let url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId || 'primary')}/events?` +
      new URLSearchParams({ singleEvents: 'true', maxResults: '2500', timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString() });
    for (let page = 0; page < 20; page++) {
      const j = await api(cfg, 'google', url);
      for (const e of j.items || []) if (e.status !== 'cancelled' && e.start) out.push(fromGoogle(e));
      if (!j.nextPageToken) break;
      url = url.replace(/&pageToken=[^&]*/, '') + `&pageToken=${encodeURIComponent(j.nextPageToken)}`;
    }
  } else if (cal.kind === 'outlook') {
    const base = cfg.calendarId ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(cfg.calendarId)}` : 'https://graph.microsoft.com/v1.0/me';
    let url = `${base}/calendarView?` + new URLSearchParams({
      startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $top: '500',
      $select: 'id,subject,start,end,isAllDay,location,bodyPreview,isCancelled',
    });
    for (let page = 0; page < 40 && url; page++) {
      const j = await api(cfg, 'outlook', url);
      for (const e of j.value || []) if (!e.isCancelled) out.push(fromOutlook(e));
      url = j['@odata.nextLink'];
    }
  }
  return out;
}

export async function syncCalendar(store, cal) {
  if (cal.kind === 'local') return { count: 0 };
  const { q, tx } = store;
  const cfg = JSON.parse(cal.config || '{}');
  const from = Date.now() - 90 * DAY, to = Date.now() + 400 * DAY;
  try {
    const remote = await fetchRemote(cal, cfg, from, to);
    const now = Date.now();
    tx(() => {
      const seen = new Set();
      for (const e of remote) {
        seen.add(e.ext_id);
        q(`INSERT INTO events(calendar_id, ext_id, title, start, end, all_day, tz, location, description, rrule, exdates, updated)
           VALUES (:cal, :ext_id, :title, :start, :end, :all_day, :tz, :location, :description, :rrule, :exdates, :now)
           ON CONFLICT(calendar_id, ext_id) DO UPDATE SET title = excluded.title, start = excluded.start, end = excluded.end,
             all_day = excluded.all_day, tz = excluded.tz, location = excluded.location, description = excluded.description,
             rrule = excluded.rrule, exdates = excluded.exdates, updated = excluded.updated`)
          .run({ cal: cal.id, now, rrule: null, exdates: null, ...e });
      }
      // Remove remote deletions (ICS feeds are complete; API pulls are windowed).
      const stale = cal.kind === 'ics'
        ? q('SELECT id, ext_id FROM events WHERE calendar_id = ?').all(cal.id)
        : q('SELECT id, ext_id FROM events WHERE calendar_id = ? AND end > ? AND start < ?').all(cal.id, new Date(from).toISOString(), new Date(to).toISOString());
      for (const r of stale) if (!seen.has(r.ext_id)) q('DELETE FROM events WHERE id = ?').run(r.id);
      delete cfg._dirty;
      q('UPDATE calendars SET last_sync = ?, sync_error = NULL, config = ? WHERE id = ?').run(now, JSON.stringify(cfg), cal.id);
    });
    return { count: remote.length };
  } catch (e) {
    if (cfg._dirty) { delete cfg._dirty; q('UPDATE calendars SET config = ? WHERE id = ?').run(JSON.stringify(cfg), cal.id); }
    q('UPDATE calendars SET sync_error = ?, last_sync = ? WHERE id = ?').run(String(e.message || e).slice(0, 500), Date.now(), cal.id);
    throw e;
  }
}

// List calendars available on a connected account (to pick a shared/family calendar).
export async function listRemoteCalendars(store, cal) {
  const cfg = JSON.parse(cal.config || '{}');
  try {
    if (cal.kind === 'google') {
      const j = await api(cfg, 'google', 'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer');
      return (j.items || []).map((c) => ({ id: c.primary ? 'primary' : c.id, name: c.summaryOverride || c.summary, primary: !!c.primary }));
    }
    if (cal.kind === 'outlook') {
      const j = await api(cfg, 'outlook', 'https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,isDefaultCalendar,canEdit');
      return (j.value || []).filter((c) => c.canEdit).map((c) => ({ id: c.isDefaultCalendar ? '' : c.id, name: c.name, primary: !!c.isDefaultCalendar }));
    }
    return [];
  } finally { saveCfg(store, cal, cfg); }
}

// ---------- push (two-way for Google / Outlook) ----------
function saveCfg(store, cal, cfg) { if (cfg._dirty) { delete cfg._dirty; store.q('UPDATE calendars SET config = ? WHERE id = ?').run(JSON.stringify(cfg), cal.id); } }

export async function pushEvent(store, cal, ev, extId) {
  if (cal.kind !== 'google' && cal.kind !== 'outlook') return extId || null;
  const cfg = JSON.parse(cal.config || '{}');
  try {
    if (cal.kind === 'google') {
      const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId || 'primary')}/events`;
      const r = extId
        ? await api(cfg, 'google', `${base}/${encodeURIComponent(extId)}`, { method: 'PATCH', body: JSON.stringify(toGoogle(ev)) })
        : await api(cfg, 'google', base, { method: 'POST', body: JSON.stringify(toGoogle(ev)) });
      return r.id;
    }
    const r = extId
      ? await api(cfg, 'outlook', `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(extId)}`, { method: 'PATCH', body: JSON.stringify(toOutlook(ev)) })
      : await api(cfg, 'outlook', cfg.calendarId ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(cfg.calendarId)}/events` : 'https://graph.microsoft.com/v1.0/me/events',
        { method: 'POST', body: JSON.stringify(toOutlook(ev)) });
    return r.id;
  } finally { saveCfg(store, cal, cfg); }
}

export async function deleteRemote(store, cal, extId) {
  if (!extId || (cal.kind !== 'google' && cal.kind !== 'outlook')) return;
  const cfg = JSON.parse(cal.config || '{}');
  try {
    if (cal.kind === 'google') {
      await api(cfg, 'google', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.calendarId || 'primary')}/events/${encodeURIComponent(extId)}`, { method: 'DELETE' });
    } else {
      await api(cfg, 'outlook', `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(extId)}`, { method: 'DELETE' });
    }
  } finally { saveCfg(store, cal, cfg); }
}
