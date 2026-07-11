import GLAccount from '../models/GLAccount.js';
import JournalEntry from '../models/JournalEntry.js';
import Order from '../models/Order.js';
import Variant from '../models/Variant.js';
import Product from '../models/Product.js'; // ensure populate('productId') resolves
import { getAccountByCode } from './chartOfAccounts.seed.js';
import logger from '../utils/logger.js';

void Product;

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function buildDecisionInsights({
  revenue,
  cogs,
  grossProfit,
  expenses,
  netIncome,
  missingCogsUnits = 0,
  brandFixed = 0,
  brandVariable = 0,
  deliveredCount = 0,
}) {
  const insights = [];
  const grossMarginPct = pct(grossProfit, revenue);
  const netMarginPct = pct(netIncome, revenue);
  const expenseRatio = pct(expenses, revenue);

  if (revenue <= 0) {
    insights.push({
      tone: 'warning',
      title: 'No delivered revenue in this period',
      detail: 'Confirm orders are moving to Delivered, or widen the date range.',
    });
  } else {
    if (grossMarginPct < 30) {
      insights.push({
        tone: 'danger',
        title: `Gross margin is thin (${grossMarginPct}%)`,
        detail: 'Review COGS on top SKUs and avoid discounting high-cost styles.',
      });
    } else if (grossMarginPct >= 45) {
      insights.push({
        tone: 'success',
        title: `Healthy gross margin (${grossMarginPct}%)`,
        detail: 'Protect this by keeping COGS updated and limiting deep discounts.',
      });
    }

    if (netIncome < 0) {
      insights.push({
        tone: 'danger',
        title: 'Brand is loss-making this period',
        detail: `Expenses (${Math.round(expenses)} EGP) exceed gross profit. Cut variable spend or raise AOV before scaling ads.`,
      });
    } else if (netMarginPct < 10 && revenue > 0) {
      insights.push({
        tone: 'warning',
        title: `Net margin only ${netMarginPct}%`,
        detail: 'Fixed brand costs are eating profit — check rent, salaries, and ads vs contribution margin.',
      });
    } else if (netMarginPct >= 15) {
      insights.push({
        tone: 'success',
        title: `Solid net margin (${netMarginPct}%)`,
        detail: 'Room to reinvest in best sellers and controlled acquisition.',
      });
    }

    if (brandFixed > 0 && grossProfit > 0 && brandFixed > grossProfit * 0.5) {
      insights.push({
        tone: 'warning',
        title: 'Fixed costs are heavy vs gross profit',
        detail: 'Negotiate fixed overhead or grow delivered volume before adding more fixed spend.',
      });
    }

    if (brandVariable > brandFixed && brandFixed > 0) {
      insights.push({
        tone: 'info',
        title: 'Variable spend exceeds fixed costs',
        detail: 'Audit ads / packaging / shipping extras — variable costs scale with volume.',
      });
    }
  }

  if (missingCogsUnits > 0) {
    insights.push({
      tone: 'warning',
      title: `${missingCogsUnits} sold units missing COGS`,
      detail: 'Margins are overstated until COGS is set on those SKUs.',
    });
  }

  if (deliveredCount > 0 && revenue > 0) {
    const aov = Math.round(revenue / deliveredCount);
    insights.push({
      tone: 'info',
      title: `AOV ≈ ${aov.toLocaleString('en-EG')} EGP`,
      detail: deliveredCount === 1
        ? 'Only one delivered order in range — treat margins as directional.'
        : 'Use bundles / upsells on low-AOV channels to lift contribution.',
    });
  }

  if (expenseRatio > 40 && revenue > 0) {
    insights.push({
      tone: 'warning',
      title: `OpEx is ${expenseRatio}% of revenue`,
      detail: 'Target under ~35% operating expense ratio for a healthier brand P&L.',
    });
  }

  return {
    insights,
    ratios: {
      grossMarginPct,
      netMarginPct,
      expenseRatio,
      cogsRatio: pct(cogs, revenue),
    },
  };
}

