import { connectDatabase } from '../config/database.js';
import { createAgenda } from '../config/agenda.js';
import { registerJobs } from '../jobs/index.js';
import logger from '../utils/logger.js';

async function startWorker() {
  await connectDatabase();
  const agenda = createAgenda();
  registerJobs(agenda);
  await agenda.start();
  // Recurring schedules (catalog sync, Bosta polling) run on the API service.
  // A separate `npm run worker` process only drains the job queue — do not
  // call scheduleRecurringJobs there or jobs will be duplicated.
  logger.info('Agenda worker started (job processor only)');

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
