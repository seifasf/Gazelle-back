import mongoose from 'mongoose';
import { JOURNAL_SOURCES } from '../constants/index.js';

const journalLineSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'GLAccount', required: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    note: String,
  },
  { _id: true }
);

const journalEntrySchema = new mongoose.Schema(
  {
    date: { type: Date, required: true, default: Date.now },
    description: { type: String, required: true, maxlength: 255 },
    reference: { type: String, maxlength: 80 },
    source: { type: String, enum: JOURNAL_SOURCES, default: 'manual' },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lines: [journalLineSchema],
  },
  { timestamps: true }
);

journalEntrySchema.index({ date: -1 });
journalEntrySchema.index({ orderId: 1 });
journalEntrySchema.index({ source: 1 });

export default mongoose.model('JournalEntry', journalEntrySchema);