async function operationalPlFromOrders({ from, to }) {
  const match = { internalStatus: 'delivered' };
  if (from || to) {
    match.deliveredAt = {};
    if (from) match.deliveredAt.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      if (String(to).length <= 10) end.setHours(23, 59, 59, 999);
      match.deliveredAt.$lte = end;
    }
  }

  const orders = await Order.find(match).select('items totalSellingPrice totalCogsSnapshot deliveredAt shippingFee');
  let revenue = 0;
  let cogs = 0;
  let missingCogsUnits = 0;
  let units = 0;

  for (const order of orders) {
    revenue += order.totalSellingPrice || 0;
    let orderCogs = order.totalCogsSnapshot || 0;
    if (!orderCogs) {
      for (const item of order.items || []) {
        const lineCogs = (item.unitCogs || 0) * item.quantity;
        orderCogs += lineCogs;
        units += item.quantity || 0;
        if (!item.unitCogs) missingCogsUnits += item.quantity || 0;
      }
    } else {
      for (const item of order.items || []) {
        units += item.quantity || 0;
        if (!item.unitCogs) missingCogsUnits += item.quantity || 0;
      }
    }
    cogs += orderCogs;
  }

  return {
    revenue,
    cogs,
    grossProfit: revenue - cogs,
    deliveredCount: orders.length,
    units,
    missingCogsUnits,
  };
}

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
    if (to) {
      const end = new Date(to);
      if (String(to).length <= 10) end.setHours(23, 59, 59, 999);
      filter.date.$lte = end;
    }
  }

  const [entries, total, sourceRows] = await Promise.all([
    JournalEntry.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('lines.accountId', 'code name category')
      .populate('createdBy', 'name'),
    JournalEntry.countDocuments(filter),
    JournalEntry.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$source',
          count: { $sum: 1 },
          debit: { $sum: { $sum: '$lines.debit' } },
        },
      },
    ]),
  ]);

  const enriched = entries.map((e) => {
    const debit = (e.lines || []).reduce((s, l) => s + (l.debit || 0), 0);
    const credit = (e.lines || []).reduce((s, l) => s + (l.credit || 0), 0);
    return {
      ...e.toObject(),
      totalDebit: debit,
      totalCredit: credit,
    };
  });

  return {
    entries: enriched,
    total,
    summary: {
      bySource: Object.fromEntries(sourceRows.map((r) => [r._id || 'unknown', { count: r.count, debit: r.debit }])),
      entryCount: total,
    },
  };
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
    if (to) {
      const end = new Date(to);
      if (String(to).length <= 10) end.setHours(23, 59, 59, 999);
      filter.date.$lte = end;
    }
  }

  const entries = await JournalEntry.find(filter).populate('lines.accountId', 'code name category type');
  const byCategory = { revenue: 0, cogs: 0, expense: 0 };
  const byAccount = {};

  for (const entry of entries) {
    for (const line of entry.lines) {
      const cat = line.accountId?.category;
      if (!cat || !(cat in byCategory)) continue;
      const delta =
        cat === 'revenue'
          ? (line.credit || 0) - (line.debit || 0)
          : (line.debit || 0) - (line.credit || 0);
      byCategory[cat] += delta;
      const code = line.accountId?.code || 'unknown';
      if (!byAccount[code]) {
        byAccount[code] = {
          code,
          name: line.accountId?.name || code,
          category: cat,
          amount: 0,
        };
      }
      byAccount[code].amount += delta;
    }
  }

  const { getBrandExpensesForRange } = await import('./brandExpense.service.js');
  const brand = await getBrandExpensesForRange({ from, to });
  const operational = await operationalPlFromOrders({ from, to });

  const journalExpenses = byCategory.expense;
  const brandExpenses = brand.total;
  const expenses = journalExpenses + brandExpenses;

  // Decision P&L always uses delivered orders (journals are often incomplete).
  const revenue = operational.revenue;
  const cogs = operational.cogs;
  const grossProfit = revenue - cogs;
  const netIncome = grossProfit - expenses;

  const { insights, ratios } = buildDecisionInsights({
    revenue,
    cogs,
    grossProfit,
    expenses,
    netIncome,
    missingCogsUnits: operational.missingCogsUnits,
    brandFixed: brand.fixedTotal,
    brandVariable: brand.variableTotal,
    deliveredCount: operational.deliveredCount,
  });

  const waterfall = [
    { key: 'revenue', label: 'Revenue', amount: revenue },
    { key: 'cogs', label: 'COGS', amount: -cogs },
    { key: 'gross', label: 'Gross profit', amount: grossProfit },
    { key: 'brand_fixed', label: 'Brand fixed', amount: -brand.fixedTotal },
    { key: 'brand_variable', label: 'Brand variable', amount: -brand.variableTotal },
    { key: 'journal', label: 'Journal expenses', amount: -journalExpenses },
    { key: 'net', label: 'Net income', amount: netIncome },
  ];

  return {
    from: from || null,
    to: to || null,
    source: 'orders',
    revenue,
    cogs,
    journalExpenses,
    brandExpenses: {
      fixed: brand.fixedTotal,
      variable: brand.variableTotal,
      total: brandExpenses,
      months: brand.months,
      prorated: brand.prorated,
    },
    expenses,
    grossProfit,
    netIncome,
    ratios,
    insights,
    waterfall,
    books: {
      revenue: byCategory.revenue,
      cogs: byCategory.cogs,
      expenses: journalExpenses,
      grossProfit: byCategory.revenue - byCategory.cogs,
    },
    operational: {
      ...operational,
    },
    topExpenseAccounts: Object.values(byAccount)
      .filter((a) => a.category === 'expense' && a.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8),
    deliveredCount: operational.deliveredCount,
    unitsSold: operational.units,
  };
}

