import mongoose from 'mongoose';
import { PO_STATUSES } from '../constants/index.js';

const poItemSchema = new mongoose.Schema(
  {
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Variant', required: true },
    sku: { type: String, required: true },
    title: String,
    color: String,
    size: String,
    quantity: { type: Number, required: true, min: 1 },
    unitCost: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'EGP' },
  },
  { _id: true }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNumber: { type: String, required: true, unique: true },
    factoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Factory', required: true },
    status: { type: String, enum: PO_STATUSES, default: 'draft' },
    items: [poItemSchema],
    totalCost: { type: Number, default: 0, min: 0 },
    expectedDeliveryDate: Date,
    notes: { type: String, maxlength: 2000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sentAt: Date,
    receivedAt: Date,
  },
  { timestamps: true }
);

purchaseOrderSchema.index({ factoryId: 1, status: 1 });
purchaseOrderSchema.index({ status: 1, createdAt: -1 });
purchaseOrderSchema.index({ 'items.variantId': 1, status: 1 });

export default mongoose.model('PurchaseOrder', purchaseOrderSchema);
