// Notification delivery: ntfy (push), Pushover (push) and email (SMTP). No dependencies.
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

export const smtpConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
export const pushoverConfigured = () => !!process.env.PUSHOVER_TOKEN;

// msg: { title, body, url?, priority?: 'low'|'default'|'high', tags?: [emoji shortcodes], html? }
export async function deliver(prefs, msg) {
  const n = prefs?.notify || {};
  const jobs = [];
  if (n.ntfy) jobs.push(['ntfy', sendNtfy(n.ntfy, n.ntfyToken, msg)]);
  if (n.pushover && pushoverConfigured()) jobs.push(['pushover', sendPushover(n.pushover, msg)]);
  if (n.email && smtpConfigured()) jobs.push(['email', sendMail({ to: n.email, subject: msg.title, text: msg.body + (msg.url ? `\n\n${msg.url}` : ''), html: msg.html })]);
  const results = await Promise.allSettled(jobs.map((j) => j[1]));
  return results.map((r, i) => ({ channel: jobs[i][0], ok: r.status === 'fulfilled', error: r.reason?.message }));
}
export const hasChannel = (prefs) => { const n = prefs?.notify || {}; return !!(n.ntfy || (n.pushover && pushoverConfigured()) || (n.email && smtpConfigured())); };

async function sendNtfy(url, token, msg) {
  if (!/^https?:\/\//.test(url)) throw new Error('ntfy address must start with https://');
  const headers = { Title: encodeHeader(msg.title), Priority: { low: '2', high: '4' }[msg.priority] || '3', Markdown: 'yes' };
  if (msg.tags?.length) headers.Tags = msg.tags.join(',');
  if (msg.url) headers.Click = msg.url;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: msg.body, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 120)}`);
}
// ntfy reads RFC 2047 encoded headers for non-ASCII titles.
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

async function sendPushover(userKey, msg) {
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ token: process.env.PUSHOVER_TOKEN, user: userKey, title: msg.title, message: msg.body.slice(0, 1024), priority: msg.priority === 'high' ? '1' : msg.priority === 'low' ? '-1' : '0', ...(msg.url ? { url: msg.url } : {}) }),
  });
  if (!res.ok) throw new Error(`Pushover ${res.status}: ${(await res.text()).slice(0, 120)}`);
}

// ---- minimal SMTP client (implicit TLS on 465, STARTTLS otherwise; AUTH PLAIN/LOGIN)
export async function sendMail({ to, subject, text, html }) {
  const host = process.env.SMTP_HOST, port = +(process.env.SMTP_PORT || 587), user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM, secure = port === 465 || process.env.SMTP_SECURE === '1';
  const insecure = process.env.SMTP_TLS_INSECURE === '1'; // for self-signed home mail servers only
  let sock = secure ? tls.connect({ host, port, servername: host, rejectUnauthorized: !insecure }) : net.connect({ host, port });
  sock.setTimeout(20000);
  let buf = '', waiter = null;
  const onData = (d) => { buf += d.toString('utf8'); pump(); };
  const pump = () => {
    if (!waiter) return;
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) { const reply = lines.slice(0, i + 1).join('\n'); buf = lines.slice(i + 1).join('\r\n'); const w = waiter; waiter = null; w(reply); return; }
    }
  };
  const read = () => new Promise((resolve, reject) => { waiter = resolve; sock.once('error', reject); sock.once('timeout', () => reject(new Error('SMTP timeout'))); pump(); });
  const cmd = async (line, expect) => {
    if (line !== null) sock.write(line + '\r\n');
    const reply = await read();
    if (!expect.some((c) => reply.startsWith(String(c)))) throw new Error(`SMTP: ${reply.split('\n').pop()}`);
    return reply;
  };
  sock.on('data', onData);
  await new Promise((r, j) => { sock.once(secure ? 'secureConnect' : 'connect', r); sock.once('error', j); });
  try {
    await cmd(null, [220]);
    const name = 'ledger.local';
    let ehlo = await cmd(`EHLO ${name}`, [250]);
    if (!secure && /STARTTLS/i.test(ehlo)) {
      await cmd('STARTTLS', [220]);
      sock.removeListener('data', onData);
      sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: !insecure });
      await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
      sock.on('data', onData); sock.setTimeout(20000);
      ehlo = await cmd(`EHLO ${name}`, [250]);
    } else if (!secure && user) throw new Error('SMTP server does not offer STARTTLS – refusing to send a password unencrypted');
    if (user) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo)) await cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235]);
      else { await cmd('AUTH LOGIN', [334]); await cmd(Buffer.from(user).toString('base64'), [334]); await cmd(Buffer.from(pass || '').toString('base64'), [235]); }
    }
    const addr = (s) => (/<([^>]+)>/.exec(s) || [null, s])[1].trim();
    await cmd(`MAIL FROM:<${addr(from)}>`, [250]);
    await cmd(`RCPT TO:<${addr(to)}>`, [250, 251]);
    await cmd('DATA', [354]);
    const b = 'ledger_' + randomBytes(8).toString('hex');
    const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
    const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
    const parts = [`--${b}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(text)}`];
    if (html) parts.push(`--${b}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(html)}`);
    const message = [`From: ${from}`, `To: ${to}`, `Subject: ${enc(subject)}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomBytes(12).toString('hex')}@ledger>`,
      'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${b}"`, '', ...parts, `--${b}--`, ''].join('\r\n');
    await cmd(message.replace(/^\./gm, '..') + '\r\n.', [250]);
    sock.write('QUIT\r\n');
  } finally { sock.end(); }
}
