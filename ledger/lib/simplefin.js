// SimpleFIN Bridge client (https://www.simplefin.org/protocol.html) and bank-description cleanup.
// Flow: the user pastes a Setup Token (base64 of a one-time claim URL); we POST to it once and receive an
// Access URL (https://user:pass@host/path). Ledger stores that encrypted and reads /accounts with it. Read-only.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const UA = 'Ledger-budget/1.0 (self-hosted)';

export function decodeSetupToken(tok) {
  const s = String(tok || '').trim().replace(/\s+/g, '');
  if (!s) throw new Error('Paste the setup token from SimpleFIN Bridge');
  let url;
  try { url = Buffer.from(s, 'base64').toString('utf8').trim(); } catch { url = ''; }
  if (!(/^https:\/\/\S+$/.test(url) || (process.env.SIMPLEFIN_INSECURE_TEST === '1' && /^http:\/\/\S+$/.test(url)))) throw new Error('That doesn’t look like a SimpleFIN setup token – copy the whole token from bridge.simplefin.org → Connect an app');
  return url;
}
export async function claim(setupToken, { fetchImpl = fetch } = {}) {
  const url = decodeSetupToken(setupToken);
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-length': '0', 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  const body = (await res.text()).trim();
  if (res.status === 403) throw new Error('This setup token was already used or has expired. In SimpleFIN Bridge, create a new token for Ledger and paste it again.');
  if (!res.ok) throw new Error(`SimpleFIN claim failed (${res.status}): ${body.slice(0, 160)}`);
  if (!/^https?:\/\/[^:\s]+:[^@\s]+@\S+$/.test(body)) throw new Error('SimpleFIN returned an unexpected access URL');
  return body;
}
// Node's fetch refuses credentials embedded in URLs, so split them into a Basic auth header.
export function splitAccessUrl(access) {
  const u = new URL(access);
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  u.username = ''; u.password = '';
  return { base: u.toString().replace(/\/$/, ''), auth };
}
// Fetch accounts + transactions between two dates (unix seconds). SimpleFIN limits each request to ~90 days,
// so longer ranges are fetched in windows and merged.
export async function fetchAccounts(access, { start, end = Math.floor(Date.now() / 1000), pending = false, balancesOnly = false, fetchImpl = fetch } = {}) {
  const { base, auth } = splitAccessUrl(access);
  const WINDOW = 60 * 86400;
  const accounts = new Map(), errors = [];
  let from = start ?? end - 30 * 86400;
  do {
    const to = Math.min(end, from + WINDOW);
    const q = new URLSearchParams({ 'start-date': String(from), 'end-date': String(to) });
    if (pending) q.set('pending', '1');
    if (balancesOnly) q.set('balances-only', '1');
    const res = await fetchImpl(`${base}/accounts?${q}`, { headers: { authorization: auth, 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
    if (res.status === 403) throw Object.assign(new Error('SimpleFIN refused access – the connection was revoked or the access key is wrong. Reconnect in Settings → Bank sync.'), { revoked: true });
    if (res.status === 402) throw new Error('SimpleFIN says the subscription needs payment – check bridge.simplefin.org.');
    if (!res.ok) throw new Error(`SimpleFIN ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    for (const e of [...(data.errors || []), ...(data.errlist || [])]) { const m = typeof e === 'string' ? e : e?.msg || e?.message || JSON.stringify(e); if (m && !errors.includes(m)) errors.push(m); }
    for (const a of data.accounts || []) {
      const prev = accounts.get(a.id);
      if (!prev) accounts.set(a.id, { ...a, transactions: [...(a.transactions || [])] });
      else { prev.transactions.push(...(a.transactions || [])); Object.assign(prev, { balance: a.balance, 'available-balance': a['available-balance'], 'balance-date': a['balance-date'] }); }
    }
    from = to;
  } while (from < end);
  for (const a of accounts.values()) { const seen = new Set(); a.transactions = a.transactions.filter((t) => !seen.has(t.id) && seen.add(t.id)); }
  return { accounts: [...accounts.values()], errors };
}

// ---- making bank descriptions readable: "POS DEBIT 1234 COSTCO WHSE #0123 OKLAHOMA CITY OK" -> "Costco Whse"
const PREFIX = /^(?:(?:(?:pos|dbt|debit|purchase|recurring|checkcard|check card|visa|mc|dda|ach|ppd|web|ccd|card|chk|pmnt|pre-?auth(?:orized)?|pending|point of sale|withdrawal|electronic|mobile|bill ?pay|signature|pin|contactless|apple pay|google pay)\b|(?:sq|tst|sp|pp|paypal|in|py|dd|sqc|bt)\s?\*)[\s:*#-]*)+/i;
const TAIL = /\s+(?:(?:[A-Z][a-z]+|[A-Z]+)\s?)?(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\s+\d{5})?$/;
// Big merchants whose bank descriptions vary a lot.
const KNOWN = [[/^(?:amazon|amzn)\b|amzn\.com/i, 'Amazon'], [/^apple\.com|^apple ?\/? ?bill|itunes/i, 'Apple'], [/^wal-?mart|^wm supercenter/i, 'Walmart'], [/^qt\b|quiktrip/i, 'QuikTrip'],
  [/^google\s*\*?\s*(?:youtube|yt)/i, 'YouTube'], [/^google/i, 'Google'], [/^uber\s*\*?\s*eats/i, 'Uber Eats'], [/^uber\b/i, 'Uber'], [/^doordash|^dd \*?doordash/i, 'DoorDash'],
  [/^target\b/i, 'Target'], [/^starbucks/i, 'Starbucks'], [/^mcdonald/i, "McDonald's"], [/^chick-?fil-?a/i, 'Chick-fil-A'], [/^sonic\b/i, 'Sonic'], [/^7-?eleven/i, '7-Eleven'],
  [/^netflix/i, 'Netflix'], [/^spotify/i, 'Spotify'], [/^hulu/i, 'Hulu'], [/^disney ?plus|^disney\+/i, 'Disney+']];
const SMALL = new Set(['and', 'of', 'the', 'at', 'for', 'to', 'in', 'on']);
const KEEP_UPPER = new Set(['ATT', 'AT&T', 'HEB', 'CVS', 'QT', 'IHOP', 'USPS', 'UPS', 'DMV', 'OG&E', 'ONG', 'OKC', 'TJ', 'BP', 'KFC', 'HBO', 'IRS', 'USAA', 'AMC', 'H&M', 'IKEA', 'ATM']);
export function cleanPayee(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(PREFIX, '');
  for (const [re, name] of KNOWN) if (re.test(s)) return name;
  s = s.replace(/\*\S*/g, ' ').replace(/\/bill\b/gi, ' ');                // "MKTPL*2K4L19", ".com/bill"

  s = s.replace(/(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, ' ')    // phone numbers
    .replace(/\b(?:x+|\*+)\d{2,}\b/gi, ' ')                 // masked card numbers
    .replace(/\b\d{2}\/\d{2}(?:\/\d{2,4})?\b/g, ' ')            // dates
    .replace(/\b(?:ref|id|conf|trace|seq|auth|ppd id|web id|card)[#:.\s]*[A-Z0-9-]{4,}\b/gi, ' ')
    .replace(/#\s*\d+/g, ' ')                                   // store numbers
    .replace(/(^|\s)\d{3,}\b/g, ' ')                           // store numbers / long digit runs
    .replace(/\s+[A-Z0-9]{8,}$/g, '')                           // trailing reference codes
    .replace(/https?:\/\/\S+|www\.\S+/gi, (m) => m.replace(/^https?:\/\/(www\.)?|^www\./i, ''))
    .replace(/\s{2,}/g, ' ').trim();
  for (let i = 0; i < 2; i++) s = s.replace(TAIL, '').trim();
  s = s.replace(/\s+(?:usa|us|inc|llc|co)$/i, '').replace(/^(\S+)\.(?:com|net)\b/i, '$1').replace(/\s+(?:whse|wholesale|supercenter|store|stores)\b/gi, '').trim();
  s = s.replace(/[*#\-:,.\s]+$/g, '').replace(/^[*#\-:,.\s]+/g, '');
  if (!s) s = String(raw).trim();
  return s.split(' ').map((w, i) => {
    if (KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase();
    if (/\.(com|net|org)$/i.test(w)) return w.toLowerCase().replace(/^./, (c) => c.toUpperCase());
    const l = w.toLowerCase();
    return i && SMALL.has(l) ? l : l.replace(/(^|[-'&/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }).join(' ').slice(0, 80);
}
export const payeeKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const looksLikeTransfer = (s) => /\b(transfer|xfer|trnsfr|payment|pmt|pymt|autopay|auto pay|epay|e-pay|online banking|to sav|from sav|to chk|from chk|thank you)\b/i.test(String(s || ''));
export function guessKind(name, org = '') {
  const s = `${name} ${org}`.toLowerCase();
  if (/credit|card|visa|mastercard|amex|discover|platinum|rewards/.test(s)) return 'credit';
  if (/sav|money market|mma|reserve/.test(s)) return 'savings';
  return 'checking';
}

// ---- encryption at rest for the access URL (key lives in DATA_DIR/secret.key, never in the database or backups)
export function makeVault(key) {
  return {
    seal: (text) => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]); return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`; },
    open: (blob) => { const b = Buffer.from(String(blob).replace(/^v1:/, ''), 'base64'); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); },
  };
}
