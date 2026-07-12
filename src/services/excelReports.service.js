import ExcelJS from 'exceljs';
import { workbookBuffer, styleHeaderRow } from '../utils/excelExport.js';
import { getProfitabilityReport, getAuditLog } from './reports.service.js';
import { getProfitAndLoss, getTopProducts, getCogsHealth } from './accounting.service.js';
import { getBrandExpensesForRange } from './brandExpense.service.js';

function dateSuffix(from, to) {
  const f = from ? String(from).slice(0, 10) : 'all';
  const t = to ? String(to).slice(0, 10) : 'all';
  return `${f}-${t}`;
}

export async function exportProfitabilityExcel({ from, to, groupBy = 'product' } = {}) {
  const result = await getProfitabilityReport({ from, to, groupBy });
  const products = result.products || result.data || [];
  const totals = result.totals || {};
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Profitability');
  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Revenue (EGP)', key: 'revenue', width: 14 },
    { header: 'COGS (EGP)', key: 'cogs', width: 14 },
    { header: 'Margin (EGP)', key: 'margin', width: 14 },
    { header: 'Margin %', key: 'marginPct', width: 10 },
    { header: 'Missing COGS', key: 'missingCogs', width: 12 },
    { header: 'Decision', key: 'decision', width: 16 },
  ];
  for (const row of products) {
    sheet.addRow({ ...row, missingCogs: row.missingCogs ? 'Yes' : '' });
  }
  sheet.addRow({});
  sheet.addRow({
    sku: 'TOTAL',
    quantity: totals.quantity,
    revenue: totals.revenue,
    cogs: totals.cogs,
    margin: totals.margin,
    marginPct: totals.marginPct,
  });
  styleHeaderRow(sheet);
  const buffer = await workbookBuffer(workbook);
  return { buffer, filename: `profitability-${dateSuffix(from, to)}.xlsx` };
}

export async function exportPlExcel({ from, to } = {}) {
  const r = await getProfitAndLoss({ from, to });
  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet('P&L summary');
  summary.columns = [
    { header: 'Line', key: 'line', width: 28 },
    { header: 'Amount (EGP)', key: 'amount', width: 16 },
  ];
  const lines = [
    ['Revenue', r.revenue],
    ['COGS', r.cogs],
    ['Gross profit', r.grossProfit],
    ['Journal expenses', r.journalExpenses ?? 0],
    ['Brand fixed expenses', r.brandExpenses?.fixed ?? 0],
    ['Brand variable expenses', r.brandExpenses?.variable ?? 0],
    ['Total expenses', r.expenses],
    ['Net income', r.netIncome],
    ['Gross margin %', r.ratios?.grossMarginPct ?? 0],
    ['Net margin %', r.ratios?.netMarginPct ?? 0],
    ['Delivered orders', r.deliveredCount ?? 0],
    ['Units sold', r.unitsSold ?? 0],
  ];
  for (const [line, amount] of lines) summary.addRow({ line, amount });
  styleHeaderRow(summary);

  if (r.topExpenseAccounts?.length) {
    const exp = workbook.addWorksheet('Top expenses');
    exp.columns = [
      { header: 'Code', key: 'code', width: 10 },
      { header: 'Account', key: 'name', width: 28 },
      { header: 'Amount (EGP)', key: 'amount', width: 14 },
    ];
    for (const row of r.topExpenseAccounts) exp.addRow(row);
    styleHeaderRow(exp);
  }

  const buffer = await workbookBuffer(workbook);
  return { buffer, filename: `pl-report-${dateSuffix(from, to)}.xlsx` };
}

export async function exportTopProductsExcel({ from, to, days = 30, limit = 50 } = {}) {
  const payload = await getTopProducts({ from, to, days, limit });
  const rows = payload.products || [];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Top products');
  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Title', key: 'title', width: 28 },
    { header: 'Qty sold', key: 'quantity', width: 10 },
    { header: 'Revenue (EGP)', key: 'revenue', width: 14 },
    { header: 'COGS (EGP)', key: 'cogs', width: 14 },
    { header: 'Margin (EGP)', key: 'margin', width: 14 },
    { header: 'Margin %', key: 'marginPct', width: 10 },
    { header: 'Warehouse stock', key: 'realStock', width: 14 },
    { header: 'Missing COGS', key: 'missingCogs', width: 12 },
  ];
  for (const row of rows) {
    sheet.addRow({
      ...row,
      title: row.title || row.productTitle || '',
      margin: row.margin ?? (row.revenue - row.cogs),
      marginPct: row.marginPct ?? (row.revenue > 0 ? ((row.revenue - row.cogs) / row.revenue) * 100 : 0),
      missingCogs: row.missingCogs ? 'Yes' : '',
    });
  }
  styleHeaderRow(sheet);
  const buffer = await workbookBuffer(workbook);
  return { buffer, filename: `top-products-${dateSuffix(from, to)}.xlsx` };
}

