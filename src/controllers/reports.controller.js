import * as reportsService from '../services/reports.service.js';

export async function dashboard(req, res, next) {
  try {
    const stats = await reportsService.getDashboardStats();
    res.json({ data: stats });
  } catch (err) {
    next(err);
  }
}

export async function profitability(req, res, next) {
  try {
    const report = await reportsService.getProfitabilityReport(req.query);
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
}

export async function auditLog(req, res, next) {
  try {
    const log = await reportsService.getAuditLog(req.query);
    res.json({ data: log });
  } catch (err) {
    next(err);
  }
}

export default { dashboard, profitability, auditLog };
