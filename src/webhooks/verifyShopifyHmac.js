import crypto from 'crypto';
import { config } from '../config/index.js';
import { getShopifyCredentials } from '../integrations/shopify/credentials.js';

export async function verifyShopifyHmac(rawBody, hmacHeader) {
  const creds = await getShopifyCredentials();
  const secret = creds.webhookSecret || config.SHOPIFY_WEBHOOK_SECRET;

  if (!secret) {
    return config.NODE_ENV !== 'production';
  }
  if (!hmacHeader) return false;

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

export default { verifyShopifyHmac };
