import mongoose from 'mongoose';

const brandExpenseSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, maxlength: 120 },
    kind: { type: String, enum: ['fixed', 'variable'], required: true, index: true },
    /** Default / fixed amount in `currency`. For variables this is a typical mid estimate. */
    amount: { type: Number, required: true, min: 0 },
    amountMin: { type: Number, min: 0 },
    amountMax: { type: Number, min: 0 },
    currency: { type: String, enum: ['EGP', 'USD'], default: 'EGP' },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

brandExpenseSchema.index({ kind: 1, sortOrder: 1 });

export default mongoose.model('BrandExpense', brandExpenseSchema);
