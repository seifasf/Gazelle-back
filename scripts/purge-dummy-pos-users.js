/**
 * Remove specific dummy POs and Extra OM test users.
 * Usage: node scripts/purge-dummy-pos-users.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import PurchaseOrder from '../src/models/PurchaseOrder.js';
import User from '../src/models/User.js';

const PO_NUMBERS = ['PO-20260709-0001', 'PO-20260706-0001'];

async function run() {
  await connectDatabase();

  const pos = await PurchaseOrder.find({ poNumber: { $in: PO_NUMBERS } }).select('poNumber status totalCost');
  console.log('Matching POs:', pos.map((p) => `${p.poNumber} (${p.status})`));

  const poResult = await PurchaseOrder.deleteMany({ poNumber: { $in: PO_NUMBERS } });
  console.log(`Deleted purchase orders: ${poResult.deletedCount}`);

  const users = await User.find({
    $or: [
      { email: { $regex: /^om-extra-.*@test\.local$/i } },
      { email: { $regex: /@test\.local$/i }, name: 'Extra OM' },
    ],
  }).select('name email role isActive');

  console.log('Matching users:', users.map((u) => `${u.email} (${u.name})`));

  const userResult = await User.deleteMany({
    $or: [
      { email: { $regex: /^om-extra-.*@test\.local$/i } },
      { email: { $regex: /@test\.local$/i }, name: 'Extra OM' },
    ],
  });
  console.log(`Deleted users: ${userResult.deletedCount}`);

  await disconnectDatabase();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
