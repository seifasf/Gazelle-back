import mongoose from 'mongoose';

const cogsBatchSchema = new mongoose.Schema(
  {
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Variant', required: true, index: true },
    batchLabel: { type: String, required: true },
    cogs: { type: Number, required: true, min: 0 },
    quantity: { type: Number, min: 0 },
    receivedAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('CogsBatch', cogsBatchSchema);
