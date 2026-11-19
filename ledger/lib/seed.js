// Starter budget layout. Everything here can be renamed, recolored, reordered, archived or deleted.
// Colors follow the chart palette order so group colors stay distinguishable in reports.
export const GROUPS = [
  { name: 'Income', emoji: '💵', kind: 'income', color: '#1baf7a', items: [['Paycheck 1', '💼'], ['Paycheck 2', '💼'], ['Other income', '➕']] },
  { name: 'Giving', emoji: '🎁', color: '#e87ba4', items: [['Charity', '🤝'], ['Gifts', '🎁', { rollover: 1 }]] },
  { name: 'Savings', emoji: '🏦', color: '#008300', items: [['Emergency fund', '🛟', { rollover: 1, goal: 100000 }], ['Sinking funds', '🪣', { rollover: 1 }]] },
  { name: 'Housing', emoji: '🏠', color: '#2a78d6', items: [['Rent / Mortgage', '🏠', { due: 1 }], ['Electric', '💡'], ['Water', '🚰'], ['Gas / Heating', '🔥'], ['Internet', '🌐'], ['Phone', '📱'], ['Home maintenance', '🧰', { rollover: 1 }]] },
  { name: 'Transportation', emoji: '🚗', color: '#eb6834', items: [['Fuel', '⛽'], ['Car maintenance', '🔧', { rollover: 1 }], ['Car insurance', '🛡️'], ['Registration', '📄', { rollover: 1 }]] },
  { name: 'Food', emoji: '🍽️', color: '#eda100', items: [['Groceries', '🛒', { aliases: 'grocery,walmart,costco,aldi,kroger,heb,target' }], ['Restaurants', '🍔', { aliases: 'eating out,takeout,fast food,dinner,lunch' }], ['Coffee', '☕']] },
  { name: 'Personal', emoji: '🧍', color: '#6250d6', items: [['Clothing', '👕'], ['Hair / Personal care', '💇'], ['Subscriptions', '📺'], ['Fun money', '🎉']] },
  { name: 'Health', emoji: '🩺', color: '#e34948', items: [['Medical / Copays', '🩺', { rollover: 1 }], ['Pharmacy', '💊'], ['Gym', '🏋️']] },
  { name: 'Insurance', emoji: '🛡️', color: '#52514e', items: [['Health insurance', '🏥'], ['Life insurance', '❤️']] },
  { name: 'Debt', emoji: '⛓️', color: '#d95926', debt: true, items: [] },
];
export const ACCOUNTS = [['Checking', 'checking'], ['Savings', 'savings'], ['Cash', 'cash']];
