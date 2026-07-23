import bwipjs from 'bwip-js';
import Variant from '../models/Variant.js';
import '../models/Product.js'; // register for populate

/** Sticker size in mm (physical label: 5.8 cm × 4 cm). */
export const LABEL_WIDTH_MM = 58;
export const LABEL_HEIGHT_MM = 40;

/**
 * Value encoded in the barcode — MUST match what is already on warehouse stickers
 * so USB/camera scanners read the same code.
 * Prefer Shopify `barcode` when set; otherwise the exact SKU (no new codes generated).
 */
export function barcodeValueForVariant(variant) {
  const fromShopify = String(variant?.barcode || '').trim();
  if (fromShopify) return fromShopify;
  // Keep SKU casing exactly as stored (e.g. Gwf244-3-38) — do not invent a new value.
  return String(variant?.sku || '').trim();
}

/**
 * Code128 bars only (SKU printed as separate text under the bars, like warehouse stickers).
 */
export async function renderCode128Png(text, { scale = 4, height = 16, includetext = false } = {}) {
  const value = String(text || '').trim();
  if (!value) {
    const err = new Error('Barcode text is required');
    err.statusCode = 400;
    throw err;
  }

  return bwipjs.toBuffer({
    bcid: 'code128',
    text: value,
    scale,
    height,
    includetext,
    textxalign: 'center',
    textsize: 11,
    backgroundcolor: 'FFFFFF',
    paddingwidth: 1,
    paddingheight: 1,
  });
}

export async function getVariantBarcodePng(variantId) {
  const variant = await Variant.findById(variantId).populate('productId', 'title');
  if (!variant) {
    const err = new Error('Variant not found');
    err.statusCode = 404;
    throw err;
  }

  const value = barcodeValueForVariant(variant);
  // Tall, wide bars — fill sticker width and stay crisp when scaled.
  const png = await renderCode128Png(value, { scale: 6, height: 22, includetext: false });
  return {
    png,
    value,
    sku: variant.sku,
    size: variant.size,
    color: variant.color,
    title: variant.productId?.title || variant.title || variant.sku,
  };
}

/**
 * Printable sticker sheet HTML (opens in browser → Print).
 * Layout: big centered barcode, then SKU + product.
 * Physical size: 5.8 cm wide × 4 cm tall.
 * copies = how many identical labels (usually = units restocked).
 */
export async function buildBarcodeLabelHtml(variantId, copies = 1) {
  const label = await getVariantBarcodePng(variantId);
  const n = Math.min(Math.max(Number(copies) || 1, 1), 200);
  return buildLabelSheetHtml([
    { ...label, copies: n },
  ]);
}

/**
 * Multiple SKUs in one print sheet.
 * items: [{ variantId, copies }]
 */
export async function buildBarcodeLabelsBatchHtml(items = []) {
  const rows = [];
  let total = 0;
  for (const item of items) {
    const copies = Math.min(Math.max(Number(item.copies) || 1, 1), 200);
    if (total + copies > 500) break;
    const label = await getVariantBarcodePng(item.variantId);
    rows.push({ ...label, copies });
    total += copies;
  }
  if (!rows.length) {
    const err = new Error('No barcode labels to print');
    err.statusCode = 400;
    throw err;
  }
  return buildLabelSheetHtml(rows);
}

function buildLabelSheetHtml(labelRows) {
  const totalCopies = labelRows.reduce((s, r) => s + (r.copies || 1), 0);
  const skuSummary = labelRows.map((r) => `${r.copies}× ${r.sku}`).join(', ');

  const labels = labelRows
    .flatMap(({ png, value, sku, size, color, title, copies }) => {
      const imgSrc = `data:image/png;base64,${png.toString('base64')}`;
      return Array.from({ length: copies }, () => `
    <div class="label">
      <div class="barcode-wrap">
        <img class="barcode" src="${imgSrc}" alt="${escapeHtml(value)}" />
      </div>
      <div class="sku">${escapeHtml(sku)}</div>
      <div class="meta">
        <div class="title">${escapeHtml(title || '')}</div>
        <div class="attrs">
          ${color ? `<span class="attr">${escapeHtml(color)}</span>` : ''}
          ${size ? `<span class="attr">Size ${escapeHtml(String(size))}</span>` : ''}
        </div>
      </div>
    </div>
  `);
    })
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Barcode labels</title>
  <style>
    @page {
      size: ${LABEL_WIDTH_MM}mm ${LABEL_HEIGHT_MM}mm;
      margin: 0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: ${LABEL_WIDTH_MM}mm;
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: #000;
      background: #fff;
    }
    .toolbar {
      margin: 12px;
      font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
      width: auto;
      max-width: 90vw;
    }
    .toolbar button {
      font-size: 14px; padding: 8px 14px; cursor: pointer;
      background: #111; color: #fff; border: 0; border-radius: 6px;
    }
    .sheet {
      display: block;
      padding: 0;
    }
    .label {
      width: ${LABEL_WIDTH_MM}mm;
      height: ${LABEL_HEIGHT_MM}mm;
      padding: 1mm 1.2mm 1mm;
      border: 0.2mm solid #ccc;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      text-align: center;
      overflow: hidden;
      page-break-inside: avoid;
      break-inside: avoid;
      background: #fff;
    }
    .barcode-wrap {
      width: 100%;
      flex: 1 1 auto;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 20mm;
      max-height: 24mm;
      margin: 0 auto;
    }
    .barcode {
      width: 100%;
      max-width: 100%;
      height: auto;
      max-height: 22mm;
      object-fit: contain;
      object-position: center;
      image-rendering: pixelated;
      display: block;
      margin: 0 auto;
    }
    .sku {
      flex: 0 0 auto;
      width: 100%;
      margin-top: 0.5mm;
      font-family: "Courier New", Courier, monospace;
      font-size: 13pt;
      font-weight: 900;
      letter-spacing: 0.02em;
      line-height: 1.05;
      text-align: center;
      max-width: 100%;
      word-break: break-all;
      text-transform: none;
    }
    .meta {
      flex: 0 0 auto;
      width: 100%;
      margin-top: 0.2mm;
      text-align: center;
    }
    .title {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 9.5pt;
      font-weight: 800;
      line-height: 1.1;
      max-width: 100%;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      text-align: center;
    }
    .attrs {
      margin-top: 0.15mm;
      display: flex;
      justify-content: center;
      gap: 1.2mm;
      flex-wrap: wrap;
    }
    .attr {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 9.5pt;
      font-weight: 800;
      line-height: 1.1;
    }
    @media print {
      .toolbar { display: none !important; }
      html, body {
        width: ${LABEL_WIDTH_MM}mm;
        margin: 0;
        background: #fff;
      }
      .sheet { padding: 0; }
      .label {
        border: none;
        width: ${LABEL_WIDTH_MM}mm;
        height: ${LABEL_HEIGHT_MM}mm;
        page-break-after: always;
        break-after: page;
      }
      .label:last-child {
        page-break-after: auto;
        break-after: auto;
      }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">Print labels</button>
    <span style="margin-left:8px;color:#666;font-size:13px">
      ${totalCopies} sticker${totalCopies === 1 ? '' : 's'} · ${escapeHtml(skuSummary)} · ${LABEL_WIDTH_MM / 10}×${LABEL_HEIGHT_MM / 10} cm
    </span>
  </div>
  <div class="sheet">${labels}</div>
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default {
  barcodeValueForVariant,
  renderCode128Png,
  getVariantBarcodePng,
  buildBarcodeLabelHtml,
  buildBarcodeLabelsBatchHtml,
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
};
