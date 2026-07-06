/**
 * Read-only sync: pull products & variants from Shopify into Gazelle.
 * Uses Admin API when configured; otherwise reads the public storefront JSON.
 * Does NOT write anything back to Shopify.
 *
 * Usage: node scripts/sync-shopify-catalog.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { isShopifyConfigured } from '../src/integrations/shopify/credentials.js';
import { testShopifyConnection } from '../src/integrations/shopify/setup.service.js';
import { syncCatalog } from '../src/integrations/shopify/sync.service.js';

async function main() {
  await connectDatabase();

  if (await isShopifyConfigured()) {
    console.log('Testing Shopify Admin API connection…');
    const test = await testShopifyConnection();
    console.log(`Connected to: ${test.shop.name} (${test.shop.domain})`);
    console.log(`Locations: ${test.locations.map((l) => l.name).join(', ')}`);
  } else {
    console.log('Admin API not configured — syncing from public storefront (read-only)…');
  }

  console.log('Syncing catalog…');
  const result = await syncCatalog();
  console.log(`Done (${result.mode}): ${result.products} products, ${result.variants} variants`);

  await disconnectDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
