import mongoose from 'mongoose';
import { SALARY_TYPES, HR_DEPARTMENTS } from '../constants/index.js';

const employeeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    employeeCode: { type: String, required: true, unique: true, maxlength: 30 },
    department: { type: String, enum: HR_DEPARTMENTS, default: 'operations' },
    jobTitle: { type: String, maxlength: 120 },
    hireDate: { type: Date, required: true },
    salary: { type: Number, min: 0 },
    salaryType: { type: String, enum: SALARY_TYPES, default: 'monthly' },
    bankAccount: { type: String, maxlength: 80 },
    emergencyContact: {
      name: { type: String, maxlength: 120 },
      phone: { type: String, maxlength: 40 },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

employeeSchema.index({ department: 1, isActive: 1 });

export default mongoose.model('Employee', employeeSchema);
