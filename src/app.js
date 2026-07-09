import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { config } from './config/index.js';
import apiRoutes from './routes/index.js';
import shopifyWebhookRouter from './webhooks/shopify.router.js';
import bostaWebhookRouter from './webhooks/bosta.router.js';
import paymobWebhookRouter from './webhooks/paymob.router.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import logger from './utils/logger.js';

function corsOptions() {
  const raw = config.CORS_ORIGIN?.trim();
  if (!raw) return {};
  const origins = raw.split(',').map((o) => o.trim()).filter(Boolean);
  return {
    origin: origins.length === 1 ? origins[0] : origins,
    credentials: true,
  };
}

export function createApp() {
  const app = express();

  // Render (and similar hosts) terminate TLS at the edge.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors(corsOptions()));
  app.use(pinoHttp({ logger }));

  // Raw body for Shopify HMAC verification
  app.use(
    '/webhooks/shopify',
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    }),
    shopifyWebhookRouter
  );

  app.use('/webhooks/bosta', express.json(), bostaWebhookRouter);

  // Paymob online-payment webhooks.
  app.use('/webhooks/paymob', express.json(), paymobWebhookRouter);

  app.use(express.json());
  app.use('/api/v1', apiRoutes);

  app.get('/', (_req, res) => {
    res.json({
      name: 'Gazelle OMS API',
      status: 'ok',
      health: '/api/v1/health',
      docs: 'Use the Gazelle web app at https://gazelle-system.vercel.app',
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
