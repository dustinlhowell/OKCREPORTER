import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote, setField, setTask } from '../lib/parse.js';
import { expand } from '../lib/rrule.js';
import { parseICS, generateICS } from '../lib/ics.js';
import { zonedToUtc } from '../lib/time.js';

test('parseNote extracts links, tags, fields, tasks, cards', () => {
  const p = parseNote(`#cert #work/kb
status:: studying
See [[Other Note|alias]] and [[Third#Heading]].
- [ ] renew cert @2026-12-01 14:30
- [x] done thing
What is LRS? ?? Locally redundant storage
Q: Contributor role?
A: Everything but access
\`\`\`
#notatag [[notalink]]
\`\`\``);
  assert.deepEqual(p.links.sort(), ['other note', 'third']);
  assert.deepEqual(p.tags.sort(), ['cert', 'work/kb']);
  assert.equal(p.fields.status, 'studying');
  assert.equal(p.tasks.length, 2);
  assert.equal(p.tasks[0].due, '2026-12-01');
  assert.equal(p.tasks[0].time, '14:30');
  assert.equal(p.tasks[1].done, true);
  assert.equal(p.cards.length, 2);
});

test('setField updates, inserts and removes', () => {
  let c = '#cert\nstatus:: planning\n\nBody';
  c = setField(c, 'status', 'passed');
  assert.match(c, /status:: passed/);
  c = setField(c, 'score', '870');
  assert.equal(c.split('\n')[2], 'score:: 870');
  c = setField(c, 'score', '');
  assert.doesNotMatch(c, /score/);
  assert.equal(setTask('- [ ] a\n- [ ] b', 1, true), '- [ ] a\n- [x] b');
});

