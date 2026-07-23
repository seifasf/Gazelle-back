import ExcelJS from 'exceljs';
import Variant from '../models/Variant.js';
import Product from '../models/Product.js';
import * as orderService from './order.service.js';
import logger from '../utils/logger.js';

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[–—]/g, '-')
    .trim();
}

/**
 * Parse pivot labels like "Women Brown Ballerina - 38, Brown"
 * → { titleBase, size, color }
 */
export function parseStockLabel(label) {
  const raw = String(label || '').trim();
  if (!raw) return null;

  // "Title - Size, Color" or "Title - Size"
  const m = raw.match(/^(.*?)\s*-\s*([^,]+?)(?:\s*,\s*(.+))?$/);
  if (m) {
    return {
      full: raw,
      titleBase: m[1].trim(),
      size: m[2].trim(),
      color: (m[3] || '').trim() || null,
    };
  }
  return { full: raw, titleBase: raw, size: null, color: null };
}

function cellNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && value.result != null) return cellNumber(value.result);
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the blank-named pivot sheet (or first sheet with Row Labels + الاجمالى).
 * Returns [{ label, qty }].
 */
export async function parseRealStockExcelBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  let sheet =
    workbook.worksheets.find((s) => s.name === ' ' || s.name.trim() === '') ||
    workbook.worksheets.find((s) => {
      const h2 = s.getRow(4)?.getCell(1)?.value;
      const h4 = s.getRow(4)?.getCell(4)?.value;
      return String(h2 || '').includes('Row') || String(h4 || '').includes('اجمال');
    }) ||
    workbook.worksheets[0];

  if (!sheet) {
    const err = new Error('No worksheet found in Excel file');
    err.statusCode = 400;
    throw err;
  }

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, n) => {
    if (n < 5) return;
    const label = row.getCell(1).value;
    if (label == null) return;
    const labelStr = typeof label === 'object' && label.text ? label.text : String(label);
    if (!labelStr || labelStr === 'Row Labels' || labelStr === '(blank)' || labelStr === 'Grand Total') return;
    const qty = cellNumber(row.getCell(4).value);
    if (qty == null) return;
    rows.push({ label: labelStr.trim(), qty: Math.round(qty) });
  });

  return { sheetName: sheet.name, rows };
}

async function buildVariantIndex() {
  const variants = await Variant.find({})
    .select('sku title color size realStock productId')
    .populate('productId', 'title')
    .lean();

  const byNormTitle = new Map();
  const byProductSizeColor = new Map();

  for (const v of variants) {
    const keys = new Set();
    keys.add(norm(v.title));
    keys.add(norm(`${v.title} - ${v.size || ''}, ${v.color || ''}`));
    const productTitle = v.productId?.title;
    if (productTitle) {
      keys.add(norm(`${productTitle} - ${v.size || ''}, ${v.color || ''}`));
      keys.add(norm(`${productTitle} ${v.size || ''} ${v.color || ''}`));
      byProductSizeColor.set(
        `${norm(productTitle)}|${norm(v.size)}|${norm(v.color)}`,
        v
      );
    }
    for (const k of keys) {
      if (!k) continue;
      if (!byNormTitle.has(k)) byNormTitle.set(k, []);
      byNormTitle.get(k).push(v);
    }
  }

  return { variants, byNormTitle, byProductSizeColor };
}

function matchVariant(parsed, index) {
  if (!parsed) return { status: 'unmatched', variant: null };

  const fullKey = norm(parsed.full);
  const hits = index.byNormTitle.get(fullKey) || [];
  if (hits.length === 1) return { status: 'matched', variant: hits[0] };
  if (hits.length > 1) return { status: 'ambiguous', variant: null, candidates: hits };

  if (parsed.titleBase && parsed.size) {
    const key = `${norm(parsed.titleBase)}|${norm(parsed.size)}|${norm(parsed.color || '')}`;
    const v = index.byProductSizeColor.get(key);
    if (v) return { status: 'matched', variant: v };

    // Try without color
    const prefix = `${norm(parsed.titleBase)}|${norm(parsed.size)}|`;
    const colorHits = [];
    for (const [k, val] of index.byProductSizeColor) {
      if (k.startsWith(prefix)) colorHits.push(val);
    }
    if (colorHits.length === 1) return { status: 'matched', variant: colorHits[0] };
    if (colorHits.length > 1) return { status: 'ambiguous', variant: null, candidates: colorHits };
  }

  return { status: 'unmatched', variant: null };
}

/**
 * Import pivot totals into OMS realStock. Never writes Shopify.
 */
export async function importRealStockFromExcelBuffer(buffer, { actorUserId, apply = true } = {}) {
  const { sheetName, rows } = await parseRealStockExcelBuffer(buffer);
  const index = await buildVariantIndex();

  const report = {
    sheetName,
    totalRows: rows.length,
    matched: 0,
    unmatched: 0,
    ambiguous: 0,
    applied: 0,
    unchanged: 0,
    unmatchedSamples: [],
    ambiguousSamples: [],
    results: [],
  };

  const toApply = [];

  for (const row of rows) {
    const parsed = parseStockLabel(row.label);
    const match = matchVariant(parsed, index);
    if (match.status === 'matched') {
      report.matched += 1;
      toApply.push({
        variantId: match.variant._id,
        sku: match.variant.sku,
        label: row.label,
        previous: match.variant.realStock,
        realStock: row.qty,
      });
    } else if (match.status === 'ambiguous') {
      report.ambiguous += 1;
      if (report.ambiguousSamples.length < 15) {
        report.ambiguousSamples.push({
          label: row.label,
          candidates: (match.candidates || []).slice(0, 5).map((c) => c.sku),
        });
      }
    } else {
      report.unmatched += 1;
      if (report.unmatchedSamples.length < 25) {
        report.unmatchedSamples.push(row.label);
      }
    }
  }

  if (apply && toApply.length) {
    const batch = await orderService.setRealStockBatch({
      items: toApply.map((r) => ({ variantId: r.variantId, realStock: r.realStock })),
      reasonCode: 'excel_import',
      actorUserId,
    });
    for (const r of batch.results) {
      if (r.changed) report.applied += 1;
      else report.unchanged += 1;
    }
    report.results = batch.results.slice(0, 50);
  } else {
    report.results = toApply.slice(0, 50);
  }

  logger.info(
    {
      sheetName,
      matched: report.matched,
      unmatched: report.unmatched,
      ambiguous: report.ambiguous,
      applied: report.applied,
    },
    'Real stock Excel import finished'
  );

  return report;
}

export async function importRealStockFromFile(filePath, opts) {
  const { readFileSync } = await import('fs');
  const buffer = readFileSync(filePath);
  return importRealStockFromExcelBuffer(buffer, opts);
}

export default {
  parseStockLabel,
  parseRealStockExcelBuffer,
  importRealStockFromExcelBuffer,
  importRealStockFromFile,
};
