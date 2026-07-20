import * as reportsService from '../services/reports.service.js';
import * as excelReports from '../services/excelReports.service.js';
import { sendExcel } from '../utils/excelExport.js';

export async function dashboard(req, res, next) {
  try {
    const stats = await reportsService.getDashboardStats(req.query);
    res.json({ data: stats });
  } catch (err) {
    next(err);
  }
}

export async function profitability(req, res, next) {
  try {
    const report = await reportsService.getProfitabilityReport(req.query);
    // Keep `data` as the product rows for older clients; attach analysis alongside.
    res.json({
      data: report.products || report,
      totals: report.totals,
      insights: report.insights,
      from: report.from,
      to: report.to,
    });
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

export async function exportProfitability(req, res, next) {
  try {
    const { buffer, filename } = await excelReports.exportProfitabilityExcel(req.query);
    sendExcel(res, { buffer, filename });
  } catch (err) {
    next(err);
  }
}

export async function exportAuditLog(req, res, next) {
  try {
    const { buffer, filename } = await excelReports.exportAuditLogExcel(req.query);
    sendExcel(res, { buffer, filename });
  } catch (err) {
    next(err);
  }
}

export async function topSellers(req, res, next) {
  try {
    const report = await reportsService.getTopSellersByUnits({
      month: req.query.month,
      limit: Number(req.query.limit) || 40,
    });
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
}

export default { dashboard, profitability, auditLog, exportProfitability, exportAuditLog, topSellers };
