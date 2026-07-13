import BrandExpense from '../models/BrandExpense.js';
import MonthlyExpense from '../models/MonthlyExpense.js';
import { DEFAULT_USD_TO_EGP } from './brandExpenses.seed.js';
import { config } from '../config/index.js';

function usdToEgpRate() {
  const rate = Number(config.USD_TO_EGP);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_TO_EGP;
}

/** All brand OpEx is tracked in EGP. Legacy USD amounts are converted once. */
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

export async function listBrandExpenses({ kind, includeInactive = false } = {}) {
  const filter = includeInactive ? {} : { isActive: true };
  if (kind) filter.kind = kind;
  return BrandExpense.find(filter).sort({ sortOrder: 1, name: 1 });
}

function slugKey(name) {
  return String(name || 'expense')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || `expense-${Date.now()}`;
}

export async function createBrandExpense({ name, kind, amount, amountMin, amountMax, sortOrder }) {
  if (!name?.trim()) {
    const err = new Error('Name is required');
    err.statusCode = 400;
    throw err;
  }
  if (!['fixed', 'variable'].includes(kind)) {
    const err = new Error('kind must be fixed or variable');
    err.statusCode = 400;
    throw err;
  }
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric < 0) {
    const err = new Error('Amount must be a non-negative EGP number');
    err.statusCode = 400;
    throw err;
  }

  let key = slugKey(name);
  const clash = await BrandExpense.findOne({ key });
  if (clash) key = `${key}-${Date.now().toString(36)}`;

  return BrandExpense.create({
    key,
    name: name.trim(),
    kind,
    amount: numeric,
    amountMin: amountMin != null ? Number(amountMin) : undefined,
    amountMax: amountMax != null ? Number(amountMax) : undefined,
    currency: 'EGP',
    sortOrder: sortOrder ?? (kind === 'fixed' ? 50 : 200),
    isActive: true,
  });
}

export async function updateBrandExpense(id, patch) {
  const doc = await BrandExpense.findById(id);
  if (!doc || !doc.isActive) {
    const err = new Error('Expense not found');
    err.statusCode = 404;
    throw err;
  }

  if (patch.name != null) doc.name = String(patch.name).trim();
  if (patch.kind != null) {
    if (!['fixed', 'variable'].includes(patch.kind)) {
      const err = new Error('kind must be fixed or variable');
      err.statusCode = 400;
      throw err;
    }
    doc.kind = patch.kind;
  }
  if (patch.amount != null) {
    const numeric = Number(patch.amount);
    if (!Number.isFinite(numeric) || numeric < 0) {
      const err = new Error('Amount must be a non-negative EGP number');
      err.statusCode = 400;
      throw err;
    }
    doc.amount = numeric;
  }
  if (patch.amountMin !== undefined) doc.amountMin = patch.amountMin == null ? undefined : Number(patch.amountMin);
  if (patch.amountMax !== undefined) doc.amountMax = patch.amountMax == null ? undefined : Number(patch.amountMax);
  if (patch.sortOrder != null) doc.sortOrder = Number(patch.sortOrder);
  doc.currency = 'EGP';
  await doc.save();
  return doc;
}

export async function deleteBrandExpense(id) {
  const doc = await BrandExpense.findById(id);
  if (!doc || !doc.isActive) {
    const err = new Error('Expense not found');
    err.statusCode = 404;
    throw err;
  }
  doc.isActive = false;
  doc.deletedAt = new Date();
  await doc.save();
  return doc;
}

