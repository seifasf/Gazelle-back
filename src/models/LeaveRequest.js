import mongoose from 'mongoose';
import { LEAVE_TYPES, LEAVE_STATUSES } from '../constants/index.js';

const leaveRequestSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    type: { type: String, enum: LEAVE_TYPES, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    daysCount: { type: Number, required: true, min: 0.5 },
    reason: { type: String, maxlength: 1000 },
    status: { type: String, enum: LEAVE_STATUSES, default: 'pending' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
  },
  { timestamps: true }
);

leaveRequestSchema.index({ employeeId: 1, status: 1 });
leaveRequestSchema.index({ status: 1, startDate: -1 });

export default mongoose.model('LeaveRequest', leaveRequestSchema);
