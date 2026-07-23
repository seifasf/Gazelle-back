import mongoose from 'mongoose';
import {
  ORDER_STATUSES,
  VERIFICATION_OUTCOMES,
  ORDER_SOURCES,
  MANUAL_ORDER_SOURCES,
  SHIPPING_METHODS,
} from '../constants/index.js';

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
    shopifyOrderId: { type: String, required: true, unique: true, index: true },
    /** Human Shopify name e.g. "#43899" — preferred for UI; shopifyOrderId stays the Admin API id. */
    shopifyOrderName: { type: String, trim: true, index: true },
    orderSource: { type: String, enum: ORDER_SOURCES, default: 'shopify', index: true },
    manualSource: { type: String, enum: MANUAL_ORDER_SOURCES },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    shippingAddress: {
      type: shippingAddressSchema,
      // Pickup orders do not require shipping details.
      required() {
        return this.shippingMethod !== 'pickup';
      },
    },
    shippingMethod: { type: String, enum: SHIPPING_METHODS, default: 'bosta', index: true },
    // "cod" means the customer pays Cash on Delivery (typically Bosta COD).
    // "online" means the customer already paid via an online provider (Paymob, etc.).
    paymentMethod: { type: String, enum: ['cod', 'online'], default: 'cod', index: true },
    // Stored for accounting + analytics; for now manual orders can leave it empty/0.
    shippingFee: { type: Number, default: 0, min: 0 },
    // Online-payment tracking (optional until Paymob webhook is connected).
    onlinePaymentStatus: { type: String, enum: ['none', 'pending', 'paid', 'failed'], default: 'none' },
    onlinePaymentProvider: String,
    onlinePaymentReference: String,
    onlinePaymentAmount: { type: Number, min: 0, default: 0 },
    onlinePaidAt: Date,
    // Bosta COD collection (best-effort; persisted when Bosta sends status webhooks).
    bostaCollectedAmount: { type: Number, min: 0, default: 0 },
    bostaCollectedAt: Date,
    internalStatus: {
      type: String,
      enum: ORDER_STATUSES,
      default: 'pending_verification',
      index: true,
    },
    bostaDeliveryId: { type: String, index: true },
    bostaTrackingNumber: String,
    bostaShipmentStatus: {
      type: String,
      enum: ['none', 'queued', 'creating', 'created', 'failed'],
      default: 'none',
    },
    bostaShipmentError: String,
    localShippingNote: String,
    localShippingMarkedAt: Date,
    assignedOrdersManagerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignedStockManagerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    totalSellingPrice: { type: Number, required: true, min: 0 },
    totalCogsSnapshot: { type: Number, min: 0 },
    cancellationReason: String,
    isCreatorOrder: { type: Boolean, default: false },
    /** Manual exchange shipment against a previous order — total is 0. */
    isExchangeOrder: { type: Boolean, default: false, index: true },
    exchangeFromOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    items: { type: [orderItemSchema], required: true, validate: [(v) => v.length > 0, 'Order must have items'] },
    verificationLog: [verificationLogSchema],
    placedAt: { type: Date, required: true },
    verifiedAt: Date,
    deliveredAt: Date,
    closedAt: Date,
    lastStatusUpdateAt: { type: Date, default: Date.now },
    /** Customer asked to delay — call again on this Cairo calendar day. */
    delayedUntil: { type: Date, index: true },
    delayNote: { type: String, maxlength: 500 },
    /** Idempotency: YYYY-MM-DD already notified for delayedUntil. */
    delayNotifiedOn: String,
  },
  { timestamps: true }
);

orderSchema.index({ internalStatus: 1, placedAt: 1 });
orderSchema.index({ 'items.variantId': 1, internalStatus: 1 });
orderSchema.index({ placedAt: 1 });
orderSchema.index({ deliveredAt: 1, internalStatus: 1 });
orderSchema.index({ bostaCollectedAt: 1 });
orderSchema.index({ paymentMethod: 1, onlinePaidAt: 1 });
orderSchema.index({ onlinePaymentStatus: 1, onlinePaidAt: 1 });

export default mongoose.model('Order', orderSchema);
