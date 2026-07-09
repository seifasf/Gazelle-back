/**
 * Import COGS + default factory from pricing sheet CSV.
 *
 * Skips rows where "Cost Per Piece (EGP)" is empty (discontinued / not in brand).
 * Matches variants by Variant ID column (Mongo _id).
 * Factory column: matched case-insensitively to existing DB factories; new names
 * are created automatically (lead time from seed defaults when available).
 *
 * Usage:
 *   node scripts/import-pricing-sheet.js "/path/to/SYSTEM PRICING SHEET 26.csv"
 *   node scripts/import-pricing-sheet.js --dry-run "/path/to/sheet.csv"
 */
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import Product from '../src/models/Product.js';
import Variant from '../src/models/Variant.js';
import Factory from '../src/models/Factory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

/** Lowercase key for matching sheet labels to DB factory names */
function factoryKey(raw) {
  return (raw || '').trim().toLowerCase();
}

/** Display name when creating a factory that does not exist yet */
function titleCaseFactoryName(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function importLabelFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(parseCsvLine);
}

function findFactoryColumn(row) {
  for (let i = row.length - 1; i >= 8; i--) {
    const cell = (row[i] || '').trim();
    if (cell) return cell;
  }
  return '';
}

async function ensureFactories(factoryNames, dryRun) {
  const existing = await Factory.find().lean();
  const byKey = new Map(existing.map((f) => [factoryKey(f.name), f]));
  const resolved = new Map();

  for (const rawName of factoryNames) {
    const key = factoryKey(rawName);
    if (!key || resolved.has(key)) continue;

    const found = byKey.get(key);
    if (found) {
      resolved.set(key, found);
      continue;
    }

    const name = titleCaseFactoryName(rawName);
    const doc = {
      name,
      currency: 'EGP',
      isActive: true,
    };

    if (dryRun) {
      resolved.set(key, { _id: `dry-${key}`, name });
      console.log(`  [dry-run] Would create factory: ${name}`);
    } else {
      const created = await Factory.create(doc);
      byKey.set(key, created.toObject());
      resolved.set(key, created.toObject());
      console.log(`  Created factory: ${name}`);
    }
  }

  return resolved;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const fileArg = args.find((a) => !a.startsWith('--'));

  if (!fileArg) {
    console.error('Usage: node scripts/import-pricing-sheet.js [--dry-run] <csv-path>');
    process.exit(1);
  }

  const csvPath = path.resolve(fileArg);
  if (!fs.existsSync(csvPath)) {
    console.error(`File not found: ${csvPath}`);
    process.exit(1);
  }
  const importLabel = importLabelFromPath(csvPath);

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows[0] || [];
  console.log(`Reading ${csvPath}`);
  console.log(`Header: ${header.slice(0, 8).join(' | ')}`);

  const importRows = [];
  let skippedNoCost = 0;
  let skippedBadCost = 0;
  let skippedNoVariantId = 0;

  for (const row of rows.slice(1)) {
    const costRaw = (row[6] || '').trim();
    if (!costRaw) {
      skippedNoCost++;
      continue;
    }

    const cost = Number(costRaw);
    if (!Number.isFinite(cost) || cost < 0) {
      skippedBadCost++;
      continue;
    }

    const variantId = (row[7] || '').trim();
    if (!variantId || !mongoose.isValidObjectId(variantId)) {
      skippedNoVariantId++;
      continue;
    }

    importRows.push({
      productName: (row[0] || '').trim(),
      status: (row[1] || '').trim(),
      sku: (row[2] || '').trim(),
      cost,
      variantId,
      factoryRaw: findFactoryColumn(row),
    });
  }

  console.log(`\nParsed rows with cost: ${importRows.length}`);
  console.log(`Skipped (no cost): ${skippedNoCost}`);
  if (skippedBadCost) console.log(`Skipped (invalid cost): ${skippedBadCost}`);
  if (skippedNoVariantId) console.log(`Skipped (bad variant id): ${skippedNoVariantId}`);

  await connectDatabase();

  const factoryNames = [...new Set(importRows.map((r) => r.factoryRaw).filter(Boolean))];
  console.log(`\nFactories in sheet: ${factoryNames.join(', ')}`);
  const factoryMap = await ensureFactories(factoryNames, dryRun);

  const variantIds = importRows.map((r) => r.variantId);
  const variants = await Variant.find({ _id: { $in: variantIds } }).select('_id productId cogs sku').lean();
  const variantById = new Map(variants.map((v) => [String(v._id), v]));

  let updatedVariants = 0;
  let missingVariants = 0;
  const productFactory = new Map();

  const bulkOps = [];
  for (const row of importRows) {
    const variant = variantById.get(row.variantId);
    if (!variant) {
      missingVariants++;
      continue;
    }

    bulkOps.push({
      updateOne: {
        filter: { _id: variant._id },
        update: { $set: { cogs: row.cost } },
      },
    });
    updatedVariants++;

    if (row.factoryRaw) {
      const factory = factoryMap.get(factoryKey(row.factoryRaw));
      if (factory) {
        productFactory.set(String(variant.productId), factory._id);
      }
    }
  }

  if (!dryRun && bulkOps.length) {
    const CHUNK = 500;
    for (let i = 0; i < bulkOps.length; i += CHUNK) {
      await Variant.bulkWrite(bulkOps.slice(i, i + CHUNK));
    }
  }

  let updatedProducts = 0;
  for (const [productId, factoryId] of productFactory) {
    if (dryRun) {
      updatedProducts++;
      continue;
    }
    await Product.findByIdAndUpdate(productId, { defaultFactoryId: factoryId });
    updatedProducts++;
  }

  const withCogs = dryRun
    ? updatedVariants
    : await Variant.countDocuments({ cogs: { $gt: 0 } });
  const withFactory = dryRun
    ? updatedProducts
    : await Product.countDocuments({ defaultFactoryId: { $ne: null } });

  console.log('\n--- Summary ---');
  console.log(`${dryRun ? '[DRY RUN] ' : ''}Variants ${dryRun ? 'would update' : 'updated'}: ${updatedVariants}`);
  console.log(`Variants not found in DB: ${missingVariants}`);
  console.log(`Products ${dryRun ? 'would link' : 'linked'} to factory: ${updatedProducts}`);
  console.log(`Total variants with COGS > 0: ${withCogs}`);
  console.log(`Total products with default factory: ${withFactory}`);
  console.log(`Import label: ${importLabel}`);

  await disconnectDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
