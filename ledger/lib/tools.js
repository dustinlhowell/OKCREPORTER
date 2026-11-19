// Tools for the Claude app connector (MCP). Plain JSON Schemas; each tool validates its own input.
import { parseMoney, fmtMoney as $, monthLabel, isDate, isMonth, matchItem } from './budget.js';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

export function buildTools(d, user) {
  const findItem = (name, { income = false } = {}) => {
    if (!name) return null;
    const items = d.itemsFlat().filter((i) => !i.archived && (income ? true : i.kind !== 'income'));
    const n = String(name).toLowerCase().trim();
    return items.find((i) => i.name.toLowerCase() === n) || matchItem(name, items) || items.find((i) => i.name.toLowerCase().includes(n) || n.includes(i.name.toLowerCase())) || null;
  };
  const itemLine = (month, itemId) => {
    const v = d.monthView(month);
    for (const g of v.groups) for (const it of g.items) if (it.id === itemId)
      return g.kind === 'income' ? `${it.name}: ${$(it.spent)} received of ${$(it.planned)} planned` : `${it.name}: ${$(it.available)} left of ${$(it.planned + it.carry)}${it.available < 0 ? ' ⚠️ overspent' : ''}`;
    return '';
  };
  return [
    {
      name: 'log_transaction',
      description: 'Record money spent or received and file it under a budget category (envelope). Use for "I spent $40 at Costco on groceries", "paid the electric bill $120", "got paid $2,100". Category names are matched loosely; if unsure call list_categories first. Leave category empty if the user gave none – it goes to "Needs category".',
      inputSchema: { type: 'object', properties: {
        amount: num('Amount in dollars, positive (e.g. 42.5)'), payee: str('Store, person or source (e.g. "Costco")'),
        category: str('Budget category / envelope name, e.g. "Groceries"'), kind: { type: 'string', enum: ['expense', 'income', 'refund'], description: 'expense (default), income, or refund (money back into a category)' },
        date: str('YYYY-MM-DD, defaults to today'), note: str('Optional memo'), account: str('Account name, e.g. "Checking" or "Visa" (optional)'),
      }, required: ['amount'] },
      run: (a) => {
        const amount = parseMoney(a.amount);
        if (!(amount > 0)) throw new Error('amount must be a positive number');
        if (a.date && !isDate(a.date)) throw new Error('date must be YYYY-MM-DD');
        const kind = a.kind === 'income' ? 'income' : a.kind === 'refund' ? 'income' : 'expense';
        const item = a.category ? findItem(a.category, { income: kind === 'income' }) : (a.payee ? d.payeeItem(a.payee) : null);
        if (a.category && !item) throw new Error(`No category matches "${a.category}". Categories: ${d.itemsFlat().filter((i) => !i.archived).map((i) => i.name).join(', ')}`);
        const acct = a.account ? d.q('SELECT id FROM accounts WHERE lower(name) LIKE ? AND archived = 0').get(`%${String(a.account).toLowerCase()}%`) : null;
        const t = d.saveTxn(user.id, { date: a.date || d.today(), kind, amount, payee: a.payee || '', note: a.note || '', account_id: acct?.id, lines: [{ item_id: item?.id ?? null, amount }], source: 'claude' });
        const what = kind === 'income' ? (a.kind === 'refund' ? 'refund' : 'income') : 'expense';
        return `Logged ${what} ${$(amount)}${a.payee ? ` at ${a.payee}` : ''} on ${t.date}${item ? ` → ${item.name}` : ' → Needs category'}.${item ? ' ' + itemLine(t.date.slice(0, 7), item.id) : ''}`;
      },
    },
    {
      name: 'budget_status',
      description: 'How the budget is doing for a month: income, planned, spent, left to budget and every category\'s remaining amount. Pass category to ask about one envelope ("how much is left for restaurants?").',
      readOnly: true,
      inputSchema: { type: 'object', properties: { month: str('YYYY-MM, defaults to this month'), category: str('Optional category name') } },
      run: (a) => {
        const month = a.month && isMonth(a.month) ? a.month : d.today().slice(0, 7);
        if (a.category) { const it = findItem(a.category, { income: true }); if (!it) throw new Error(`No category matches "${a.category}"`); return `${monthLabel(month)} – ${itemLine(month, it.id)}`; }
        const v = d.monthView(month), s = v.summary;
        const lines = [`${monthLabel(month)}: income planned ${$(s.incomePlanned)} (received ${$(s.incomeReceived)}), budgeted ${$(s.planned)}, spent ${$(s.spent)}, left to budget ${$(s.leftToBudget)}.`];
        for (const g of v.groups) {
          if (g.kind === 'income') continue;
          lines.push(`\n${g.emoji} ${g.name}`);
          for (const it of g.items) lines.push(`- ${it.name}: ${$(it.available)} left (planned ${$(it.planned)}${it.carry ? `, carried ${$(it.carry)}` : ''}, spent ${$(it.spent)})${it.available < 0 ? ' ⚠️' : ''}`);
        }
        if (v.uncategorized.count) lines.push(`\n${v.uncategorized.count} transaction(s) need a category (${$(v.uncategorized.amount)}).`);
        return lines.join('\n');
      },
    },
    {
      name: 'list_categories',
      description: 'List budget groups and their categories (envelopes) with what is left this month.',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      run: () => d.monthView(d.today().slice(0, 7)).groups.map((g) => `${g.emoji} ${g.name}${g.kind === 'income' ? ' (income)' : ''}: ${g.items.map((i) => `${i.name} (${$(g.kind === 'income' ? i.spent : i.available)})`).join(', ')}`).join('\n'),
    },
    {
      name: 'recent_transactions',
      description: 'Recent transactions, optionally filtered by category or search text.',
      readOnly: true,
      inputSchema: { type: 'object', properties: { limit: num('How many (default 15, max 100)'), category: str('Category name'), search: str('Text in payee or note') } },
      run: (a) => {
        const it = a.category ? findItem(a.category, { income: true }) : null;
        const rows = d.listTxns({ item: it?.id, search: a.search, limit: Math.min(100, a.limit || 15) });
        if (!rows.length) return 'No transactions found.';
        return rows.map((t) => `${t.date} ${t.kind === 'income' ? '+' : '−'}${$(t.amount)} ${t.payee || '(no payee)'} → ${t.lines.map((l) => l.item_name || 'Needs category').join(', ')}${t.user_name ? ` (by ${t.user_name})` : ''}`).join('\n');
      },
    },
    {
      name: 'upcoming_bills',
      description: 'Bills, debt payments and paydays coming up (and anything overdue), with paid status.',
      readOnly: true,
      inputSchema: { type: 'object', properties: { days: num('Look-ahead in days (default 14)') } },
      run: (a) => {
        const list = d.upcoming(Math.min(120, a.days || 14));
        if (!list.length) return 'Nothing scheduled.';
        return list.map((b) => `${b.date} ${b.kind === 'income' ? '💵' : '🧾'} ${b.name} ${$(b.amount)} – ${b.status}${b.autopay ? ' (autopay)' : ''}`).join('\n');
      },
    },
    {
      name: 'debt_snowball',
      description: 'Debt snowball status: debts smallest balance first, balances, the monthly snowball amount, payoff month for each and the debt-free date.',
      readOnly: true,
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const s = d.debtSummary();
        if (!s.debts.length) return 'No debts are set up.';
        const lines = [`Total debt ${$(s.total)} (paid off so far ${$(s.paidTotal)}). Snowball: ${$(s.plan.budget)}/month (minimums + ${$(s.extra)} extra${s.freed ? ` + ${$(s.freed)} freed up from paid-off debts` : ''}). ${s.plan.debtFree ? `Debt-free: ${monthLabel(s.plan.debtFree)}.` : 'Not paid off within the projection – add more to the snowball.'}`];
        s.order.forEach((x, i) => lines.push(`${i + 1}. ${x.name}: ${$(x.current)} (min ${$(x.min_payment)}${x.due_day ? `, due the ${x.due_day}` : ''}) → paid off ${x.payoff ? monthLabel(x.payoff) : '—'}`));
        for (const x of s.debts.filter((x) => x.current <= 0)) lines.push(`✅ ${x.name} is paid off`);
        return lines.join('\n');
      },
    },
    {
      name: 'move_money',
      description: 'Move budgeted money from one category to another for a month (e.g. cover overspending in Restaurants from Fun money).',
      inputSchema: { type: 'object', properties: { from: str('Category to take money from'), to: str('Category to give money to'), amount: num('Dollars'), month: str('YYYY-MM, defaults to this month') }, required: ['from', 'to', 'amount'] },
      run: (a) => {
        const f = findItem(a.from), t = findItem(a.to), amt = parseMoney(a.amount);
        if (!f || !t) throw new Error(`Couldn't find ${!f ? a.from : a.to}`);
        if (!(amt > 0)) throw new Error('amount must be positive');
        const month = a.month && isMonth(a.month) ? a.month : d.today().slice(0, 7);
        d.moveMoney(user.id, month, f.id, t.id, amt);
        return `Moved ${$(amt)} from ${f.name} to ${t.name} for ${monthLabel(month)}. ${itemLine(month, f.id)}. ${itemLine(month, t.id)}.`;
      },
    },
  ];
}

// Minimal validation against the subset of JSON Schema used above.
export function validate(schema, args) {
  const a = args && typeof args === 'object' ? args : {};
  for (const k of schema.required || []) if (a[k] === undefined || a[k] === '') return `${k} is required`;
  for (const [k, s] of Object.entries(schema.properties || {})) {
    if (a[k] === undefined) continue;
    if (s.type === 'number' && !Number.isFinite(Number(String(a[k]).replace(/[$,]/g, '')))) return `${k} must be a number`;
    if (s.type === 'string' && typeof a[k] !== 'string') a[k] = String(a[k]);
    if (s.enum && !s.enum.includes(a[k])) return `${k} must be one of ${s.enum.join(', ')}`;
  }
  return null;
}
