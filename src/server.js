import { config } from './config/index.js';
import { connectDatabase } from './config/database.js';
import { createAgenda } from './config/agenda.js';
import { registerJobs } from './jobs/index.js';
import { createApp } from './app.js';
import logger from './utils/logger.js';

async function startServer() {
  await connectDatabase();

  const agenda = createAgenda();
  registerJobs(agenda);
  await agenda.start();
  logger.info('Agenda started in API process (job producer only)');

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    logger.info(`Gazelle API listening on port ${config.PORT}`);
  });

  const shutdown = async () => {
    logger.info('Shutting down server...');
    server.close();
    await agenda.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  logger.error({ err }, 'Server failed to start');
  process.exit(1);
});
