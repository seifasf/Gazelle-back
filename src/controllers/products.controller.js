import * as productService from '../services/product.service.js';
import * as accountingService from '../services/accounting.service.js';
import * as excelReports from '../services/excelReports.service.js';
import { sendExcel } from '../utils/excelExport.js';

export async function listProducts(req, res, next) {
  try {
    const result = await productService.listProducts(req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateCogs(req, res, next) {
  try {
    const variant = await productService.updateVariantCogs(
      req.params.variantId,
      req.body.cogs,
      req.user._id
    );
    res.json({ data: variant });
  } catch (err) {
    next(err);
  }
}

export async function addCogsBatch(req, res, next) {
  try {
    const batch = await productService.addCogsBatch({
      ...req.body,
      variantId: req.params.variantId,
      userId: req.user._id,
    });
    res.json({ data: batch });
  } catch (err) {
    next(err);
  }
}

/** COGS health for the admin COGS page (also under /accounting/reports/cogs-health). */
export async function cogsHealth(req, res, next) {
  try {
    const report = await accountingService.getCogsHealth({
      limit: Number(req.query.limit) || 2000,
    });
    res.json({ data: report });
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

export default { listProducts, updateCogs, addCogsBatch, cogsHealth, exportCogsHealth };
