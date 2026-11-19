import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../lib/budget.js';

test('months and dates', () => {
  assert.equal(B.addMonths('2026-11', 2), '2027-01');
  assert.equal(B.addMonths('2027-01', -1), '2026-12');
  assert.deepEqual(B.monthsBetween('2026-11', '2027-12').length, 14);
  assert.equal(B.lastDay('2027-02'), '2027-02-28');
  assert.equal(B.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(B.dayDiff('2026-11-01', '2026-12-01'), 30);
});

test('recurrence: monthly clamps to month end, biweekly, semimonthly, yearly, end date', () => {
  assert.deepEqual(B.occurrences({ freq: 'monthly', start: '2026-11-30', day: 31 }, '2027-01-01', '2027-03-31'), ['2027-01-31', '2027-02-28', '2027-03-31']);
  assert.deepEqual(B.occurrences({ freq: 'weekly', interval: 2, start: '2026-11-06' }, '2026-11-01', '2026-12-31'), ['2026-11-06', '2026-11-20', '2026-12-04', '2026-12-18']);
  assert.deepEqual(B.occurrences({ freq: 'weekly', interval: 2, start: '2026-11-06' }, '2027-01-10', '2027-01-31'), ['2027-01-15', '2027-01-29']);
  assert.deepEqual(B.occurrences({ freq: 'semimonthly', start: '2026-11-01', day: 1, day2: 15 }, '2026-11-10', '2026-12-31'), ['2026-11-15', '2026-12-01', '2026-12-15']);
  assert.deepEqual(B.occurrences({ freq: 'yearly', start: '2026-03-15' }, '2026-11-01', '2028-12-31'), ['2027-03-15', '2028-03-15']);
  assert.deepEqual(B.occurrences({ freq: 'monthly', start: '2026-11-05', end: '2027-01-05' }, '2026-11-01', '2027-12-31'), ['2026-11-05', '2026-12-05', '2027-01-05']);
  assert.deepEqual(B.occurrences({ freq: 'once', start: '2026-12-24' }, '2026-12-01', '2026-12-31'), ['2026-12-24']);
  assert.deepEqual(B.occurrences({ freq: 'monthly', interval: 3, start: '2026-11-10' }, '2026-11-01', '2027-06-30'), ['2026-11-10', '2027-02-10', '2027-05-10']);
});

test('money parsing', () => {
  assert.equal(B.parseMoney('$1,234.56'), 123456);
  assert.equal(B.parseMoney('(12.30)'), -1230);
  assert.equal(B.parseMoney(42.5), 4250);
  assert.ok(Number.isNaN(B.parseMoney('abc')));
  assert.equal(B.fmtMoney(-123456), '−$1,234.56');
});

test('envelopes: rollover carries leftovers and overspending; non-rollover resets', () => {
  const items = [{ id: 1, rollover: 1, kind: 'expense' }, { id: 2, rollover: 0, kind: 'expense' }, { id: 3, rollover: 0, kind: 'income' }];
  const M = (o) => new Map(Object.entries(o).map(([m, v]) => [m, new Map(Object.entries(v).map(([k, x]) => [+k, x]))]));
  const plans = M({ '2026-11': { 1: 10000, 2: 5000, 3: 300000 }, '2026-12': { 1: 10000, 2: 5000, 3: 300000 } });
  const spent = M({ '2026-11': { 1: 4000, 2: 7000, 3: 300000 }, '2026-12': { 1: 20000 } });
  const env = B.envelopes(items, plans, spent, ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(env.get('2026-11').get(1), { carry: 0, planned: 10000, spent: 4000, available: 6000 });
  assert.deepEqual(env.get('2026-12').get(1), { carry: 6000, planned: 10000, spent: 20000, available: -4000 });
  assert.equal(env.get('2027-01').get(1).carry, -4000);
  assert.equal(env.get('2026-12').get(2).carry, 0);
  const s = B.summarize(items, env.get('2026-11'));
  assert.equal(s.leftToBudget, 300000 - 15000);
  assert.equal(s.incomeReceived, 300000);
  assert.equal(s.overspent, 2000);
});

test('debt snowball: smallest balance first, minimums roll over, no interest', () => {
  const debts = [
    { id: 'car', name: 'Car', balance: 500000, min: 30000 },
    { id: 'cc', name: 'Card', balance: 50000, min: 5000 },
    { id: 'med', name: 'Medical', balance: 120000, min: 10000 },
  ];
  assert.deepEqual(B.snowballOrder(debts).map((d) => d.id), ['cc', 'med', 'car']);
  const p = B.snowball(debts, 15000, '2026-11');
  // Budget is constant: 300 + 50 + 100 + 150 extra = $600/month
  assert.equal(p.budget, 60000);
  assert.ok(p.months.every((m, i) => i === p.months.length - 1 || m.total === 60000));
  // Card gets min 50 + extra 150 + nothing else = 200/month -> paid in 3 months (Nov, Dec, Jan)
  assert.equal(p.payoff.cc, '2027-01');
  const total = debts.reduce((s, d) => s + d.balance, 0);
  assert.equal(p.months.reduce((s, m) => s + m.total, 0), total);
  assert.equal(p.debtFree, p.months.at(-1).month);
  assert.equal(p.totalMonths, Math.ceil(total / 60000));
  // Order of payoff is smallest-first
  assert.ok(p.payoff.cc <= p.payoff.med && p.payoff.med <= p.payoff.car);
  assert.equal(B.snowball([{ id: 1, balance: 100, min: 0 }], 0, '2026-11').stalled, true);
  // Already paid this month: the first month only gets what's left of the snowball.
  const q = B.snowball([{ id: 'a', balance: 10000, min: 5000 }, { id: 'b', balance: 50000, min: 10000 }], 5000, '2026-11', 600, { a: 15000 });
  assert.equal(q.budget, 20000);
  assert.deepEqual(q.months[0].payments, { b: 5000 });
  assert.equal(q.months[0].total, 20000);
});

test('quick entry parsing', () => {
  const items = [{ id: 1, name: 'Groceries', kind: 'expense', aliases: 'costco,walmart' }, { id: 2, name: 'Restaurants', kind: 'expense', aliases: 'eating out' }, { id: 3, name: 'Fuel', kind: 'expense' }, { id: 4, name: 'Paycheck 1', kind: 'income' }];
  let r = B.parseQuick('42.50 Costco groceries', items);
  assert.equal(r.amount, 4250); assert.equal(r.item.id, 1); assert.equal(r.payee, 'Costco');
  r = B.parseQuick('spent $18 at Chipotle on restaurants', items);
  assert.equal(r.amount, 1800); assert.equal(r.item.id, 2); assert.equal(r.payee, 'Chipotle');
  r = B.parseQuick('fuel 55 shell yesterday', items, () => null, '2026-11-19');
  assert.equal(r.item.id, 3); assert.equal(r.date, '2026-11-18'); assert.equal(r.payee, 'Shell');
  r = B.parseQuick('12 starbucks', items, (p) => (p === 'Starbucks' ? items[1] : null));
  assert.equal(r.item.id, 2);
  r = B.parseQuick('+2,150 paycheck 1', items);
  assert.equal(r.kind, 'income'); assert.equal(r.amount, 215000); assert.equal(r.item.id, 4);
  assert.ok(Number.isNaN(B.parseQuick('groceries', items).amount));
});

test('csv parsing and column guessing', () => {
  const rows = B.parseCSV('Date,Description,Amount\r\n11/03/2026,"COSTCO #123, OKC",-123.45\n2026-11-04,Payroll,2100\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], 'COSTCO #123, OKC');
  assert.deepEqual(B.guessColumns(rows[0]), { date: 0, payee: 1, amount: 2, debit: -1, credit: -1 });
  assert.equal(B.parseDate('11/3/26'), '2026-11-03');
  assert.equal(B.parseDate('2026-11-04'), '2026-11-04');
});
