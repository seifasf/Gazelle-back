import mongoose from 'mongoose';

const variantSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    shopifyVariantId: { type: String, required: true, unique: true },
    shopifyInventoryItemId: { type: String, required: true },
    sku: { type: String, required: true, index: true },
    barcode: String,
    title: { type: String, required: true, maxlength: 255 },
    color: String,
    size: String,
    imageUrl: String,
    compareAtPrice: { type: Number, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    cogs: { type: Number, default: 0, min: 0 },
    onlineStock: { type: Number, default: 0 },
    shopifyAvailable: { type: Boolean },
    onHoldStock: { type: Number, default: 0, min: 0 },
    realStock: { type: Number, default: 0, min: 0 },
    lowStockThreshold: { type: Number, default: 5, min: 0 },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

variantSchema.index({ productId: 1, sku: 1 });
variantSchema.index({ barcode: 1 });
variantSchema.index({ title: 1 });
variantSchema.index({ color: 1 });
variantSchema.index({ size: 1 });
variantSchema.index({ productId: 1, color: 1, size: 1 });
variantSchema.index({ realStock: 1, lowStockThreshold: 1 });

export default mongoose.model('Variant', variantSchema);
