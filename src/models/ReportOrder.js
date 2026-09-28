import mongoose from 'mongoose';
import { orderSchema } from './Order.js';

/**
 * Read-only view of the `orders` collection for sales / accounting / KPI reports.
 * Repair orders are a brand service, not sales — every query here skips them.
 */
export const NOT_REPAIR_ORDER = { isRepairOrder: { $ne: true } };

const reportOrderSchema = orderSchema.clone();
reportOrderSchema.set('autoIndex', false);

reportOrderSchema.pre(['find', 'findOne', 'countDocuments', 'distinct'], function excludeRepair() {
  this.where(NOT_REPAIR_ORDER);
});

reportOrderSchema.pre('aggregate', function excludeRepair() {
  this.pipeline().unshift({ $match: NOT_REPAIR_ORDER });
});

export default mongoose.models.ReportOrder || mongoose.model('ReportOrder', reportOrderSchema, 'orders');
