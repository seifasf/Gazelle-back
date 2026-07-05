/**
 * Seed admin user, default settings, and Bosta status mappings.
 * Usage: node scripts/seed.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import User from '../src/models/User.js';
import Settings from '../src/models/Settings.js';
import BostaStatusMapping from '../src/models/BostaStatusMapping.js';
import Factory from '../src/models/Factory.js';
import { DEFAULT_FACTORIES } from '../src/constants/index.js';
import bcrypt from 'bcrypt';

const DEFAULT_BOSTA_MAPPINGS = [
  { bostaState: 'PICKED_UP', internalStatus: 'picked_up_by_bosta', description: 'Courier picked up package' },
  { bostaState: 'IN_TRANSIT', internalStatus: 'in_transit', description: 'Package in transit' },
  { bostaState: 'DELIVERED', internalStatus: 'delivered', description: 'Successfully delivered' },
  { bostaState: 'FAILED', internalStatus: 'failed_delivery', description: 'Delivery attempt failed' },
  { bostaState: 'RETURNED', internalStatus: 'returning_to_origin', description: 'Return to origin' },
  { bostaState: 'RETURNED_TO_BUSINESS', internalStatus: 'returning_to_origin', description: 'Returned to sender' },
];

async function seed() {
  await connectDatabase();

  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@gazelle.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'changeme123';

  const existing = await User.findOne({ email: adminEmail });
  if (!existing) {
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await User.create({
      name: 'Admin',
      email: adminEmail,
      passwordHash,
      role: 'admin',
    });
    console.log(`Created admin user: ${adminEmail}`);
  } else {
    console.log(`Admin user already exists: ${adminEmail}`);
  }

  await Settings.findOneAndUpdate(
    { key: 'global' },
    { key: 'global' },
    { upsert: true }
  );
  console.log('Settings document ensured');

  for (const mapping of DEFAULT_BOSTA_MAPPINGS) {
    await BostaStatusMapping.findOneAndUpdate(
      { bostaState: mapping.bostaState },
      { ...mapping, isActive: true },
      { upsert: true }
    );
  }
  console.log(`Seeded ${DEFAULT_BOSTA_MAPPINGS.length} Bosta status mappings`);

  for (const factory of DEFAULT_FACTORIES) {
    await Factory.findOneAndUpdate(
      { name: factory.name },
      { ...factory, currency: 'EGP', isActive: true },
      { upsert: true, new: true }
    );
  }
  console.log(`Seeded ${DEFAULT_FACTORIES.length} factories`);

  await disconnectDatabase();
  console.log('Seed complete');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
