import mongoose from 'mongoose';
import { GL_CATEGORIES } from '../constants/index.js';

const glAccountSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, maxlength: 20 },
    name: { type: String, required: true, maxlength: 120 },
    category: { type: String, enum: GL_CATEGORIES, required: true },
    type: { type: String, maxlength: 80 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

glAccountSchema.index({ category: 1, code: 1 });

export default mongoose.model('GLAccount', glAccountSchema);
