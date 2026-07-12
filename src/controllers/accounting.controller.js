import * as accountingService from '../services/accounting.service.js';
import * as excelReports from '../services/excelReports.service.js';
import { sendExcel } from '../utils/excelExport.js';

export async function listAccounts(req, res, next) {
  try {
    const accounts = await accountingService.listAccounts({ category: req.query.category });
    res.json({ data: accounts });
  } catch (err) {
    next(err);
  }
}

export async function createAccount(req, res, next) {
  try {
    const account = await accountingService.createAccount(req.body);
    res.status(201).json({ data: account });
  } catch (err) {
    next(err);
  }
}

export async function updateAccount(req, res, next) {
  try {
    const account = await accountingService.updateAccount(req.params.id, req.body);
    res.json({ data: account });
  } catch (err) {
    next(err);
  }
}

export async function listJournal(req, res, next) {
  try {
    const result = await accountingService.listJournalEntries({
      from: req.query.from,
      to: req.query.to,
      limit: Number(req.query.limit) || 50,
      skip: Number(req.query.skip) || 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function createJournal(req, res, next) {
  try {
    const entry = await accountingService.createJournalEntry({
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json({ data: entry });
  } catch (err) {
    next(err);
  }
}

export async function profitAndLoss(req, res, next) {
  try {
    const report = await accountingService.getProfitAndLoss({
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
}

export async function listBrandExpenses(req, res, next) {
  try {
    const { listBrandExpenses: list } = await import('../services/brandExpense.service.js');
    const expenses = await list({ kind: req.query.kind });
    res.json({ data: expenses });
  } catch (err) {
    next(err);
  }
}

export async function getMonthExpenses(req, res, next) {
  try {
    const { getMonthExpenseBreakdown } = await import('../services/brandExpense.service.js');
    const yearMonth = req.query.month || req.params.month;
    if (!yearMonth) {
      const err = new Error('month (YYYY-MM) is required');
      err.statusCode = 400;
      throw err;
    }
    const data = await getMonthExpenseBreakdown(yearMonth);
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function saveMonthExpenses(req, res, next) {
  try {
    const { saveMonthExpenses: save } = await import('../services/brandExpense.service.js');
    const yearMonth = req.body.month || req.params.month;
    const data = await save(yearMonth, req.body.items || [], req.user._id);
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function balanceSheet(req, res, next) {
  try {
    const report = await accountingService.getBalanceSheet();
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
}

export async function topProducts(req, res, next) {
  try {
    const rows = await accountingService.getTopProducts({
      from: req.query.from,
      to: req.query.to,
      days: Number(req.query.days) || 30,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}

export async function cogsHealth(req, res, next) {
  try {
    const report = await accountingService.getCogsHealth({
      limit: Number(req.query.limit) || 200,
    });
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
}

export async function exportPl(req, res, next) {
  try {
    const { buffer, filename } = await excelReports.exportPlExcel(req.query);
    sendExcel(res, { buffer, filename });
  } catch (err) {
    next(err);
  }
}

export async function exportTopProducts(req, res, next) {
  try {
    const { buffer, filename } = await excelReports.exportTopProductsExcel(req.query);
    sendExcel(res, { buffer, filename });
  } catch (err) {
    next(err);
  }
}

export async function exportCogsHealth(req, res, next) {
  try {
    const { buffer, filename } = await excelReports.exportCogsHealthExcel(req.query);
    sendExcel(res, { buffer, filename });
  } catch (err) {
    next(err);
  }
}

export async function exportBrandExpenses(req, res, next) {
  try {
    const { buffer, filename } = await excelReports.exportBrandExpensesExcel(req.query);
    sendExcel(res, { buffer, filename });
  } catch (err) {
    next(err);
  }
}

export default {
  listAccounts,
  createAccount,
  updateAccount,
  listJournal,
  createJournal,
  profitAndLoss,
  balanceSheet,
  topProducts,
  cogsHealth,
  listBrandExpenses,
  getMonthExpenses,
  saveMonthExpenses,
  exportPl,
  exportTopProducts,
  exportCogsHealth,
  exportBrandExpenses,
};
