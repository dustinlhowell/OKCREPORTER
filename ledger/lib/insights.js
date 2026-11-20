// Rocket-Money-style analysis over transaction history: recurring-charge detection, subscriptions,
// price changes, duplicate and unusual charges. Pure functions (dates 'YYYY-MM-DD', money in cents).
import { dayDiff, addDays } from './budget.js';

const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)) : 0; };

const FREQS = [
  { freq: 'weekly', interval: 1, days: 7, lo: 5, hi: 9, perYear: 52 },
  { freq: 'weekly', interval: 2, days: 14, lo: 12, hi: 16, perYear: 26 },
  { freq: 'monthly', interval: 1, days: 30, lo: 26, hi: 35, perYear: 12 },
  { freq: 'monthly', interval: 3, days: 91, lo: 83, hi: 100, perYear: 4 },
  { freq: 'yearly', interval: 1, days: 365, lo: 350, hi: 380, perYear: 1 },
];
export const freqLabel = (f) => (f.freq === 'weekly' ? (f.interval === 2 ? 'every 2 weeks' : 'weekly') : f.freq === 'monthly' ? (f.interval === 3 ? 'quarterly' : 'monthly') : 'yearly');

const SUBS = /netflix|spotify|hulu|disney|apple\.com|apple ?(?:music|tv|one|arcade)|icloud|google (?:one|storage|play)|youtube|prime video|amazon prime|audible|kindle|adobe|microsoft|xbox|playstation|nintendo|steam|peacock|paramount|\bmax\b|hbo|sling|fubo|crunchyroll|patreon|onlyfans|siriusxm|pandora|tidal|dropbox|chatgpt|openai|anthropic|claude|github|notion|canva|grammarly|nordvpn|expressvpn|surfshark|1password|lastpass|ring|nest|planet fitness|gym|fitness|peloton|weight ?watchers|noom|calm|headspace|duolingo|hello ?fresh|blue apron|factor|dashpass|doordash|uber ?one|instacart|walmart\+|shipt|ancestry|match\.com|bumble|tinder|ipsy|birchbox|dollar shave|chewy|barkbox|norton|mcafee|zoom|linkedin|nyt|new york times|wsj|washington post|substack|medium|masterclass|skillshare|coursera/i;
export const isSubscriptionName = (s) => SUBS.test(String(s || ''));

// Where to cancel common services (otherwise a web search link is offered).
export const CANCEL = [
  [/netflix/i, 'https://www.netflix.com/cancelplan'], [/spotify/i, 'https://www.spotify.com/account/subscription/'], [/hulu/i, 'https://secure.hulu.com/account'],
  [/disney/i, 'https://www.disneyplus.com/account'], [/apple|icloud/i, 'https://support.apple.com/en-us/118428'], [/youtube/i, 'https://www.youtube.com/paid_memberships'],
  [/google/i, 'https://play.google.com/store/account/subscriptions'], [/amazon prime|prime video/i, 'https://www.amazon.com/mc'], [/audible/i, 'https://www.audible.com/account/overview'],
  [/adobe/i, 'https://account.adobe.com/plans'], [/microsoft|xbox/i, 'https://account.microsoft.com/services'], [/playstation/i, 'https://www.playstation.com/en-us/support/subscriptions/cancel-playstation-plus/'],
  [/peacock/i, 'https://www.peacocktv.com/account'], [/paramount/i, 'https://www.paramountplus.com/account/'], [/\bmax\b|hbo/i, 'https://www.max.com/account'],
  [/siriusxm/i, 'https://care.siriusxm.com/'], [/dropbox/i, 'https://www.dropbox.com/account/plan'], [/chatgpt|openai/i, 'https://chatgpt.com/#settings/Subscription'],
  [/planet fitness/i, 'https://www.planetfitness.com/about-planet-fitness/customer-service'], [/peloton/i, 'https://members.onepeloton.com/preferences/subscriptions'],
  [/doordash|dashpass/i, 'https://www.doordash.com/dashpass/manage'], [/uber/i, 'https://www.uber.com/us/en/u/uber-one/'], [/instacart/i, 'https://www.instacart.com/store/account/instacart-plus'],
  [/walmart/i, 'https://www.walmart.com/plus/account'], [/paypal/i, 'https://www.paypal.com/myaccount/autopay/'],
];
export const cancelUrl = (name) => CANCEL.find(([re]) => re.test(name))?.[1] || `https://www.google.com/search?q=${encodeURIComponent(`how to cancel ${name}`)}`;

