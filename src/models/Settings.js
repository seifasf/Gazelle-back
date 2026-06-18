import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    shopifyLocationId: String,
    shopifyLastSyncAt: Date,
    shopifyConnectionHealthy: { type: Boolean, default: false },
    bostaLastSyncAt: Date,
    bostaConnectionHealthy: { type: Boolean, default: false },
    bostaPollingThresholdHours: { type: Number, default: 48 },
    defaultLowStockThreshold: { type: Number, default: 5 },
  },
  { timestamps: true }
);

export default mongoose.model('Settings', settingsSchema);
