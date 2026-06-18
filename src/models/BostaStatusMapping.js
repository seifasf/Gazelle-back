import mongoose from 'mongoose';
import { ORDER_STATUSES } from '../constants/index.js';

const bostaStatusMappingSchema = new mongoose.Schema(
  {
    bostaState: { type: String, required: true, unique: true },
    internalStatus: { type: String, enum: ORDER_STATUSES, required: true },
    isActive: { type: Boolean, default: true },
    description: String,
  },
  { timestamps: true }
);

export default mongoose.model('BostaStatusMapping', bostaStatusMappingSchema);
