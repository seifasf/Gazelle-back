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
    shopifyApiVersion: { type: String, default: '2026-07' },
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
    bostaCities: [{ id: String, name: String, nameAr: String, code: String, alias: String }],
    bostaPollingThresholdHours: { type: Number, default: 48 },
    flextockLastSyncAt: Date,
    flextockConnectionHealthy: { type: Boolean, default: false },
    flextockLastError: String,
    /** Merchant portal username / password / API key (overrides Render env when set). */
    flextockUsername: String,
    flextockPassword: String,
    flextockApiKey: String,
    /** PDF integration_source / vendor_name — must match the Flextock merchant name. */
    flextockIntegrationSource: String,
    flextockVendorName: String,
    defaultLowStockThreshold: { type: Number, default: 5 },
    /** Next sequential number for manual order codes (M-1000, M-1001, …). */
    manualOrderNextSeq: { type: Number },
  },
  { timestamps: true }
);

export default mongoose.model('Settings', settingsSchema);
