import bwipjs from 'bwip-js';
import Variant from '../models/Variant.js';
import '../models/Product.js'; // register for populate

/** Sticker size in mm (physical label: 5.8 cm wide × 4 cm tall). */
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
 * Code128 bars only (SKU printed as separate bold text under the bars).
 * High scale = sharp bars on print (avoids "dotted" look from upscaling a tiny PNG).
 */
export async function renderCode128Png(text, { scale = 10, height = 18, includetext = false } = {}) {
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
    backgroundcolor: 'FFFFFF',
    paddingwidth: 2,
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
  // Wide, tall bars sized for a 5.8×4 cm sticker.
  const png = await renderCode128Png(value, { scale: 12, height: 20, includetext: false });
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
 * Layout: big centered barcode, bold SKU + product name, all centered.
 * Physical size: 5.8 cm wide × 4 cm tall.
 */
export async function buildBarcodeLabelHtml(variantId, copies = 1) {
  const label = await getVariantBarcodePng(variantId);
  const n = Math.min(Math.max(Number(copies) || 1, 1), 200);
  return buildLabelSheetHtml([{ ...label, copies: n }]);
}

/** Soft cap — multi-product restock can be large; keep HTML / print dialog usable. */
const MAX_BATCH_LABELS = 800;
const MAX_COPIES_PER_SKU = 200;

/**
 * Multiple SKUs in one print sheet.
 * items: [{ variantId, copies }]
 */
export async function buildBarcodeLabelsBatchHtml(items = []) {
  const planned = [];
  let total = 0;
  for (const item of items) {
    const copies = Math.min(Math.max(Number(item.copies) || 1, 1), MAX_COPIES_PER_SKU);
    if (!item.variantId || copies < 1) continue;
    planned.push({ variantId: item.variantId, copies });
    total += copies;
  }
  if (!planned.length) {
    const err = new Error('No barcode labels to print');
    err.statusCode = 400;
    throw err;
  }
  if (total > MAX_BATCH_LABELS) {
    const err = new Error(
      `Too many labels (${total}). Print at most ${MAX_BATCH_LABELS} at a time — select fewer sizes or lower the qty.`
    );
    err.statusCode = 400;
    throw err;
  }

  const rows = [];
  for (const item of planned) {
    const label = await getVariantBarcodePng(item.variantId);
    rows.push({ ...label, copies: item.copies });
  }
  return buildLabelSheetHtml(rows);
}

function buildLabelSheetHtml(labelRows) {
  const totalCopies = labelRows.reduce((s, r) => s + (r.copies || 1), 0);
  const skuSummary = labelRows.map((r) => `${r.copies}× ${r.sku}`).join(', ');

  // Embed each PNG once (not once per sticker).
  const assetsJson = JSON.stringify(labelRows.map((r) => r.png.toString('base64')));

  const labels = labelRows
    .flatMap(({ value, sku, size, color, title, copies }, assetIndex) => {
      const attrs = [color, size != null && size !== '' ? `Size ${size}` : null]
        .filter(Boolean)
        .map((a) => escapeHtml(String(a)))
        .join(' · ');
      return Array.from(
        { length: copies },
        () => `
    <div class="label" data-bc="${assetIndex}" data-alt="${escapeHtml(value)}">
      <div class="label-inner">
        <div class="barcode-wrap"></div>
        <div class="sku">${escapeHtml(sku)}</div>
        <div class="title">${escapeHtml(title || '')}</div>
        ${attrs ? `<div class="attrs">${attrs}</div>` : ''}
      </div>
    </div>`
      );
    })
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Barcode labels · ${LABEL_WIDTH_MM / 10}×${LABEL_HEIGHT_MM / 10} cm</title>
  <style>
    @page {
      size: ${LABEL_WIDTH_MM}mm ${LABEL_HEIGHT_MM}mm;
      margin: 0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: ${LABEL_WIDTH_MM}mm;
      margin: 0;
      padding: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: #000;
      background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
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
    .sheet { display: block; padding: 0; }
    .label {
      width: ${LABEL_WIDTH_MM}mm;
      height: ${LABEL_HEIGHT_MM}mm;
      padding: 1.2mm 1.8mm 1.4mm;
      border: 0.2mm solid #ddd;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      page-break-inside: avoid;
      break-inside: avoid;
      background: #fff;
    }
    .label-inner {
      width: 100%;
      max-width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 0.6mm;
    }
    .barcode-wrap {
      width: 100%;
      height: 23mm;
      display: flex;
      justify-content: center;
      align-items: center;
      flex: 0 0 23mm;
    }
    .barcode {
      width: 100%;
      max-width: 54mm;
      height: 22mm;
      object-fit: fill;
      object-position: center;
      image-rendering: -webkit-optimize-contrast;
      image-rendering: crisp-edges;
      display: block;
    }
    .sku {
      width: 100%;
      font-family: Arial Black, Arial, Helvetica, sans-serif;
      font-size: 11pt;
      font-weight: 900;
      letter-spacing: 0.02em;
      line-height: 1.05;
      text-align: center;
      word-break: break-word;
      color: #000;
    }
    .title {
      width: 100%;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 8.5pt;
      font-weight: 800;
      line-height: 1.1;
      text-align: center;
      max-width: 100%;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: #000;
    }
    .attrs {
      width: 100%;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 8pt;
      font-weight: 800;
      line-height: 1.1;
      text-align: center;
      color: #000;
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
    <button type="button" onclick="window.print()">Print labels</button>
    <span style="margin-left:8px;color:#666;font-size:13px">
      ${totalCopies} sticker${totalCopies === 1 ? '' : 's'} · ${escapeHtml(skuSummary)} · ${LABEL_WIDTH_MM / 10}×${LABEL_HEIGHT_MM / 10} cm
    </span>
  </div>
  <div class="sheet">${labels}</div>
  <script type="application/json" id="barcode-assets">${assetsJson}</script>
  <script>
    (function () {
      var assets = [];
      try {
        assets = JSON.parse(document.getElementById('barcode-assets').textContent || '[]');
      } catch (e) {}
      document.querySelectorAll('.label[data-bc]').forEach(function (el) {
        var i = Number(el.getAttribute('data-bc'));
        var wrap = el.querySelector('.barcode-wrap');
        if (!wrap || !assets[i]) return;
        var img = document.createElement('img');
        img.className = 'barcode';
        img.alt = el.getAttribute('data-alt') || '';
        img.src = 'data:image/png;base64,' + assets[i];
        wrap.appendChild(img);
      });
      window.addEventListener('load', function () {
        setTimeout(function () { window.print(); }, 350);
      });
    })();
  </script>
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