// txns: [{ id, date, amount, payee, item_id }] (expenses only). Returns recurring candidates, newest first.
export function detectRecurring(txns, today, { minCount = 2 } = {}) {
  const groups = new Map();
  for (const t of txns) {
    const k = String(t.payee || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!k) continue;
    (groups.get(k) || groups.set(k, []).get(k)).push(t);
  }
  const out = [];
  for (const [key, list] of groups) {
    const ts = list.sort((a, b) => a.date.localeCompare(b.date));
    // Collapse multiple charges on the same day (split shipments etc.) so intervals stay meaningful.
    const days = []; for (const t of ts) { const last = days.at(-1); if (last && last.date === t.date) { last.amount += t.amount; last.ids.push(t.id); } else days.push({ ...t, ids: [t.id] }); }
    if (days.length < minCount) continue;
    const gaps = days.slice(1).map((t, i) => dayDiff(days[i].date, t.date));
    const g = median(gaps);
    const f = FREQS.find((x) => g >= x.lo && g <= x.hi);
    if (!f) continue;
    // At least 2/3 of the gaps must fit the cadence, and amounts must be steady (within 25% of the median).
    const fit = gaps.filter((x) => x >= f.lo && x <= f.hi).length;
    if (fit < Math.max(1, Math.ceil(gaps.length * 2 / 3))) continue;
    const amounts = days.map((t) => t.amount), mAmt = median(amounts);
    const steady = amounts.filter((a) => Math.abs(a - mAmt) <= Math.max(100, mAmt * 0.25)).length;
    if (steady < Math.ceil(amounts.length * 2 / 3)) continue;
    // Too few points for slow cadences is fine (yearly needs 2); weekly with only 2 points is noise.
    if (f.days <= 14 && days.length < 3) continue;
    const last = days.at(-1), prev = days.at(-2);
    const next = addDays(last.date, f.days);
    if (dayDiff(next, today) > f.days * 0.75) continue; // stopped: a full cycle overdue
    const change = prev && Math.abs(last.amount - prev.amount) >= Math.max(50, prev.amount * 0.01) ? { from: prev.amount, to: last.amount, date: last.date } : null;
    out.push({ key, payee: last.payee, freq: f.freq, interval: f.interval, label: freqLabel(f), perYear: f.perYear, amount: last.amount, typical: mAmt, count: days.length,
      first: days[0].date, last: last.date, next, item_id: last.item_id ?? null, monthly: Math.round(last.amount * f.perYear / 12), yearly: last.amount * f.perYear,
      subscription: isSubscriptionName(last.payee), change, ids: ts.map((t) => t.id) });
  }
  return out.sort((a, b) => b.yearly - a.yearly);
}

// Same payee and amount within `days` days – a likely double charge. Returns pairs [older, newer].
export function findDuplicates(txns, days = 2) {
  const out = [], s = [...txns].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length && dayDiff(s[i].date, s[j].date) <= days; j++)
    if (s[i].amount === s[j].amount && String(s[i].payee).toLowerCase() === String(s[j].payee).toLowerCase() && s[i].amount >= 500) out.push([s[i], s[j]]);
  return out;
}
// A charge that is much bigger than usual for that payee (needs 3+ past charges), or above an absolute threshold.
export function isUnusual(t, history, threshold) {
  const past = history.filter((h) => h.id !== t.id && String(h.payee).toLowerCase() === String(t.payee).toLowerCase()).map((h) => h.amount);
  if (past.length >= 3) { const m = median(past); if (t.amount > Math.max(m * 2.5, m + 5000)) return { reason: `about ${Math.round(t.amount / m)}× the usual ${(m / 100).toFixed(2)}`, typical: m }; }
  if (threshold && t.amount >= threshold) return { reason: 'large charge' };
  return null;
}