/**
 * Resolve effective lines for one calendar month.
 * Fixed: template amount (or monthly override) — auto-included in OpEx from day 1 of the month.
 * Variable: monthly entry only (else 0) — once saved, adds to total OpEx.
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
    const currency = 'EGP';
    const amountEgp = override
      ? toEgp(override.amountEgp ?? override.amount, override.currency || 'EGP')
      : isFixed
        ? toEgp(t.amount, t.currency)
        : 0;

    return {
      id: t._id,
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
  const total = fixedTotal + variableTotal;

  let revenue = 0;
  let deliveredCount = 0;
  try {
    const Order = (await import('../models/Order.js')).default;
    const [y, m] = yearMonth.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
    const to = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
    const orders = await Order.find({
      internalStatus: 'delivered',
      deliveredAt: { $gte: from, $lte: to },
    }).select('totalSellingPrice');
    deliveredCount = orders.length;
    revenue = orders.reduce((s, o) => s + (o.totalSellingPrice || 0), 0);
  } catch {
    // non-fatal
  }

  const expenseRatio = revenue > 0 ? Math.round((total / revenue) * 1000) / 10 : null;
  const insights = [];
  const missingVariable = lines.filter((l) => l.kind === 'variable' && !l.hasEntry).length;
  if (missingVariable > 0) {
    insights.push({
      tone: 'warning',
      title: `${missingVariable} variable costs not entered`,
      detail: `Fill actuals for ${yearMonth} so P&L net income is complete.`,
    });
  }
  if (expenseRatio != null && expenseRatio > 40) {
    insights.push({
      tone: 'danger',
      title: `Brand OpEx is ${expenseRatio}% of delivered revenue`,
      detail: 'Cut variable spend or grow delivered volume before adding fixed costs.',
    });
  } else if (expenseRatio != null && expenseRatio <= 25 && revenue > 0) {
    insights.push({
      tone: 'success',
      title: `Lean OpEx (${expenseRatio}% of revenue)`,
      detail: 'Fixed + variable costs are under control relative to deliveries.',
    });
  }
  if (fixedTotal > 0 && revenue > 0 && fixedTotal > revenue * 0.35) {
    insights.push({
      tone: 'warning',
      title: 'Fixed costs are high vs monthly revenue',
      detail: 'Avoid new fixed commitments until delivered sales cover overhead comfortably.',
    });
  }

  return {
    yearMonth,
    currency: 'EGP',
    lines,
    fixedTotal,
    variableTotal,
    total,
    context: { revenue, deliveredCount, expenseRatio },
    insights,
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

    const currency = 'EGP';
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
 * Fixed monthly costs are prorated by days in range / days in month.
 */
export async function getBrandExpensesForRange({ from, to } = {}) {
  const months = listYearMonthsInRange(from, to);
  const breakdowns = [];
  let fixedTotal = 0;
  let variableTotal = 0;

  const rangeStart = from ? new Date(from) : null;
  let rangeEnd = to ? new Date(to) : null;
  if (rangeEnd && String(to).length <= 10) {
    rangeEnd.setHours(23, 59, 59, 999);
  }

  for (const yearMonth of months) {
    const month = await getMonthExpenseBreakdown(yearMonth);
    breakdowns.push(month);

    const [y, m] = yearMonth.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);

    const overlapStart = rangeStart && rangeStart > monthStart ? rangeStart : monthStart;
    const overlapEnd = rangeEnd && rangeEnd < monthEnd ? rangeEnd : monthEnd;

    const startUtc = Date.UTC(overlapStart.getFullYear(), overlapStart.getMonth(), overlapStart.getDate());
    const endUtc = Date.UTC(overlapEnd.getFullYear(), overlapEnd.getMonth(), overlapEnd.getDate());
    const inclusiveDays = Math.max(1, Math.round((endUtc - startUtc) / 86400000) + 1);
    const fraction = Math.min(1, inclusiveDays / daysInMonth);

    fixedTotal += month.fixedTotal * fraction;
    variableTotal += month.variableTotal * fraction;
  }

  return {
    months,
    breakdowns,
    fixedTotal: Math.round(fixedTotal * 100) / 100,
    variableTotal: Math.round(variableTotal * 100) / 100,
    total: Math.round((fixedTotal + variableTotal) * 100) / 100,
    prorated: Boolean(from || to),
    currency: 'EGP',
  };
}

export default {
  listBrandExpenses,
  createBrandExpense,
  updateBrandExpense,
  deleteBrandExpense,
  getMonthExpenseBreakdown,
  saveMonthExpenses,
  getBrandExpensesForRange,
  toEgp,
  listYearMonthsInRange,
};