export async function getBalanceSheet() {
  await backfillMissingDeliveryJournals({ limit: 400 });

  const [accounts, entries] = await Promise.all([
    GLAccount.find({ isActive: true }).sort({ code: 1 }).lean(),
    JournalEntry.find().populate('lines.accountId', 'code name category type'),
  ]);

  const balances = {};
  for (const acc of accounts) {
    balances[String(acc._id)] = {
      account: acc,
      debit: 0,
      credit: 0,
      balance: 0,
    };
  }

  for (const entry of entries) {
    for (const line of entry.lines) {
      const acc = line.accountId;
      if (!acc) continue;
      const id = String(acc._id);
      if (!balances[id]) {
        balances[id] = { account: acc.toObject?.() || acc, debit: 0, credit: 0, balance: 0 };
      }
      balances[id].debit += line.debit || 0;
      balances[id].credit += line.credit || 0;
    }
  }

  const rows = Object.values(balances).map((row) => {
    const cat = row.account.category;
    const balance =
      cat === 'asset' || cat === 'expense' || cat === 'cogs'
        ? row.debit - row.credit
        : row.credit - row.debit;
    return { ...row, balance };
  });

  const grouped = {
    asset: [],
    liability: [],
    equity: [],
    revenue: [],
    cogs: [],
    expense: [],
  };
  for (const row of rows) {
    const cat = row.account.category;
    if (grouped[cat]) grouped[cat].push(row);
  }

  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => String(a.account.code).localeCompare(String(b.account.code)));
  }

  const totals = {
    asset: grouped.asset.reduce((s, r) => s + r.balance, 0),
    liability: grouped.liability.reduce((s, r) => s + r.balance, 0),
    equity: grouped.equity.reduce((s, r) => s + r.balance, 0),
    revenue: grouped.revenue.reduce((s, r) => s + r.balance, 0),
    cogs: grouped.cogs.reduce((s, r) => s + r.balance, 0),
    expense: grouped.expense.reduce((s, r) => s + r.balance, 0),
  };

  return { ...grouped, totals, journalCount: entries.length };
}

/** Create missing auto-delivery journals so CoA balances reflect delivered sales. */
export async function backfillMissingDeliveryJournals({ limit = 300 } = {}) {
  const delivered = await Order.find({ internalStatus: 'delivered' })
    .sort({ deliveredAt: -1 })
    .limit(limit)
    .select('items totalSellingPrice totalCogsSnapshot deliveredAt shopifyOrderId orderSource');

  if (!delivered.length) return { created: 0, scanned: 0 };

  const existing = await JournalEntry.find({
    source: 'auto_delivery',
    orderId: { $in: delivered.map((o) => o._id) },
  })
    .select('orderId')
    .lean();
  const posted = new Set(existing.map((e) => String(e.orderId)));

  let created = 0;
  for (const order of delivered) {
    if (posted.has(String(order._id))) continue;
    const entry = await recordDeliveryJournal(order, null);
    if (entry) created += 1;
  }
  if (created > 0) {
    logger.info({ created, scanned: delivered.length }, 'Backfilled delivery journals');
  }
  return { created, scanned: delivered.length };
}

