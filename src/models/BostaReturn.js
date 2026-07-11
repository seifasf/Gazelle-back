import mongoose from 'mongoose';

/**
 * Cached Bosta return / RTO deliveries for dashboard analytics.
 * Source of truth for return counts when shipments are created outside Gazelle
 * (e.g. WooCommerce / Bosta dashboard) or when webhooks are missed.
 */
const bostaReturnSchema = new mongoose.Schema(
  {
    bostaDeliveryId: { type: String, required: true, unique: true, index: true },
    trackingNumber: { type: String, index: true },
    businessReference: { type: String, index: true },
    typeCode: Number,
    typeValue: String,
    stateCode: { type: Number, index: true },
    stateValue: String,
    returnedAt: { type: Date, required: true, index: true },
    codAmount: { type: Number, default: 0, min: 0 },
    receiverPhone: String,
    receiverName: String,
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    lastSyncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

bostaReturnSchema.index({ returnedAt: -1, typeCode: 1 });

export default mongoose.model('BostaReturn', bostaReturnSchema);
