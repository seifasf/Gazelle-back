import GLAccount from '../models/GLAccount.js';
import JournalEntry from '../models/JournalEntry.js';
import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import { getAccountByCode } from './chartOfAccounts.seed.js';
import logger from '../utils/logger.js';

export async function listAccounts({ category, activeOnly = true } = {}) {
  const filter = {};
  if (category) filter.category = category;
  if (activeOnly) filter.isActive = true;
  return GLAccount.find(filter).sort({ code: 1 });
}

export async function createAccount(data) {
  return GLAccount.create(data);
}

export async function updateAccount(id, data) {
  return GLAccount.findByIdAndUpdate(id, data, { new: true, runValidators: true });
}

export async function listJournalEntries({ from, to, limit = 50, skip = 0 } = {}) {
  const filter = {};
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }

  const [entries, total] = await Promise.all([
    JournalEntry.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('lines.accountId', 'code name category')
      .populate('createdBy', 'name'),
    JournalEntry.countDocuments(filter),
  ]);
  return { entries, total };
}

export async function createJournalEntry({ date, description, reference, lines, createdBy, source = 'manual' }) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    const err = new Error('Journal entry must balance (debits = credits)');
    err.statusCode = 400;
    throw err;
  }

  return JournalEntry.create({
    date: date || new Date(),
    description,
    reference,
    source,
    createdBy,
    lines,
  });
}

export async function getProfitAndLoss({ from, to } = {}) {
  const filter = {};
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }

  const entries = await JournalEntry.find(filter).populate('lines.accountId', 'code name category type');
  const byCategory = { revenue: 0, cogs: 0, expense: 0 };

  for (const entry of entries) {
    for (const line of entry.lines) {
      const cat = line.accountId?.category;
      if (!cat || !byCategory[cat]) continue;
      byCategory[cat] += (line.credit || 0) - (line.debit || 0);
    }
  }

  const grossProfit = byCategory.revenue - byCategory.cogs;
  const netIncome = grossProfit - byCategory.expense;

  return {
    revenue: byCategory.revenue,
    cogs: byCategory.cogs,
    expenses: byCategory.expense,
    grossProfit,
    netIncome,
  };
}

export async function getBalanceSheet() {
  const entries = await JournalEntry.find().populate('lines.accountId', 'code name category type');
  const balances = {};

  for (const entry of entries) {
    for (const line of entry.lines) {
      const acc = line.accountId;
      if (!acc) continue;
      const id = String(acc._id);
      if (!balances[id]) {
        balances[id] = { account: acc, debit: 0, credit: 0, balance: 0 };
      }
      balances[id].debit += line.debit || 0;
      balances[id].credit += line.credit || 0;
    }
  }

  const rows = Object.values(balances).map((row) => {
    const cat = row.account.category;
  // Assets & expenses: debit-normal; liabilities, equity, revenue: credit-normal
    const balance =
      cat === 'asset' || cat === 'expense' || cat === 'cogs'
        ? row.debit - row.credit
        : row.credit - row.debit;
    return { ...row, balance };
  });

  const grouped = { asset: [], liability: [], equity: [] };
  for (const row of rows) {
    const cat = row.account.category;
    if (grouped[cat]) grouped[cat].push(row);
  }

  return grouped;
}

export async function getTopProducts({ from, to, limit = 50, days = 30 } = {}) {
  const match = { internalStatus: 'delivered' };
  if (from || to) {
    match.deliveredAt = {};
    if (from) match.deliveredAt.$gte = new Date(from);
    if (to) match.deliveredAt.$lte = new Date(to);
  } else {
    match.deliveredAt = { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
  }

  const orders = await Order.find(match).select('items deliveredAt');
  const bySku = {};

  for (const order of orders) {
    for (const item of order.items) {
      const key = String(item.variantId);
      if (!bySku[key]) {
        bySku[key] = {
          variantId: item.variantId,
          sku: item.sku,
          revenue: 0,
          cogs: 0,
          quantity: 0,
        };
      }
      bySku[key].revenue += item.unitSellingPrice * item.quantity;
      bySku[key].cogs += (item.unitCogs || 0) * item.quantity;
      bySku[key].quantity += item.quantity;
    }
  }

  const variantIds = Object.keys(bySku);
  const variants = await Variant.find({ _id: { $in: variantIds } })
    .populate('productId', 'title status')
    .select('sku title realStock productId');

  const variantMap = Object.fromEntries(variants.map((v) => [String(v._id), v]));

  const rows = Object.values(bySku).map((row) => {
    const variant = variantMap[String(row.variantId)];
    const margin = row.revenue - row.cogs;
    const stock = variant?.realStock ?? 0;
    const sellThrough = row.quantity + stock > 0 ? row.quantity / (row.quantity + stock) : 0;
    return {
      ...row,
      title: variant?.title || row.sku,
      productStatus: variant?.productId?.status,
      realStock: stock,
      margin,
      marginPct: row.revenue > 0 ? (margin / row.revenue) * 100 : 0,
      sellThroughPct: sellThrough * 100,
      isSlowMover: row.quantity === 0,
    };
  });

  rows.sort((a, b) => b.revenue - a.revenue);
  return rows.slice(0, limit);
}

/**
 * Best-effort auto-journal on order delivery. Never throws.
 */
export async function recordDeliveryJournal(order, actorUserId) {
  try {
    const existing = await JournalEntry.findOne({ orderId: order._id, source: 'auto_delivery' });
    if (existing) return existing;

    const revenue = order.totalSellingPrice || 0;
    let cogs = order.totalCogsSnapshot || 0;
    if (!cogs) {
      cogs = order.items.reduce((s, i) => s + (i.unitCogs || 0) * i.quantity, 0);
    }
    if (revenue <= 0 && cogs <= 0) return null;

    const revenueAccount =
      (await getAccountByCode(order.orderSource === 'manual' ? '4002' : '4001')) ||
      (await getAccountByCode('4001'));
    const cogsAccount = await getAccountByCode('5001');
    const inventoryAccount = await getAccountByCode('1100');
    const arAccount = await getAccountByCode('1200');

    if (!revenueAccount || !cogsAccount || !inventoryAccount || !arAccount) {
      logger.warn('Chart of accounts incomplete — skipping delivery journal');
      return null;
    }

    const lines = [];
    if (revenue > 0) {
      lines.push(
        { accountId: arAccount._id, debit: revenue, credit: 0, note: 'Delivery AR' },
        { accountId: revenueAccount._id, debit: 0, credit: revenue, note: 'Delivery revenue' }
      );
    }
    if (cogs > 0) {
      lines.push(
        { accountId: cogsAccount._id, debit: cogs, credit: 0, note: 'Delivery COGS' },
        { accountId: inventoryAccount._id, debit: 0, credit: cogs, note: 'Inventory relief' }
      );
    }

    return JournalEntry.create({
      date: order.deliveredAt || new Date(),
      description: `Auto journal — order ${order.shopifyOrderId || order._id}`,
      reference: order.shopifyOrderId || String(order._id),
      source: 'auto_delivery',
      orderId: order._id,
      createdBy: actorUserId,
      lines,
    });
  } catch (err) {
    logger.warn({ err, orderId: order._id }, 'Failed to record delivery journal');
    return null;
  }
}

export default {
  listAccounts,
  createAccount,
  updateAccount,
  listJournalEntries,
  createJournalEntry,
  getProfitAndLoss,
  getBalanceSheet,
  getTopProducts,
  recordDeliveryJournal,
};
