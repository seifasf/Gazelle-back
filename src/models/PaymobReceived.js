import mongoose from 'mongoose';

/** Ledger of successful Paymob payments — webhook in, amount + date only. */
const paymobReceivedSchema = new mongoose.Schema(
  {
    externalId: { type: String, required: true, unique: true, index: true },
    amountEgp: { type: Number, required: true, min: 0 },
    receivedAt: { type: Date, required: true, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export default mongoose.model('PaymobReceived', paymobReceivedSchema);
