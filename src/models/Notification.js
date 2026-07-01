import mongoose from 'mongoose';
import { USER_ROLES } from '../constants/index.js';

export const NOTIFICATION_TYPES = [
  'new_order',
  'order_verified',
  'shipment_created',
  'failed_delivery',
  'return_to_origin',
  'low_stock',
  'out_of_stock',
  'discrepancy',
  'stock_intake',
  'general',
];

export const NOTIFICATION_SEVERITIES = ['info', 'success', 'warning', 'danger'];

const notificationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    // Which roles should see this notification.
    roles: [{ type: String, enum: USER_ROLES }],
    title: { type: String, required: true, maxlength: 160 },
    body: { type: String, default: '', maxlength: 600 },
    severity: { type: String, enum: NOTIFICATION_SEVERITIES, default: 'info' },
    link: { type: String },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Variant' },
    // Users (by id) who have read this notification.
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

notificationSchema.index({ roles: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);
