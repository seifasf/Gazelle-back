/**
 * Export product variants to CSV for COGS entry.
 * Usage:
 *   node scripts/export-product-cost-sheet.js [output-path]
 *   node scripts/export-product-cost-sheet.js --active-only [output-path]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Product from '../src/models/Product.js';
import Variant from '../src/models/Variant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  const args = process.argv.slice(2);
  const activeOnly = args.includes('--active-only');
  const outArg = args.find((a) => !a.startsWith('--'));
  const date = new Date().toISOString().slice(0, 10);
  const defaultName = activeOnly
    ? `gazelle-product-cost-sheet-active-${date}.csv`
    : `gazelle-product-cost-sheet-${date}.csv`;
  const outPath = outArg
    ? path.resolve(outArg)
    : path.join(__dirname, '..', 'exports', defaultName);

  await mongoose.connect(process.env.MONGODB_URI);

  const productFilter = activeOnly ? { status: 'active' } : { status: { $in: ['active', 'draft'] } };
  const products = await Product.find(productFilter)
    .sort({ title: 1 })
    .lean();

  const productMap = new Map(products.map((p) => [String(p._id), p]));
  const productIds = products.map((p) => p._id);

  const variants = await Variant.find({ productId: { $in: productIds } })
    .sort({ sku: 1 })
    .lean();

  const headers = [
    'Product Name',
    'SKU',
    'Color',
    'Size',
    'Selling Price (EGP)',
    'Cost Per Piece (EGP)',
    'Variant ID',
  ];

  const rows = variants.map((v) => {
    const product = productMap.get(String(v.productId)) || {};
    const cost = v.cogs > 0 ? v.cogs : '';
    return [
      product.title || v.title,
      v.sku,
      v.color || '',
      v.size || '',
      v.sellingPrice,
      cost,
      String(v._id),
    ];
  });

  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `\uFEFF${csv}`, 'utf8');

  const byStatus = products.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});

  console.log(`Exported ${rows.length} variants from ${products.length} active products`);
  if (!activeOnly) {
    console.log(`Products: active=${byStatus.active || 0}, draft=${byStatus.draft || 0}`);
  }
  console.log(`File: ${outPath}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
