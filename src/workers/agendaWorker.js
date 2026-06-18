import { connectDatabase } from '../config/database.js';
import { createAgenda } from '../config/agenda.js';
import { registerJobs, scheduleRecurringJobs } from '../jobs/index.js';
import logger from '../utils/logger.js';

async function startWorker() {
  await connectDatabase();
  const agenda = createAgenda();
  registerJobs(agenda);
  await agenda.start();
  await scheduleRecurringJobs(agenda);
  logger.info('Agenda worker started');

  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await agenda.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startWorker().catch((err) => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});
