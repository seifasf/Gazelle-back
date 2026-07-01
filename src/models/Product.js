import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    shopifyProductId: { type: String, required: true, unique: true },
    title: { type: String, required: true, maxlength: 255 },
    handle: String,
    vendor: String,
    productType: { type: String, maxlength: 100 },
    imageUrl: String,
    tags: [String],
    category: { type: String, maxlength: 100 },
    status: { type: String, enum: ['active', 'archived', 'draft'], default: 'active' },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

productSchema.index({ title: 1 });
productSchema.index({ vendor: 1 });
productSchema.index({ productType: 1 });
productSchema.index({ handle: 1 });
productSchema.index({ tags: 1 });
productSchema.index({ status: 1, title: 1 });

export default mongoose.model('Product', productSchema);
