import mongoose from 'mongoose';
import { ORDER_STATUSES, STATUS_SOURCES } from '../constants/index.js';

const orderStatusHistorySchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    fromStatus: { type: String, enum: [...ORDER_STATUSES, null] },
    toStatus: { type: String, enum: ORDER_STATUSES, required: true },
    source: { type: String, enum: STATUS_SOURCES, required: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

orderStatusHistorySchema.index({ orderId: 1, createdAt: -1 });

export default mongoose.model('OrderStatusHistory', orderStatusHistorySchema);
