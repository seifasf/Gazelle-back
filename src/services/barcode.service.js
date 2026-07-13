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
export async function renderCode128Png(text, { scale = 3, height = 12, includetext = false } = {}) {
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
    paddingwidth: 2,
    paddingheight: 2,
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
  // Slightly taller bars for the 58×40mm sticker; no embedded text under bars.
  const png = await renderCode128Png(value, { scale: 3, height: 14, includetext: false });
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
 * Layout matches warehouse labels: barcode on top, SKU, then product name.
 * Physical size: 5.8 cm wide × 4 cm tall.
 * copies = how many identical labels (usually = units restocked).
 */
export async function buildBarcodeLabelHtml(variantId, copies = 1) {
  const { png, value, sku, size, color, title } = await getVariantBarcodePng(variantId);
  const n = Math.min(Math.max(Number(copies) || 1, 1), 200);
  const imgSrc = `data:image/png;base64,${png.toString('base64')}`;

  // Title line can include color/size when present (same product content as before).
  const detailParts = [title, color, size ? `Size ${size}` : null].filter(Boolean);
  const detailText = detailParts.join(' — ');

  const labels = Array.from({ length: n }, () => `
    <div class="label">
      <div class="barcode-wrap">
        <img class="barcode" src="${imgSrc}" alt="${escapeHtml(value)}" />
      </div>
      <div class="sku">${escapeHtml(sku)}</div>
      <div class="title">${escapeHtml(detailText)}</div>
    </div>
  `).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Barcode labels — ${escapeHtml(sku)}</title>
  <style>
    @page {
      size: ${LABEL_WIDTH_MM}mm ${LABEL_HEIGHT_MM}mm;
      margin: 0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: #000;
      background: #fff;
    }
    .toolbar {
      margin: 12px;
      font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
    }
    .toolbar button {
      font-size: 14px; padding: 8px 14px; cursor: pointer;
      background: #111; color: #fff; border: 0; border-radius: 6px;
    }
    .sheet {
      display: flex;
      flex-wrap: wrap;
      gap: 4mm;
      padding: 4mm;
      align-content: flex-start;
    }
    .label {
      width: ${LABEL_WIDTH_MM}mm;
      height: ${LABEL_HEIGHT_MM}mm;
      padding: 2.5mm 3mm 2mm;
      border: 0.3mm solid #ddd;
      border-radius: 1.5mm;
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
      flex: 0 0 auto;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 14mm;
      max-height: 18mm;
    }
    .barcode {
      width: 92%;
      max-width: 52mm;
      height: 15mm;
      object-fit: fill;
      image-rendering: pixelated;
    }
    .sku {
      margin-top: 1.2mm;
      font-family: "Times New Roman", Times, Georgia, serif;
      font-size: 9.5pt;
      font-weight: 700;
      letter-spacing: 0.02em;
      line-height: 1.15;
      max-width: 100%;
      word-break: break-all;
    }
    .title {
      margin-top: 0.8mm;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 7.5pt;
      font-weight: 400;
      line-height: 1.2;
      max-width: 100%;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
    }
    @media print {
      .toolbar { display: none !important; }
      body { margin: 0; background: #fff; }
      .sheet { padding: 0; gap: 0; }
      .label {
        border: none;
        border-radius: 0;
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
      ${n} × ${escapeHtml(sku)} · sticker ${LABEL_WIDTH_MM / 10}×${LABEL_HEIGHT_MM / 10} cm
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
  LABEL_WIDTH_MM,
  LABEL_HEIGHT_MM,
};
