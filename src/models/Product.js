import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    shopifyProductId: { type: String, required: true, unique: true },
    title: { type: String, required: true, maxlength: 255 },
    category: { type: String, maxlength: 100 },
    status: { type: String, enum: ['active', 'archived', 'draft'], default: 'active' },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model('Product', productSchema);
