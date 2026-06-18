import mongoose from 'mongoose';

const discrepancyAlertSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['online_stock_drift', 'inventory_invariant', 'orphan_webhook', 'sync_error'],
      required: true,
    },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Variant' },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    expected: mongoose.Schema.Types.Mixed,
    actual: mongoose.Schema.Types.Mixed,
    message: String,
    resolvedAt: Date,
    resolvedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

discrepancyAlertSchema.index({ resolvedAt: 1, createdAt: -1 });

export default mongoose.model('DiscrepancyAlert', discrepancyAlertSchema);
