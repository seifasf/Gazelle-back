import crypto from 'crypto';
import { config } from '../config/index.js';

/**
 * Paymob Transaction processed callback HMAC (SHA-512).
 * Fields must be concatenated in this exact order (Accept docs).
 * @see https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac
 */
const HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
];

function readPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function computePaymobHmac(obj, secret = config.PAYMOB_HMAC_SECRET) {
  if (!secret || !obj || typeof obj !== 'object') return null;
  const concat = HMAC_FIELDS.map((field) => String(readPath(obj, field) ?? '')).join('');
  return crypto.createHmac('sha512', secret).update(concat).digest('hex');
}

export function verifyPaymobHmac(obj, receivedHmac) {
  if (!config.PAYMOB_HMAC_SECRET) return false;
  if (!receivedHmac || typeof receivedHmac !== 'string') return false;
  const computed = computePaymobHmac(obj);
  if (!computed) return false;
  try {
    const a = Buffer.from(computed, 'utf8');
    const b = Buffer.from(receivedHmac, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export default { computePaymobHmac, verifyPaymobHmac };
