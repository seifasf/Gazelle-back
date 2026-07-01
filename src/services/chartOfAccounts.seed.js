import GLAccount from '../models/GLAccount.js';
import logger from '../utils/logger.js';

const CHART_OF_ACCOUNTS = [
  { code: '1100', name: 'Inventory', category: 'asset', type: 'Inventory' },
  { code: '1200', name: 'Accounts Receivable', category: 'asset', type: 'Receivable' },
  { code: '4001', name: 'Shoe Sales', category: 'revenue', type: 'Shoe Sales' },
  { code: '4002', name: 'Online Sales', category: 'revenue', type: 'Online Sales' },
  { code: '4003', name: 'Wholesale Sales', category: 'revenue', type: 'Wholesale Sales' },
  { code: '4004', name: 'Accessories Sales', category: 'revenue', type: 'Accessories Sales' },
  { code: '4005', name: 'Delivery Income', category: 'revenue', type: 'Delivery Income' },
  { code: '5001', name: 'Shoe Cost', category: 'cogs', type: 'Shoe Cost' },
  { code: '5002', name: 'Packaging Cost', category: 'cogs', type: 'Packaging Cost' },
  { code: '5003', name: 'Freight In', category: 'cogs', type: 'Freight In' },
  { code: '6001', name: 'Rent', category: 'expense', type: 'Rent' },
  { code: '6002', name: 'Electricity', category: 'expense', type: 'Electricity' },
  { code: '6003', name: 'Salaries', category: 'expense', type: 'Salaries' },
  { code: '6004', name: 'Marketing', category: 'expense', type: 'Marketing' },
  { code: '6005', name: 'Shipping Expense', category: 'expense', type: 'Shipping Expense' },
  { code: '6006', name: 'Office Supplies', category: 'expense', type: 'Office Supplies' },
  { code: '6007', name: 'Internet', category: 'expense', type: 'Internet' },
  { code: '6008', name: 'Depreciation', category: 'expense', type: 'Depreciation' },
  { code: '6009', name: 'Bank Charges', category: 'expense', type: 'Bank Charges' },
  { code: '2001', name: 'Accounts Payable', category: 'liability', type: 'Accounts Payable' },
  { code: '2002', name: 'VAT Payable', category: 'liability', type: 'VAT Payable' },
  { code: '2003', name: 'Salaries Payable', category: 'liability', type: 'Salaries Payable' },
  { code: '2004', name: 'Loan Payable', category: 'liability', type: 'Loan Payable' },
  { code: '3001', name: 'Owner Capital', category: 'equity', type: 'Owner Capital' },
  { code: '3002', name: 'Retained Earnings', category: 'equity', type: 'Retained Earnings' },
  { code: '3003', name: 'Current Year Earnings', category: 'equity', type: 'Current Year Earnings' },
];

export async function ensureChartOfAccounts() {
  const existing = await GLAccount.countDocuments();
  if (existing > 0) return { seeded: false, count: existing };

  await GLAccount.insertMany(CHART_OF_ACCOUNTS);
  logger.info({ count: CHART_OF_ACCOUNTS.length }, 'Chart of accounts seeded');
  return { seeded: true, count: CHART_OF_ACCOUNTS.length };
}

export async function getAccountByCode(code) {
  return GLAccount.findOne({ code, isActive: true });
}

export default { ensureChartOfAccounts, getAccountByCode, CHART_OF_ACCOUNTS };
