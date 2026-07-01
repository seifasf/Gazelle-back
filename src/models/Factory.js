import mongoose from 'mongoose';

const factorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    country: { type: String, maxlength: 80 },
    city: { type: String, maxlength: 80 },
    contactName: { type: String, maxlength: 120 },
    contactEmail: { type: String, lowercase: true, trim: true },
    contactPhone: { type: String, maxlength: 40 },
    leadTimeDays: { type: Number, default: 14, min: 0 },
    currency: { type: String, default: 'EGP', maxlength: 8 },
    notes: { type: String, maxlength: 2000 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

factorySchema.index({ name: 1 });
factorySchema.index({ isActive: 1 });

export default mongoose.model('Factory', factorySchema);
