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

function normColor(s) {
  const c = norm(s);
  const aliases = {
    havan: 'havana',
    havana: 'havana',
    cafe: 'caffe',
    caffe: 'caffe',
    camel: 'caffe',
    gold: 'geometric',
    metalic: 'metallic',
    mouve: 'mauve',
    burgundy: 'burgundy',
    crimson: 'burgundy',
  };
  return aliases[c] || c;
}

/** Excel warehouse names → OMS product titles (normalized keys). */
const TITLE_ALIASES = {
  'velocity beige': 'velocity beige sneakers',
  'velocity black': 'velocity black sneakers',
  'velocity baby blue sneakers': 'velocity baby blue sneakers',
  'flexa pink': 'flexa pink sneakers',
  'flexa black': 'flexa black sneakers',
  'flexa beige': 'flexa beige sneakers',
  'flexa blue': 'flexa blue sneakers',
  'crimson buckle boots': 'crimson buckle boot',
  'black buckle boot': 'black buckle lace up boot',
  'beige moc toe derby boot': 'beige moc toe derby',
  'women brown chunky college laces': 'chunky brown college',
  'women black chunky college laces': 'chunky black college',
  'women burgundy chunky college laces': 'chunky burgundy college',
  'women havan sodfa': 'women havana bush',
  'women beige bush': 'women havana bush',
  'women silver bush': 'women silver buckle mule',
  'women metalic blue bush': 'women metallic blue bush',
  'women black dahab': 'women black dahab',
  'women off-white pointed flat sandal': 'women off-white fabric flishnet mule',
  'black rope sandal': 'black rope sandal',
  'women beige fabric floral ballerina': 'women black fabric floral ballerina',
};

function resolveTitleBase(titleBase) {
  const n = norm(titleBase);
  if (TITLE_ALIASES[n]) return TITLE_ALIASES[n];
  // Boots → Boot, strip trailing s for common plurals
  const singular = n.replace(/\sboots$/, ' boot').replace(/\s+$/, '');
  if (TITLE_ALIASES[singular]) return TITLE_ALIASES[singular];
  if (singular !== n) return singular;
  return n;
}

/**
 * Parse pivot labels like "Women Brown Ballerina - 38, Brown"
 * or reversed "Title - gold, 37" / "Title - blue, 37"
 * → { titleBase, size, color }
 */
export function parseStockLabel(label) {
  const raw = String(label || '').trim();
  if (!raw) return null;

  // "Title - A, B" or "Title - A"
  const m = raw.match(/^(.*?)\s*-\s*([^,]+?)(?:\s*,\s*(.+))?$/);
  if (m) {
    let a = m[2].trim();
    let b = (m[3] || '').trim() || null;
    let size = a;
    let color = b;
    // Reversed: "color, size" when first token is not a size number
    if (b && !/^\d+(\.\d+)?$/.test(a) && /^\d+(\.\d+)?$/.test(b)) {
      color = a;
      size = b;
    } else if (!b && !/^\d+(\.\d+)?$/.test(a)) {
      // "Title - 45" ok; "Title - brown" alone → color only
      color = a;
      size = null;
    }
    return {
      full: raw,
      titleBase: m[1].trim(),
      size,
      color,
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
  const byProductSize = new Map();
  const productsByNormTitle = new Map();

  for (const v of variants) {
    const keys = new Set();
    keys.add(norm(v.title));
    keys.add(norm(`${v.title} - ${v.size || ''}, ${v.color || ''}`));
    keys.add(norm(`${v.title} - ${v.color || ''}, ${v.size || ''}`));
    const productTitle = v.productId?.title;
    if (productTitle) {
      const pt = norm(productTitle);
      keys.add(norm(`${productTitle} - ${v.size || ''}, ${v.color || ''}`));
      keys.add(norm(`${productTitle} - ${v.color || ''}, ${v.size || ''}`));
      keys.add(norm(`${productTitle} ${v.size || ''} ${v.color || ''}`));
      byProductSizeColor.set(`${pt}|${norm(v.size)}|${normColor(v.color)}`, v);
      byProductSizeColor.set(`${pt}|${norm(v.size)}|${norm(v.color)}`, v);
      const sizeKey = `${pt}|${norm(v.size)}`;
      if (!byProductSize.has(sizeKey)) byProductSize.set(sizeKey, []);
      byProductSize.get(sizeKey).push(v);
      if (!productsByNormTitle.has(pt)) productsByNormTitle.set(pt, productTitle);
    }
    for (const k of keys) {
      if (!k) continue;
      if (!byNormTitle.has(k)) byNormTitle.set(k, []);
      byNormTitle.get(k).push(v);
    }
  }

  return { variants, byNormTitle, byProductSizeColor, byProductSize, productsByNormTitle };
}

function matchByProductSizeColor(titleNorm, size, color, index) {
  if (!titleNorm || !size) return null;

  const colorN = normColor(color || '');
  const exact = index.byProductSizeColor.get(`${titleNorm}|${norm(size)}|${colorN}`);
  if (exact) return { status: 'matched', variant: exact };

  const rawColor = index.byProductSizeColor.get(`${titleNorm}|${norm(size)}|${norm(color || '')}`);
  if (rawColor) return { status: 'matched', variant: rawColor };

  const sizeHits = index.byProductSize.get(`${titleNorm}|${norm(size)}`) || [];
  if (sizeHits.length === 1) return { status: 'matched', variant: sizeHits[0] };
  if (sizeHits.length > 1 && color) {
    const byColor = sizeHits.filter(
      (v) => normColor(v.color) === colorN || norm(v.color) === norm(color)
    );
    if (byColor.length === 1) return { status: 'matched', variant: byColor[0] };
    return { status: 'ambiguous', variant: null, candidates: sizeHits };
  }
  if (sizeHits.length > 1) return { status: 'ambiguous', variant: null, candidates: sizeHits };
  return null;
}

function matchVariant(parsed, index) {
  if (!parsed) return { status: 'unmatched', variant: null };

  const fullKey = norm(parsed.full);
  const hits = index.byNormTitle.get(fullKey) || [];
  if (hits.length === 1) return { status: 'matched', variant: hits[0] };
  if (hits.length > 1) return { status: 'ambiguous', variant: null, candidates: hits };

  // Also try swapped size/color in full label
  if (parsed.size && parsed.color) {
    const swapped = norm(`${parsed.titleBase} - ${parsed.color}, ${parsed.size}`);
    const swapHits = index.byNormTitle.get(swapped) || [];
    if (swapHits.length === 1) return { status: 'matched', variant: swapHits[0] };
  }

  const titleCandidates = [
    resolveTitleBase(parsed.titleBase),
    norm(parsed.titleBase),
    `${norm(parsed.titleBase)} sneakers`,
    norm(parsed.titleBase).replace(/\sboots$/, ' boot'),
  ];

  for (const titleNorm of [...new Set(titleCandidates)]) {
    const hit = matchByProductSizeColor(titleNorm, parsed.size, parsed.color, index);
    if (hit) return hit;
  }

  // Fuzzy: unique product title that starts with / equals alias base
  const resolved = resolveTitleBase(parsed.titleBase);
  const productMatches = [];
  for (const [pt] of index.productsByNormTitle) {
    if (pt === resolved || pt.startsWith(`${resolved} `) || resolved.startsWith(pt)) {
      productMatches.push(pt);
    }
  }
  if (productMatches.length === 1) {
    const hit = matchByProductSizeColor(productMatches[0], parsed.size, parsed.color, index);
    if (hit) return hit;
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