export async function getTopProducts({ from, to, limit = 50, days = 30 } = {}) {
  const match = { internalStatus: 'delivered' };
  if (from || to) {
    match.deliveredAt = {};
    if (from) match.deliveredAt.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      if (String(to).length <= 10) end.setHours(23, 59, 59, 999);
      match.deliveredAt.$lte = end;
    }
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
          missingCogs: false,
        };
      }
      bySku[key].revenue += item.unitSellingPrice * item.quantity;
      bySku[key].cogs += (item.unitCogs || 0) * item.quantity;
      bySku[key].quantity += item.quantity;
      if (!item.unitCogs) bySku[key].missingCogs = true;
    }
  }

  const variantIds = Object.keys(bySku);
  const variants = await Variant.find({ _id: { $in: variantIds } })
    .populate('productId', 'title status')
    .select('sku title realStock onlineStock onHoldStock productId cogs sellingPrice');

  // Also surface high-stock SKUs with zero sales in period (slow movers).
  const soldIds = new Set(variantIds);
  const idleStock = await Variant.find({
    realStock: { $gt: 0 },
    _id: { $nin: [...soldIds] },
  })
    .populate('productId', 'title status')
    .select('sku title realStock onlineStock productId cogs sellingPrice')
    .sort({ realStock: -1 })
    .limit(15)
    .lean();

  const variantMap = Object.fromEntries(variants.map((v) => [String(v._id), v]));

  const rows = Object.values(bySku).map((row) => {
    const variant = variantMap[String(row.variantId)];
    const margin = row.revenue - row.cogs;
    const stock = variant?.realStock ?? 0;
    const sellThrough = row.quantity + stock > 0 ? row.quantity / (row.quantity + stock) : 0;
    const unitMargin =
      row.quantity > 0 ? (row.revenue - row.cogs) / row.quantity : 0;
    return {
      ...row,
      title: variant?.title || row.sku,
      productStatus: variant?.productId?.status,
      realStock: stock,
      onlineStock: variant?.onlineStock ?? 0,
      catalogCogs: variant?.cogs ?? null,
      sellingPrice: variant?.sellingPrice ?? null,
      margin,
      marginPct: row.revenue > 0 ? (margin / row.revenue) * 100 : 0,
      unitMargin,
      sellThroughPct: sellThrough * 100,
      isSlowMover: false,
      decision:
        row.missingCogs
          ? 'Set COGS'
          : margin < 0
            ? 'Unprofitable — raise price or cut cost'
            : sellThrough < 20 && stock > 10
              ? 'Overstocked — promote or pause reorder'
              : sellThrough > 70 && stock < 5
                ? 'Restock soon'
                : 'Keep',
    };
  });

  rows.sort((a, b) => b.revenue - a.revenue);
  const top = rows.slice(0, limit);

  const slowMovers = idleStock.map((v) => ({
    variantId: v._id,
    sku: v.sku,
    title: v.title || v.sku,
    revenue: 0,
    cogs: 0,
    quantity: 0,
    margin: 0,
    marginPct: 0,
    realStock: v.realStock || 0,
    onlineStock: v.onlineStock || 0,
    sellThroughPct: 0,
    isSlowMover: true,
    missingCogs: !(v.cogs > 0),
    decision: (v.realStock || 0) > 20 ? 'Clearance / stop reorder' : 'Monitor — no sales in period',
  }));

  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalMargin = rows.reduce((s, r) => s + r.margin, 0);
  const missingCogsSkus = rows.filter((r) => r.missingCogs).length;
  const losers = [...rows].filter((r) => r.margin < 0).sort((a, b) => a.margin - b.margin).slice(0, 5);
  const winners = top.slice(0, 5);
  const restock = rows
    .filter((r) => r.sellThroughPct > 60 && r.realStock < 8)
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5);

  const insights = [];
  if (winners[0]) {
    insights.push({
      tone: 'success',
      title: `Top earner: ${winners[0].sku}`,
      detail: `${Math.round(winners[0].revenue).toLocaleString('en-EG')} EGP revenue · ${winners[0].marginPct.toFixed(0)}% margin — protect stock.`,
    });
  }
  if (losers[0]) {
    insights.push({
      tone: 'danger',
      title: `Margin leak: ${losers[0].sku}`,
      detail: `Negative margin ${Math.round(losers[0].margin).toLocaleString('en-EG')} EGP — fix COGS or price.`,
    });
  }
  if (slowMovers[0]) {
    insights.push({
      tone: 'warning',
      title: `${slowMovers.length} SKUs with stock but no sales`,
      detail: `Largest idle: ${slowMovers[0].sku} (${slowMovers[0].realStock} units) — consider promo or pause PO.`,
    });
  }
  if (missingCogsSkus > 0) {
    insights.push({
      tone: 'warning',
      title: `${missingCogsSkus} sold SKUs missing COGS`,
      detail: 'Profitability is incomplete until COGS is filled on the COGS page.',
    });
  }
  if (restock[0]) {
    insights.push({
      tone: 'info',
      title: `Restock candidate: ${restock[0].sku}`,
      detail: `High sell-through (${restock[0].sellThroughPct.toFixed(0)}%) with only ${restock[0].realStock} left.`,
    });
  }

  return {
    days: from || to ? null : days,
    from: from || null,
    to: to || null,
    summary: {
      skuCount: rows.length,
      totalRevenue,
      totalMargin,
      avgMarginPct: totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0,
      missingCogsSkus,
      slowMoverCount: slowMovers.length,
    },
    insights,
    winners,
    losers,
    restock,
    slowMovers: slowMovers.slice(0, 10),
    products: top,
  };
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

