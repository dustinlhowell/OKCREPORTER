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
