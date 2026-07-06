import mongoose from 'mongoose';
import { ATTENDANCE_STATUSES } from '../constants/index.js';

const attendanceSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: Date, required: true },
    clockIn: Date,
    clockOut: Date,
    hoursWorked: { type: Number, min: 0 },
    status: { type: String, enum: ATTENDANCE_STATUSES, default: 'present' },
    note: { type: String, maxlength: 500 },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

attendanceSchema.index({ employeeId: 1, date: -1 }, { unique: true });

export default mongoose.model('Attendance', attendanceSchema);
