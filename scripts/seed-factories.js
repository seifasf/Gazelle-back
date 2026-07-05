/**
 * Upsert Gazelle manufacturing partners with estimated lead times.
 * Usage: node scripts/seed-factories.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import Factory from '../src/models/Factory.js';
import { DEFAULT_FACTORIES } from '../src/constants/index.js';

async function seedFactories() {
  await connectDatabase();

  for (const factory of DEFAULT_FACTORIES) {
    const existing = await Factory.findOne({ name: factory.name });
    if (existing) {
      existing.leadTimeDays = factory.leadTimeDays;
      existing.isActive = true;
      await existing.save();
      console.log(`Updated ${factory.name} → ${factory.leadTimeDays} days est.`);
    } else {
      await Factory.create({ ...factory, currency: 'EGP', isActive: true });
      console.log(`Created ${factory.name} → ${factory.leadTimeDays} days est.`);
    }
  }

  await disconnectDatabase();
  console.log('Factory seed complete');
}

seedFactories().catch((err) => {
  console.error(err);
  process.exit(1);
});
