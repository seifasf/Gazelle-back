import mongoose from 'mongoose';
import { RISK_FLAGS } from '../constants/index.js';

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, maxlength: 50 },
    line1: { type: String, required: true, maxlength: 255 },
    line2: { type: String, maxlength: 255 },
    city: { type: String, required: true, maxlength: 100 },
    zone: { type: String, maxlength: 100 },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true }
);

const customerSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, maxlength: 120 },
    phone: { type: String, required: true, index: true },
    email: { type: String, lowercase: true, trim: true },
    /** Optional; used for returns / audience analytics. */
    gender: { type: String, enum: ['male', 'female', 'unknown'], default: 'unknown', index: true },
    shopifyCustomerId: { type: String, index: { unique: true, sparse: true } },
    riskFlag: { type: String, enum: RISK_FLAGS, default: 'none' },
    lifetimeOrders: { type: Number, default: 0, min: 0 },
    lifetimeDelivered: { type: Number, default: 0, min: 0 },
    lifetimeRejectedOrReturned: { type: Number, default: 0, min: 0 },
    /** Customer-initiated / OMS cancellations (not returns). */
    lifetimeCancelled: { type: Number, default: 0, min: 0 },
    addresses: [addressSchema],
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

customerSchema.index({ phone: 1, fullName: 1 });

export default mongoose.model('Customer', customerSchema);
