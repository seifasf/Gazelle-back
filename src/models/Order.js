import mongoose from 'mongoose';
import { ORDER_STATUSES, VERIFICATION_OUTCOMES } from '../constants/index.js';

const orderItemSchema = new mongoose.Schema(
  {
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Variant', required: true },
    sku: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitSellingPrice: { type: Number, required: true, min: 0 },
    unitCogs: { type: Number, min: 0 },
  },
  { _id: true }
);

const shippingAddressSchema = new mongoose.Schema(
  {
    label: String,
    line1: { type: String, required: true },
    line2: String,
    city: { type: String, required: true },
    zone: String,
    phone: String,
    fullName: String,
  },
  { _id: false }
);

const verificationLogSchema = new mongoose.Schema(
  {
    outcome: { type: String, enum: VERIFICATION_OUTCOMES, required: true },
    note: String,
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const orderSchema = new mongoose.Schema(
  {
    shopifyOrderId: { type: String, required: true, unique: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    shippingAddress: { type: shippingAddressSchema, required: true },
    internalStatus: {
      type: String,
      enum: ORDER_STATUSES,
      default: 'pending_verification',
      index: true,
    },
    bostaDeliveryId: { type: String, index: true },
    bostaTrackingNumber: String,
    assignedOrdersManagerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedStockManagerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    totalSellingPrice: { type: Number, required: true, min: 0 },
    totalCogsSnapshot: { type: Number, min: 0 },
    cancellationReason: String,
    items: { type: [orderItemSchema], required: true, validate: [(v) => v.length > 0, 'Order must have items'] },
    verificationLog: [verificationLogSchema],
    placedAt: { type: Date, required: true },
    verifiedAt: Date,
    deliveredAt: Date,
    closedAt: Date,
    lastStatusUpdateAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

orderSchema.index({ internalStatus: 1, placedAt: 1 });
orderSchema.index({ 'items.variantId': 1, internalStatus: 1 });

export default mongoose.model('Order', orderSchema);
