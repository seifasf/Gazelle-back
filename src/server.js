import { config } from './config/index.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { createAgenda } from './config/agenda.js';
import { registerJobs, scheduleRecurringJobs } from './jobs/index.js';
import { createApp } from './app.js';
import Product from './models/Product.js';
import Settings from './models/Settings.js';
import { syncCatalog } from './integrations/shopify/sync.service.js';
import { ensureOrdersLoaded } from './integrations/shopify/setup.service.js';
import { ensureChartOfAccounts } from './services/chartOfAccounts.seed.js';
import { ensureBrandExpenses } from './services/brandExpenses.seed.js';
import logger from './utils/logger.js';

async function ensureCatalogLoaded() {
  try {
    const [productCount, settings] = await Promise.all([
      Product.countDocuments(),
      Settings.findOne({ key: 'global' }),
    ]);
    const staleMs = 6 * 60 * 60 * 1000;
    const lastSync = settings?.shopifyLastSyncAt?.getTime() || 0;
    const isStale = Date.now() - lastSync > staleMs;

    if (productCount === 0 || isStale) {
      logger.info({ productCount, isStale }, 'Refreshing catalog from Shopify (read-only)');
      const result = await syncCatalog();
      logger.info(result, 'Catalog refresh complete');
    }

    // After the catalog is present, import orders + customers on first boot.
    await ensureOrdersLoaded();
    await ensureChartOfAccounts();
    await ensureBrandExpenses();
  } catch (err) {
    logger.warn({ err }, 'Startup catalog sync failed — existing data will be served if available');
  }
}

async function startServer() {
  await connectDatabase();

  const agenda = createAgenda();
  registerJobs(agenda);
  await agenda.start();
  await scheduleRecurringJobs(agenda);
  logger.info('Agenda started (jobs + recurring schedules)');

  ensureCatalogLoaded();

  const app = createApp();
  // Bind to 0.0.0.0 so the service is reachable in containerized hosts (Render, etc.).
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    logger.info(`Gazelle API listening on port ${config.PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down server...');

    // Stop accepting new connections, then drain background + DB cleanly.
    await new Promise((resolve) => server.close(resolve));
    try {
      await agenda.stop();
      await disconnectDatabase();
    } catch (err) {
      logger.error({ err }, 'Error during graceful shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Never let an unhandled async error silently take the process down.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
  });
}

startServer().catch((err) => {
  logger.error({ err }, 'Server failed to start');
  process.exit(1);
});
