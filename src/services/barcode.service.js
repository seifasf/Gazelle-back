import bwipjs from 'bwip-js';
import Variant from '../models/Variant.js';
import '../models/Product.js'; // register for populate

/** Value encoded in the barcode — prefer Shopify barcode, else SKU. */
export function barcodeValueForVariant(variant) {
  const fromShopify = String(variant?.barcode || '').trim();
  if (fromShopify) return fromShopify;
  return String(variant?.sku || '').trim();
}

export async function renderCode128Png(text, { scale = 3, height = 14 } = {}) {
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
    includetext: true,
    textxalign: 'center',
    textsize: 11,
    backgroundcolor: 'FFFFFF',
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
  const png = await renderCode128Png(value);
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
 * copies = how many identical labels (usually = units restocked).
 */
export async function buildBarcodeLabelHtml(variantId, copies = 1) {
  const { png, value, sku, size, color, title } = await getVariantBarcodePng(variantId);
  const n = Math.min(Math.max(Number(copies) || 1, 1), 200);
  const imgSrc = `data:image/png;base64,${png.toString('base64')}`;
  const meta = [color, size ? `Size ${size}` : null].filter(Boolean).join(' · ');

  const labels = Array.from({ length: n }, (_, i) => `
    <div class="label">
      <div class="title">${escapeHtml(title)}</div>
      <div class="meta">${escapeHtml(meta || '—')}</div>
      <img src="${imgSrc}" alt="${escapeHtml(value)}" />
      <div class="sku">SKU ${escapeHtml(sku)}</div>
      <div class="copy">#${i + 1}/${n}</div>
    </div>
  `).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Barcode labels — ${escapeHtml(sku)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 12px; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }
    .toolbar { margin-bottom: 12px; }
    .toolbar button {
      font-size: 14px; padding: 8px 14px; cursor: pointer;
      background: #111; color: #fff; border: 0; border-radius: 6px;
    }
    .sheet {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
    }
    .label {
      border: 1px dashed #999;
      padding: 10px;
      text-align: center;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .title { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
    .meta, .sku, .copy { font-size: 11px; color: #444; }
    img { width: 100%; max-width: 240px; height: auto; margin: 6px 0; }
    @media print {
      .toolbar { display: none; }
      body { margin: 0; }
      .label { border-style: solid; border-color: #ccc; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">Print labels</button>
    <span style="margin-left:8px;color:#666;font-size:13px">${n} × ${escapeHtml(sku)}</span>
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
};
