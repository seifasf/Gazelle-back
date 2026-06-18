import crypto from 'crypto';
import { config } from '../config/index.js';

export function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!config.SHOPIFY_WEBHOOK_SECRET) {
    return config.NODE_ENV !== 'production';
  }
  if (!hmacHeader) return false;

  const digest = crypto
    .createHmac('sha256', config.SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

export default { verifyShopifyHmac };
