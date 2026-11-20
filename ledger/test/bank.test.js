import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as SF from '../lib/simplefin.js';
import * as INS from '../lib/insights.js';

test('bank descriptions become readable payee names', () => {
  const cases = {
    'POS DEBIT NETFLIX.COM 866-579-7172 CA 08/11': 'Netflix',
    'SQ *CHIPOTLE 1234 OKLAHOMA CITY OK': 'Chipotle',
    'COSTCO WHSE #0123 OKLAHOMA CITY OK': 'Costco',
    'TST* TORCHYS TACOS OKC OK': 'Torchys Tacos',
    'AMAZON MKTPL*2K4L19 Amzn.com/bill WA': 'Amazon',
    'WAL-MART #1234 EDMOND OK': 'Walmart',
    'OG&E ONLINE PMT 0000123': 'OG&E',
    'PLANET FITNESS #1123 OKLAHOMA CITY OK': 'Planet Fitness',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(SF.cleanPayee(raw), want, raw);
  assert.ok(SF.looksLikeTransfer('ONLINE TRANSFER TO CREDIT CARD XXXX4421'));
  assert.ok(SF.looksLikeTransfer('PAYMENT THANK YOU'));
  assert.equal(SF.guessKind('Visa Signature Credit Card'), 'credit');
  assert.equal(SF.guessKind('High Yield Savings'), 'savings');
});

test('setup token decoding, access URL auth and encryption at rest', () => {
  const tok = Buffer.from('https://beta-bridge.simplefin.org/simplefin/claim/ABC').toString('base64');
  assert.equal(SF.decodeSetupToken(tok), 'https://beta-bridge.simplefin.org/simplefin/claim/ABC');
  assert.throws(() => SF.decodeSetupToken('not a token'));
  const { base, auth } = SF.splitAccessUrl('https://user:p%40ss@bridge.example/simplefin');
  assert.equal(base, 'https://bridge.example/simplefin');
  assert.equal(auth, 'Basic ' + Buffer.from('user:p@ss').toString('base64'));
  const v = SF.makeVault(randomBytes(32));
  const sealed = v.seal('https://u:p@x/simplefin');
  assert.ok(!sealed.includes('u:p'));
  assert.equal(v.open(sealed), 'https://u:p@x/simplefin');
  assert.throws(() => SF.makeVault(randomBytes(32)).open(sealed)); // wrong key
});

test('fetchAccounts splits long ranges into windows and merges results', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    assert.ok(opts.headers.authorization.startsWith('Basic '));
    const u = new URL(url), s = +u.searchParams.get('start-date');
    return new Response(JSON.stringify({ errors: calls.length === 1 ? ['Bank X needs attention'] : [], accounts: [{ id: 'A', name: 'Chk', balance: '10.00', transactions: [{ id: `t${s}`, posted: s + 10, amount: '-1.00', description: 'x' }, { id: 'dup', posted: s + 20, amount: '-2', description: 'y' }] }] }));
  };
  const end = 1_800_000_000, start = end - 150 * 86400;
  const r = await SF.fetchAccounts('https://u:p@h/simplefin', { start, end, fetchImpl });
  assert.equal(calls.length, 3);
  assert.equal(r.accounts.length, 1);
  assert.equal(r.accounts[0].transactions.length, 4); // 3 windows + one deduplicated id
  assert.deepEqual(r.errors, ['Bank X needs attention']);
});

test('recurring-charge detection: cadence, steady amounts, price changes, stopped services', () => {
  const tx = []; let id = 1;
  const add = (payee, date, amount) => tx.push({ id: id++, payee, date, amount });
  for (const [d, a] of [['2026-08-03', 1549], ['2026-09-03', 1549], ['2026-10-03', 1549], ['2026-11-03', 1799]]) add('Netflix', d, a);
  for (const d of ['2026-09-05', '2026-09-19', '2026-10-03', '2026-10-17', '2026-10-31', '2026-11-14']) add('Lawn Guy', d, 4000);
  add('Costco', '2026-09-02', 18000); add('Costco', '2026-09-20', 4000); add('Costco', '2026-11-10', 25000); // irregular
  for (const d of ['2026-03-01', '2026-04-01', '2026-05-01']) add('Old Gym', d, 2500); // stopped
  add('Insurance Co', '2025-11-25', 60000); add('Insurance Co', '2026-11-24', 62000);
  const r = INS.detectRecurring(tx, '2026-11-20');
  const by = Object.fromEntries(r.map((x) => [x.payee, x]));
  assert.equal(by.Netflix.label, 'monthly');
  assert.ok(by.Netflix.subscription);
  assert.deepEqual(by.Netflix.change, { from: 1549, to: 1799, date: '2026-11-03' });
  assert.equal(by['Lawn Guy'].label, 'every 2 weeks');
  assert.equal(by['Insurance Co'].label, 'yearly');
  assert.ok(!by.Costco && !by['Old Gym']);
  assert.equal(by.Netflix.yearly, 1799 * 12);
});

test('double charges and unusual charges', () => {
  const t = [{ id: 1, payee: 'Torchys', date: '2026-11-17', amount: 6412 }, { id: 2, payee: 'Torchys', date: '2026-11-18', amount: 6412 }, { id: 3, payee: 'Torchys', date: '2026-11-30', amount: 6412 }];
  assert.equal(INS.findDuplicates(t, 2).length, 1);
  const hist = [1, 2, 3, 4].map((i) => ({ id: i, payee: 'Shell', amount: 4500 }));
  assert.ok(INS.isUnusual({ id: 9, payee: 'Shell', amount: 30000 }, hist, 0));
  assert.equal(INS.isUnusual({ id: 9, payee: 'Shell', amount: 5200 }, hist, 0), null);
  assert.ok(INS.isUnusual({ id: 9, payee: 'Best Buy', amount: 89900 }, hist, 50000));
});
