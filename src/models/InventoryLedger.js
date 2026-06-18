import mongoose from 'mongoose';
import { LEDGER_TYPES, SHOPIFY_SYNC_STATUSES } from '../constants/index.js';

const inventoryLedgerSchema = new mongoose.Schema(
  {
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Variant', required: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    ledgerType: { type: String, enum: LEDGER_TYPES, required: true },
    quantityDelta: { type: Number, required: true },
    reasonCode: String,
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    shopifySyncStatus: { type: String, enum: SHOPIFY_SYNC_STATUSES },
    shopifySyncError: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

inventoryLedgerSchema.index({ variantId: 1, createdAt: -1 });

export default mongoose.model('InventoryLedger', inventoryLedgerSchema);