test('weekly rrule keeps wall-clock time across DST', () => {
  // 9:00 Chicago on Mondays, across the Nov 1 2026 DST change.
  const start = new Date(zonedToUtc(2026, 10, 19, 9, 0, 0, 'America/Chicago')).toISOString();
  const end = new Date(Date.parse(start) + 3600e3).toISOString();
  const occ = expand({ start, end, rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4', tz: 'America/Chicago' }, Date.parse('2026-10-01'), Date.parse('2027-01-01'));
  assert.equal(occ.length, 4);
  assert.equal(occ[0].start, '2026-10-19T14:00:00.000Z'); // CDT
  assert.equal(occ[2].start, '2026-11-02T15:00:00.000Z'); // CST
});

test('monthly by ordinal weekday and exdates', () => {
  const occ = expand({ start: '2026-01-13T18:00:00.000Z', end: '2026-01-13T19:00:00.000Z', rrule: 'FREQ=MONTHLY;BYDAY=2TU', tz: 'UTC', exdates: ['2026-03-10T18:00:00.000Z'] },
    Date.parse('2026-01-01'), Date.parse('2026-05-01'));
  assert.deepEqual(occ.map((o) => o.start.slice(0, 10)), ['2026-01-13', '2026-02-10', '2026-04-14']);
  const ad = expand({ start: '2026-02-28', end: '2026-03-01', all_day: 1, rrule: 'FREQ=YEARLY' }, Date.parse('2026-01-01'), Date.parse('2029-01-01'));
  assert.equal(ad.length, 3);
});

test('ICS round trip with TZID, all-day, overrides and folding', () => {
  const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Standup\\, daily\r\nDTSTART;TZID=America/New_York:20261116T090000\r\nDTEND;TZID=America/New_York:20261116T091500\r\nRRULE:FREQ=DAILY;COUNT=5\r\nBEGIN:VALARM\r\nSUMMARY:ignore\r\nEND:VALARM\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a\r\nRECURRENCE-ID;TZID=America/New_York:20261117T090000\r\nSUMMARY:Standup moved\r\nDTSTART;TZID=America/New_York:20261117T100000\r\nDTEND;TZID=America/New_York:20261117T101500\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Holi\r\n day\r\nDTSTART;VALUE=DATE:20261126\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  const ev = parseICS(ics);
  assert.equal(ev.length, 3);
  assert.equal(ev[0].title, 'Standup, daily');
  assert.equal(ev[0].start, '2026-11-16T14:00:00.000Z');
  assert.deepEqual(ev[0].exdates, ['2026-11-17T14:00:00.000Z']);
  assert.equal(ev[2].title, 'Holiday');
  assert.equal(ev[2].end, '2026-11-27');
  const out = generateICS('X', ev.map((e, i) => ({ ...e, uid: 'u' + i })));
  const back = parseICS(out);
  assert.equal(back.length, 3);
  assert.equal(back[0].start, ev[0].start);
  assert.match(out, /DTSTART;TZID=America\/New_York:20261116T090000/);
});

test('appendUnder adds to the end of a section, or creates it', async () => {
  const { appendUnder } = await import('../lib/tools.js');
  const doc = '## Focus\n- a\n\n## Inbox\n- 09:00 first\n\n## Log\n- x\n';
  assert.equal(appendUnder(doc, 'Inbox', '- 10:00 second'), '## Focus\n- a\n\n## Inbox\n- 09:00 first\n- 10:00 second\n\n## Log\n- x\n');
  assert.equal(appendUnder('## Focus\n- a\n', 'Inbox', '- t'), '## Focus\n- a\n\n## Inbox\n- t\n');
});

test('TOTP matches the RFC 6238 test vector and blocks replays', async () => {
  const { hotp, verifyTotp, base32Encode, newRecoveryCodes, useRecoveryCode } = await import('../lib/totp.js');
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(hotp(secret, 1), '287082');            // T = 59s
  assert.equal(hotp(secret, 37037036), '081804');     // T = 1111111109s
  const step = verifyTotp(secret, '287082', 0, 59000);
  assert.equal(step, 1);
  assert.equal(verifyTotp(secret, '287082', step, 59000), null); // same code can't be used twice
  const { codes, hashes } = newRecoveryCodes();
  const left = useRecoveryCode(hashes, codes[3].toUpperCase());
  assert.equal(left.length, 7);
  assert.equal(useRecoveryCode(left, codes[3]), null);
});

test('S3 SigV4 matches the AWS documentation examples; backups encrypt/decrypt', async () => {
  const { signV4, encrypt, decrypt } = await import('../lib/offsite.js');
  const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') };
  const get = signV4({ ...creds, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' } });
  assert.match(get.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  const list = signV4({ ...creds, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J' });
  assert.match(list.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
  const secret = Buffer.from('household data');
  const box = encrypt(secret, 'correct horse');
  assert.ok(!box.includes(secret));
  assert.equal(decrypt(box, 'correct horse').toString(), 'household data');
  assert.throws(() => decrypt(box, 'wrong'));
});

test('recurring tasks roll forward when completed', async () => {
  const { rollRecurring, parseNote } = await import('../lib/parse.js');
  const c = '## Chores\n- [x] Change HVAC filter @2026-11-15 @every 3 months\n- [ ] Water plants @every week\n';
  const out = rollRecurring(c, '2026-11-18');
  assert.equal(out, '## Chores\n- [x] Change HVAC filter @2026-11-15 @every 3 months ✅ 2026-11-18\n- [ ] Change HVAC filter @2027-02-15 @every 3 months\n- [ ] Water plants @every week\n');
  assert.equal(rollRecurring(out, '2026-11-18'), out); // already handled
  assert.match(rollRecurring('- [x] Pay rent @2026-01-31 🔁 every month', '2026-01-31'), /- \[ \] Pay rent @2026-02-28 🔁 every month$/);
  assert.match(rollRecurring('- [x] Backup check @every 2 weeks', '2026-11-18'), /- \[ \] Backup check @every 2 weeks @2026-12-02$/);
  assert.match(rollRecurring('- [x] Old chore @2026-01-01 @every week', '2026-11-18'), /- \[ \] Old chore @2026-11-19 @every week$/); // skips missed weeks
  assert.equal(parseNote('- [ ] Change filter @2027-02-15 @every 3 months').tasks[0].due, '2027-02-15');
});