export async function getCogsHealth({ limit = 200 } = {}) {
  const variants = await Variant.find()
    .populate('productId', 'title status')
    .select('sku title cogs sellingPrice realStock onlineStock onHoldStock productId updatedAt')
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  const rows = variants.map((v) => {
    const cogs = v.cogs || 0;
    const price = v.sellingPrice || 0;
    const unitMargin = price - cogs;
    const marginPct = price > 0 ? (unitMargin / price) * 100 : 0;
    let health = 'ok';
    let decision = 'Hold';
    if (!cogs) {
      health = 'missing';
      decision = 'Enter COGS now';
    } else if (marginPct < 0) {
      health = 'loss';
      decision = 'Price below cost — fix immediately';
    } else if (marginPct < 20) {
      health = 'thin';
      decision = 'Improve cost or raise price';
    } else if (marginPct >= 45) {
      health = 'strong';
      decision = 'Protect margin; good to scale';
    }
    return {
      ...v,
      unitMargin,
      marginPct,
      health,
      decision,
      title: v.title || v.productId?.title || v.sku,
    };
  });

  const summary = {
    total: rows.length,
    missingCogs: rows.filter((r) => r.health === 'missing').length,
    lossMaking: rows.filter((r) => r.health === 'loss').length,
    thinMargin: rows.filter((r) => r.health === 'thin').length,
    strong: rows.filter((r) => r.health === 'strong').length,
  };

  const insights = [];
  if (summary.missingCogs > 0) {
    insights.push({
      tone: 'danger',
      title: `${summary.missingCogs} SKUs have no COGS`,
      detail: 'P&L and profitability are unreliable until these are filled.',
    });
  }
  if (summary.lossMaking > 0) {
    insights.push({
      tone: 'danger',
      title: `${summary.lossMaking} SKUs sell below cost`,
      detail: 'Stop promoting them until price or factory cost is fixed.',
    });
  }
  if (summary.strong > 0) {
    insights.push({
      tone: 'success',
      title: `${summary.strong} high-margin SKUs`,
      detail: 'Prioritize ads and restocks on these first.',
    });
  }

  return { summary, insights, variants: rows };
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
  getCogsHealth,
  recordDeliveryJournal,
  backfillMissingDeliveryJournals,
};
