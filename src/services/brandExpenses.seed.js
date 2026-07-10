import BrandExpense from '../models/BrandExpense.js';
import logger from '../utils/logger.js';

/**
 * Gazelle brand operating expenses.
 * Fixed = constant every month. Variable = entered each month (ranges are guidance).
 */
export const BRAND_EXPENSE_SEED = [
  // Fixed
  { key: 'rent', name: 'Rent', kind: 'fixed', amount: 20000, currency: 'EGP', sortOrder: 10 },
  { key: 'salary-mayar', name: 'Mayar Salary', kind: 'fixed', amount: 11000, currency: 'EGP', sortOrder: 20 },
  { key: 'salary-moaz', name: 'Moaz Salary', kind: 'fixed', amount: 5000, currency: 'EGP', sortOrder: 30 },
  { key: 'salary-mostafa', name: 'Mostafa Salary', kind: 'fixed', amount: 5000, currency: 'EGP', sortOrder: 40 },
  { key: 'salary-mariem-cx', name: 'Mariem (CX) Salary', kind: 'fixed', amount: 4000, currency: 'EGP', sortOrder: 50 },
  { key: 'salary-omar-media', name: 'Omar (Media Buyer) Salary', kind: 'fixed', amount: 12000, currency: 'EGP', sortOrder: 60 },
  { key: 'mayar-other', name: 'Mayar', kind: 'fixed', amount: 7000, currency: 'EGP', sortOrder: 70 },
  { key: 'website', name: 'Website', kind: 'fixed', amount: 120, currency: 'USD', sortOrder: 80 },
  // Variable
  {
    key: 'boxes',
    name: 'Boxes',
    kind: 'variable',
    amount: 12500,
    amountMin: 10000,
    amountMax: 15000,
    currency: 'EGP',
    sortOrder: 110,
  },
  { key: 'content', name: 'Content', kind: 'variable', amount: 10000, currency: 'EGP', sortOrder: 120 },
  {
    key: 'ads',
    name: 'Ads',
    kind: 'variable',
    amount: 250000,
    amountMin: 200000,
    amountMax: 300000,
    currency: 'EGP',
    sortOrder: 130,
  },
  { key: 'flyers', name: 'Flyers', kind: 'variable', amount: 7000, currency: 'EGP', sortOrder: 140 },
  { key: 'freight-in', name: 'Freight In', kind: 'variable', amount: 5000, currency: 'EGP', sortOrder: 150 },
];

/** Default USD→EGP when Settings / env not set. */
export const DEFAULT_USD_TO_EGP = 50;

export async function ensureBrandExpenses() {
  let created = 0;
  let updated = 0;

  for (const row of BRAND_EXPENSE_SEED) {
    const existing = await BrandExpense.findOne({ key: row.key });
    if (!existing) {
      await BrandExpense.create(row);
      created += 1;
      continue;
    }
    // Keep amounts in sync with the brand sheet on boot (admin can still override monthly).
    const next = {
      name: row.name,
      kind: row.kind,
      amount: row.amount,
      amountMin: row.amountMin ?? null,
      amountMax: row.amountMax ?? null,
      currency: row.currency,
      sortOrder: row.sortOrder,
      isActive: true,
    };
    const changed = Object.keys(next).some((k) => String(existing[k] ?? '') !== String(next[k] ?? ''));
    if (changed) {
      Object.assign(existing, next);
      await existing.save();
      updated += 1;
    }
  }

  if (created || updated) {
    logger.info({ created, updated }, 'Brand expenses seeded');
  }
  return { created, updated, total: BRAND_EXPENSE_SEED.length };
}

export default { ensureBrandExpenses, BRAND_EXPENSE_SEED, DEFAULT_USD_TO_EGP };
