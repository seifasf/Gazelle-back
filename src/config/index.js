import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('7d'),
  SHOPIFY_SHOP_DOMAIN: z.string().optional(),
  SHOPIFY_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default('2025-01'),
  SHOPIFY_LOCATION_ID: z.string().optional(),
  BOSTA_API_KEY: z.string().optional(),
  BOSTA_API_BASE_URL: z.string().default('https://app.bosta.co/api/v2'),
  APP_URL: z.string().default('http://localhost:4000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
