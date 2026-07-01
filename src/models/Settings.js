import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    shopifyShopDomain: String,
    shopifyPublicDomain: String,
    shopifyCatalogMode: { type: String, enum: ['admin', 'storefront', 'none'], default: 'none' },
    shopifyAccessToken: String,
    shopifyClientId: String,
    shopifyClientSecret: String,
    shopifyTokenExpiresAt: Date,
    shopifyWebhookSecret: String,
    shopifyApiVersion: { type: String, default: '2025-01' },
    shopifyShopName: String,
    shopifyLocationId: String,
    shopifyLastSyncAt: Date,
    shopifyWebhooksRegisteredAt: Date,
    shopifyConnectionHealthy: { type: Boolean, default: false },
    shopifyWritePolicy: { type: String, enum: ['oms_only', 'full'], default: 'oms_only' },
    shopifyLastWebhookAt: Date,
    bostaLastSyncAt: Date,
    bostaLastWebhookAt: Date,
    bostaConnectionHealthy: { type: Boolean, default: false },
    bostaCities: [{ id: String, name: String, nameAr: String, code: String }],
    bostaPollingThresholdHours: { type: Number, default: 48 },
    defaultLowStockThreshold: { type: Number, default: 5 },
  },
  { timestamps: true }
);

export default mongoose.model('Settings', settingsSchema);
