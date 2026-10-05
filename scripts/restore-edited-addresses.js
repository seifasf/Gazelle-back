/**
 * Restore ship-to edits the orders manager made during verification that the
 * Shopify order sync later overwrote, then lock them so the sync leaves them alone.
 *
 * Source of truth: the last "Address updated -> line1 / zone / city / shipping EGP x"
 * verification note. Name/phone come from the customer record only when it was
 * saved in the same request as that note.
 *
 * Usage:
 *   node scripts/restore-edited-addresses.js          # dry run
 *   node scripts/restore-edited-addresses.js --apply  # write changes
 *
 * Run --apply only after the backend with shippingAddressLockedAt is deployed,
 * otherwise the old 5-minute sync reverts the addresses again.
 */
import dotenv from 'dotenv';
dotenv.config();

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import Order from '../src/models/Order.js';
import Customer from '../src/models/Customer.js';

const APPLY = process.argv.includes('--apply');
const DONE_STATUSES = new Set(['delivered', 'cancelled', 'returned_to_stock', 'refunded']);
const SAME_REQUEST_MS = 5000;

const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();

function parseNote(note) {
  const body = String(note || '')
    .replace(/^Address updated\s*\S+\s*/, '')
    .replace(/\s*\u00b7\s*shipping EGP.*$/, '');
  const parts = body.split(/\s+\u00b7\s+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  // City is left alone: some orders store a Bosta city id there, the note only has the label.
  if (parts.length >= 3) return { line1: parts[0], zone: parts[1] };
  return { line1: parts[0] };
}

async function run() {
  await connectDatabase();

  const orders = await Order.find({
    'verificationLog.note': /^Address updated/,
    shippingAddressLockedAt: null,
  });

  let restored = 0;
  let lockedOnly = 0;

  for (const order of orders) {
    if (DONE_STATUSES.has(order.internalStatus)) continue;
    const edits = order.verificationLog.filter((l) => /^Address updated/.test(l.note || ''));
    const last = edits[edits.length - 1];
    const parsed = parseNote(last?.note);
    if (!parsed) continue;

    const current = order.shippingAddress?.toObject?.() || order.shippingAddress || {};
    const next = { ...current, ...parsed };

    const customer = await Customer.findById(order.customerId).select('fullName phone updatedAt').lean();
    const savedTogether =
      customer?.updatedAt && last.createdAt &&
      Math.abs(new Date(customer.updatedAt) - new Date(last.createdAt)) < SAME_REQUEST_MS;
    if (savedTogether) {
      if (customer.fullName) next.fullName = customer.fullName;
      if (customer.phone) next.phone = customer.phone;
    }

    const changed = ['line1', 'zone', 'fullName', 'phone'].filter(
      (k) => norm(next[k]) !== norm(current[k])
    );

    console.log(
      `${order.shopifyOrderName || order._id} [${order.internalStatus}] ${changed.length ? `restore ${changed.join(', ')}` : 'lock only'}`
    );
    for (const k of changed) console.log(`    ${k}: "${norm(current[k])}" -> "${norm(next[k])}"`);

    if (APPLY) {
      if (changed.length) order.shippingAddress = next;
      order.shippingAddressLockedAt = last.createdAt || new Date();
      order.shippingAddressLockedBy = last.actorUserId;
      await order.save();
    }
    if (changed.length) restored += 1;
    else lockedOnly += 1;
  }

  console.log(`\n${APPLY ? 'Applied' : 'Dry run'}: ${restored} restored, ${lockedOnly} locked only.`);
  await disconnectDatabase();
}

run().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