export async function exportCogsHealthExcel({ limit = 5000 } = {}) {
  const { variants, summary } = await getCogsHealth({ limit });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('COGS health');
  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'Title', key: 'title', width: 28 },
    { header: 'Selling price', key: 'sellingPrice', width: 14 },
    { header: 'COGS', key: 'cogs', width: 10 },
    { header: 'Unit margin', key: 'unitMargin', width: 12 },
    { header: 'Margin %', key: 'marginPct', width: 10 },
    { header: 'Health', key: 'health', width: 10 },
    { header: 'Decision', key: 'decision', width: 28 },
    { header: 'Warehouse', key: 'realStock', width: 10 },
    { header: 'On hold', key: 'onHoldStock', width: 10 },
  ];
  for (const row of variants) sheet.addRow(row);
  sheet.addRow({});
  sheet.addRow({ sku: 'SUMMARY', title: JSON.stringify(summary) });
  styleHeaderRow(sheet);
  const buffer = await workbookBuffer(workbook);
  return { buffer, filename: `cogs-health-${new Date().toISOString().slice(0, 10)}.xlsx` };
}

export async function exportAuditLogExcel({ from, to, limit = 500 } = {}) {
  const { statusHistory, inventoryLedger } = await getAuditLog({ from, to, limit, skip: 0 });
  const workbook = new ExcelJS.Workbook();

  const statusSheet = workbook.addWorksheet('Order status');
  statusSheet.columns = [
    { header: 'When', key: 'createdAt', width: 22 },
    { header: 'Order ID', key: 'orderId', width: 26 },
    { header: 'From', key: 'fromStatus', width: 22 },
    { header: 'To', key: 'toStatus', width: 22 },
    { header: 'Source', key: 'source', width: 16 },
    { header: 'Note', key: 'note', width: 40 },
  ];
  for (const e of statusHistory) {
    statusSheet.addRow({
      createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : '',
      orderId: String(e.orderId || ''),
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      source: e.source,
      note: e.note || '',
    });
  }
  styleHeaderRow(statusSheet);

  const ledgerSheet = workbook.addWorksheet('Inventory ledger');
  ledgerSheet.columns = [
    { header: 'When', key: 'createdAt', width: 22 },
    { header: 'Type', key: 'ledgerType', width: 24 },
    { header: 'Delta', key: 'quantityDelta', width: 10 },
    { header: 'Variant ID', key: 'variantId', width: 26 },
    { header: 'Order ID', key: 'orderId', width: 26 },
  ];
  for (const e of inventoryLedger) {
    ledgerSheet.addRow({
      createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : '',
      ledgerType: e.ledgerType,
      quantityDelta: e.quantityDelta,
      variantId: String(e.variantId || ''),
      orderId: String(e.orderId || ''),
    });
  }
  styleHeaderRow(ledgerSheet);

  const buffer = await workbookBuffer(workbook);
  return { buffer, filename: `audit-log-${dateSuffix(from, to)}.xlsx` };
}

export async function exportBrandExpensesExcel({ from, to } = {}) {
  const brand = await getBrandExpensesForRange({ from, to });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Brand expenses');
  sheet.columns = [
    { header: 'Month', key: 'month', width: 12 },
    { header: 'Kind', key: 'kind', width: 12 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Amount', key: 'amount', width: 12 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Amount EGP', key: 'amountEgp', width: 14 },
    { header: 'Note', key: 'note', width: 24 },
  ];
  for (const month of brand.breakdowns || []) {
    for (const item of month.lines || []) {
      sheet.addRow({
        month: month.yearMonth,
        kind: item.kind,
        name: item.name,
        amount: item.amount,
        currency: item.currency || 'EGP',
        amountEgp: item.amountEgp ?? item.amount,
        note: item.note || '',
      });
    }
  }
  styleHeaderRow(sheet);
  const buffer = await workbookBuffer(workbook);
  return { buffer, filename: `brand-expenses-${dateSuffix(from, to)}.xlsx` };
}

export default {
  exportProfitabilityExcel,
  exportPlExcel,
  exportTopProductsExcel,
  exportCogsHealthExcel,
  exportAuditLogExcel,
  exportBrandExpensesExcel,
};
