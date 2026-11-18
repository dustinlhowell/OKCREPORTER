// Time-based one-time passwords (RFC 6238 / RFC 4226) for two-step sign-in. Works with any authenticator app.
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
}

export const newSecret = () => base32Encode(randomBytes(20));
export const otpauthUri = (secret, account, issuer = 'Nexus') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// Returns the matched time step (to block replays), or null. Allows ±1 step of clock drift.
export function verifyTotp(secret, code, lastStep = 0, now = Date.now()) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= (lastStep || 0)) continue;
    const a = Buffer.from(hotp(secret, s)), b = Buffer.from(c);
    if (timingSafeEqual(a, b)) return s;
  }
  return null;
}

const hashCode = (c) => createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
export function newRecoveryCodes(n = 8) {
  const codes = Array.from({ length: n }, () => { const r = randomBytes(5).toString('hex'); return `${r.slice(0, 5)}-${r.slice(5)}`; });
  return { codes, hashes: codes.map(hashCode) };
}
// Returns the remaining hashes if the code matched one (it is used up), else null.
export function useRecoveryCode(hashes, code) {
  const h = hashCode(code);
  const i = (hashes || []).indexOf(h);
  return i < 0 ? null : hashes.filter((_, k) => k !== i);
}
