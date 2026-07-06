/**
 * Pull live Bosta cities + ensure demo orders exist for the webapp.
 * Usage: node scripts/sync-live-data.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { fetchBostaCities } from '../src/integrations/bosta/cities.service.js';
import { isBostaConfigured } from '../src/integrations/bosta/client.js';

async function main() {
  await connectDatabase();

  if (isBostaConfigured()) {
    const cities = await fetchBostaCities({ force: true });
    console.log(`Synced ${cities.length} Bosta cities to settings`);
  } else {
    console.log('BOSTA_API_KEY not set — skipping cities sync');
  }

  await disconnectDatabase();
  console.log('Done. Refresh the webapp to see updated data.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
