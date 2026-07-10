import mongoose from 'mongoose';

/**
 * Actual amount recorded for a brand expense in a calendar month.
 * Fixed expenses can be overridden here; variable expenses must be entered monthly.
 */
const monthlyExpenseSchema = new mongoose.Schema(
  {
    yearMonth: { type: String, required: true, match: /^\d{4}-\d{2}$/, index: true },
    expenseKey: { type: String, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['EGP', 'USD'], default: 'EGP' },
    /** Normalized EGP amount used in totals. */
    amountEgp: { type: Number, required: true, min: 0 },
    note: { type: String, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

monthlyExpenseSchema.index({ yearMonth: 1, expenseKey: 1 }, { unique: true });

export default mongoose.model('MonthlyExpense', monthlyExpenseSchema);
