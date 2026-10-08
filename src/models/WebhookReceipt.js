import mongoose from 'mongoose';

const webhookReceiptSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ['shopify', 'bosta', 'paymob'], required: true },
    externalId: { type: String, required: true },
    topic: String,
    payload: mongoose.Schema.Types.Mixed,
    processedAt: Date,
    error: String,
    /** Times the replay sweeper re-queued this receipt. */
    replayCount: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

webhookReceiptSchema.index({ source: 1, externalId: 1 }, { unique: true });
webhookReceiptSchema.index({ processedAt: 1, createdAt: 1 });

export default mongoose.model('WebhookReceipt', webhookReceiptSchema);
