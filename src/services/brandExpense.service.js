import BrandExpense from '../models/BrandExpense.js';
import MonthlyExpense from '../models/MonthlyExpense.js';
import { DEFAULT_USD_TO_EGP } from './brandExpenses.seed.js';
import { config } from '../config/index.js';

function usdToEgpRate() {
  const rate = Number(config.USD_TO_EGP);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_TO_EGP;
}

export function toEgp(amount, currency = 'EGP') {
  const n = Number(amount) || 0;
  if (currency === 'USD') return Math.round(n * usdToEgpRate() * 100) / 100;
  return n;
}

export function listYearMonthsInRange(from, to) {
  const parse = (value) => {
    if (!value) return null;
    const m = String(value).match(/^(\d{4})-(\d{2})/);
    if (!m) return null;
    return { y: Number(m[1]), m: Number(m[2]) };
  };

  const start = parse(from) || parse(to);
  const end = parse(to) || parse(from);
  if (!start || !end) {
    const now = new Date();
    return [`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`];
  }

  const months = [];
  let y = start.y;
  let m = start.m;
  while (y < end.y || (y === end.y && m <= end.m)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

export async function listBrandExpenses({ kind } = {}) {
  const filter = { isActive: true };
  if (kind) filter.kind = kind;
  return BrandExpense.find(filter).sort({ sortOrder: 1, name: 1 });
}

/**
 * Resolve effective lines for one calendar month.
 * Fixed: template amount (or monthly override). Variable: monthly entry only (else 0).
 */
export async function getMonthExpenseBreakdown(yearMonth) {
  const templates = await listBrandExpenses();
  const entries = await MonthlyExpense.find({ yearMonth });
  const byKey = Object.fromEntries(entries.map((e) => [e.expenseKey, e]));

  const lines = templates.map((t) => {
    const override = byKey[t.key];
    const isFixed = t.kind === 'fixed';
    const amount = override
      ? override.amount
      : isFixed
        ? t.amount
        : 0;
    const currency = override?.currency || t.currency;
    const amountEgp = override
      ? override.amountEgp
      : isFixed
        ? toEgp(t.amount, t.currency)
        : 0;

    return {
      key: t.key,
      name: t.name,
      kind: t.kind,
      amount,
      currency,
      amountEgp,
      amountMin: t.amountMin,
      amountMax: t.amountMax,
      defaultAmount: t.amount,
      hasEntry: Boolean(override),
      note: override?.note || '',
    };
  });

  const fixedTotal = lines.filter((l) => l.kind === 'fixed').reduce((s, l) => s + l.amountEgp, 0);
  const variableTotal = lines.filter((l) => l.kind === 'variable').reduce((s, l) => s + l.amountEgp, 0);

  return {
    yearMonth,
    usdToEgp: usdToEgpRate(),
    lines,
    fixedTotal,
    variableTotal,
    total: fixedTotal + variableTotal,
  };
}

export async function saveMonthExpenses(yearMonth, items, userId) {
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    const err = new Error('yearMonth must be YYYY-MM');
    err.statusCode = 400;
    throw err;
  }

  const templates = await listBrandExpenses();
  const templateMap = Object.fromEntries(templates.map((t) => [t.key, t]));
  const saved = [];

  for (const item of items || []) {
    const template = templateMap[item.expenseKey];
    if (!template) {
      const err = new Error(`Unknown expense: ${item.expenseKey}`);
      err.statusCode = 400;
      throw err;
    }

    const amount = Number(item.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      const err = new Error(`Invalid amount for ${item.expenseKey}`);
      err.statusCode = 400;
      throw err;
    }

    const currency = item.currency || template.currency || 'EGP';
    const amountEgp = toEgp(amount, currency);

    const doc = await MonthlyExpense.findOneAndUpdate(
      { yearMonth, expenseKey: item.expenseKey },
      {
        $set: {
          amount,
          currency,
          amountEgp,
          note: item.note || '',
          createdBy: userId,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    saved.push(doc);
  }

  return getMonthExpenseBreakdown(yearMonth);
}

/**
 * Sum brand expenses across months overlapping [from, to].
 */
export async function getBrandExpensesForRange({ from, to } = {}) {
  const months = listYearMonthsInRange(from, to);
  const breakdowns = [];
  let fixedTotal = 0;
  let variableTotal = 0;

  for (const yearMonth of months) {
    const month = await getMonthExpenseBreakdown(yearMonth);
    breakdowns.push(month);
    fixedTotal += month.fixedTotal;
    variableTotal += month.variableTotal;
  }

  return {
    months,
    breakdowns,
    fixedTotal,
    variableTotal,
    total: fixedTotal + variableTotal,
    usdToEgp: usdToEgpRate(),
  };
}

export default {
  listBrandExpenses,
  getMonthExpenseBreakdown,
  saveMonthExpenses,
  getBrandExpensesForRange,
  toEgp,
  listYearMonthsInRange,
};
