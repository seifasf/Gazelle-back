import BrandExpense from '../models/BrandExpense.js';
import logger from '../utils/logger.js';

/**
 * Gazelle brand operating expenses.
 * Fixed = auto-applied every month toward OpEx (EGP only).
 * Variable = entered each month; once saved they add to total OpEx.
 */
export const BRAND_EXPENSE_SEED = [
  // Fixed (Brand fixed — editable in admin)
  { key: 'rent', name: 'Rent', kind: 'fixed', amount: 20000, currency: 'EGP', sortOrder: 10 },
  { key: 'salary-mayar', name: 'Mayar Salary', kind: 'fixed', amount: 11000, currency: 'EGP', sortOrder: 20 },
  { key: 'salary-moaz', name: 'Moaz Salary', kind: 'fixed', amount: 5000, currency: 'EGP', sortOrder: 30 },
  { key: 'salary-mostafa', name: 'Mostafa Salary', kind: 'fixed', amount: 5000, currency: 'EGP', sortOrder: 40 },
  { key: 'salary-mariem-cx', name: 'Mariem (CX) Salary', kind: 'fixed', amount: 4000, currency: 'EGP', sortOrder: 50 },
  { key: 'salary-omar-media', name: 'Omar (Media Buyer) Salary', kind: 'fixed', amount: 12000, currency: 'EGP', sortOrder: 60 },
  { key: 'mayar-other', name: 'Mayar', kind: 'fixed', amount: 7000, currency: 'EGP', sortOrder: 70 },
  // Website moved to variable (EGP only) — enter monthly actual
  { key: 'website', name: 'Website', kind: 'variable', amount: 6000, currency: 'EGP', sortOrder: 105 },
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

/** @deprecated kept for any residual FX helpers */
export const DEFAULT_USD_TO_EGP = 50;

export async function ensureBrandExpenses() {
  let created = 0;
  let migrated = 0;

  for (const row of BRAND_EXPENSE_SEED) {
    const existing = await BrandExpense.findOne({ key: row.key });
    if (!existing) {
      await BrandExpense.create({ ...row, currency: 'EGP' });
      created += 1;
      continue;
    }

    // One-time migrations only — do not overwrite admin-edited amounts every boot.
    let dirty = false;
    if (row.key === 'website' && (existing.kind !== 'variable' || existing.currency !== 'EGP')) {
      if (existing.currency === 'USD') {
        existing.amount = Math.round((Number(existing.amount) || 0) * DEFAULT_USD_TO_EGP);
      }
      existing.kind = 'variable';
      existing.currency = 'EGP';
      existing.name = row.name;
      existing.sortOrder = row.sortOrder;
      dirty = true;
    }
    if (existing.currency === 'USD') {
      existing.amount = Math.round((Number(existing.amount) || 0) * DEFAULT_USD_TO_EGP);
      existing.currency = 'EGP';
      dirty = true;
    }
    if (!existing.isActive && !existing.deletedAt) {
      // leave soft-deleted alone
    }
    if (dirty) {
      await existing.save();
      migrated += 1;
    }
  }

  if (created || migrated) {
    logger.info({ created, migrated }, 'Brand expenses seeded/migrated');
  }
  return { created, migrated, total: BRAND_EXPENSE_SEED.length };
}

export default { ensureBrandExpenses, BRAND_EXPENSE_SEED, DEFAULT_USD_TO_EGP };
