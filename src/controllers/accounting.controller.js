import * as accountingService from '../services/accounting.service.js';

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

export default {
  listAccounts,
  createAccount,
  updateAccount,
  listJournal,
  createJournal,
  profitAndLoss,
  balanceSheet,
  topProducts,
};
