/**
 * One-time import: set OMS realStock from the Jul 21 warehouse Excel pivot.
 * Does NOT write to Shopify.
 *
 * Usage:
 *   node scripts/import-real-stock-excel.js [/path/to/file.xlsx] [--dry-run]
 */
import dotenv from 'dotenv';
dotenv.config();

import { resolve } from 'path';
import { connectDatabase } from '../src/config/database.js';
import { importRealStockFromFile } from '../src/services/stockImport.service.js';

const DEFAULT_PATH = '/Users/mac/Desktop/مراقبه جديده 21-7-2026.xlsx';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArg = args.find((a) => !a.startsWith('--'));
const filePath = resolve(fileArg || DEFAULT_PATH);

await connectDatabase();
console.log({ filePath, apply: !dryRun });

const report = await importRealStockFromFile(filePath, {
  actorUserId: null,
  apply: !dryRun,
});

console.log(JSON.stringify({
  sheetName: report.sheetName,
  totalRows: report.totalRows,
  matched: report.matched,
  unmatched: report.unmatched,
  ambiguous: report.ambiguous,
  applied: report.applied,
  unchanged: report.unchanged,
  unmatchedSamples: report.unmatchedSamples,
  ambiguousSamples: report.ambiguousSamples,
}, null, 2));

process.exit(0);
