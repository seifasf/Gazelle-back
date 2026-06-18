import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import apiRoutes from './routes/index.js';
import shopifyWebhookRouter from './webhooks/shopify.router.js';
import bostaWebhookRouter from './webhooks/bosta.router.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import logger from './utils/logger.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
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

  app.use(express.json());
  app.use('/api/v1', apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
