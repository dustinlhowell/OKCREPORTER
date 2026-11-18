// Off-server backups: AES-256-GCM encryption + a minimal S3-compatible client (AWS Signature V4).
// Works with Backblaze B2, Cloudflare R2, Wasabi, AWS S3, MinIO… and/or a plain folder (another disk or share).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';

const MAGIC = Buffer.from('NXB1');
const deriveKey = (pass, salt) => scryptSync(String(pass), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

// Format: "NXB1" | salt(16) | iv(12) | ciphertext | tag(16)
export function encrypt(buf, pass) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  return Buffer.concat([MAGIC, salt, iv, c.update(buf), c.final(), c.getAuthTag()]);
}
export function decrypt(buf, pass) {
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not a Nexus encrypted backup');
  const salt = buf.subarray(4, 20), iv = buf.subarray(20, 32), tag = buf.subarray(buf.length - 16);
  const d = createDecipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(32, buf.length - 16)), d.final()]);
}

const sha256 = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
const uriEncode = (s, slash = true) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(slash ? /%2F/g : /$^/, '/');

// AWS Signature Version 4 for S3. Returns the headers to send.
export function signV4({ method, url, headers = {}, body = '', accessKeyId, secretAccessKey, region, service = 's3', date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = headers['x-amz-content-sha256'] || sha256(body);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(all).sort();
  const query = [...u.searchParams].map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, uriEncode(decodeURIComponent(u.pathname)), query, names.map((n) => `${n}:${all[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

export function s3Client({ endpoint, bucket, region = 'us-east-1', accessKeyId, secretAccessKey }) {
  const base = endpoint.replace(/\/$/, '');
  const objUrl = (key) => `${base}/${bucket}/${key.split('/').map((p) => uriEncode(p)).join('/')}`;
  const req = async (method, url, body) => {
    const headers = signV4({ method, url, body: body || '', headers: body ? { 'content-type': 'application/octet-stream' } : {}, accessKeyId, secretAccessKey, region });
    delete headers.host;
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(10 * 60000) });
    const text = method === 'GET' ? await res.text() : (await res.text().catch(() => ''));
    if (!res.ok) throw new Error(`S3 ${method} ${res.status}: ${(/<Message>([^<]*)/.exec(text) || [])[1] || text.slice(0, 160)}`);
    return text;
  };
  return {
    put: (key, buf) => req('PUT', objUrl(key), buf),
    del: (key) => req('DELETE', objUrl(key)),
    async list(prefix) {
      const keys = []; let token = '';
      for (let i = 0; i < 50; i++) {
        const u = new URL(`${base}/${bucket}`);
        u.searchParams.set('list-type', '2'); u.searchParams.set('prefix', prefix);
        if (token) u.searchParams.set('continuation-token', token);
        const xml = await req('GET', u.toString());
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&'));
        token = (/<NextContinuationToken>([^<]+)</.exec(xml) || [])[1];
        if (!token) break;
      }
      return keys;
    },
  };
}
