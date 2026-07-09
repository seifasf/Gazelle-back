import mongoose from 'mongoose';

const webhookReceiptSchema = new mongoose.Schema(
  {
    source: { type: String, enum: ['shopify', 'bosta', 'paymob'], required: true },
    externalId: { type: String, required: true },
    topic: String,
    payload: mongoose.Schema.Types.Mixed,
    processedAt: Date,
    error: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

webhookReceiptSchema.index({ source: 1, externalId: 1 }, { unique: true });

export default mongoose.model('WebhookReceipt', webhookReceiptSchema);
