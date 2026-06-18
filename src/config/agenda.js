import Agenda from 'agenda';
import { config } from './index.js';

let agendaInstance = null;

export function createAgenda() {
  if (agendaInstance) return agendaInstance;

  agendaInstance = new Agenda({
    db: {
      address: config.MONGODB_URI,
      collection: 'agendaJobs',
    },
    processEvery: '30 seconds',
    maxConcurrency: 10,
    defaultConcurrency: 5,
  });

  return agendaInstance;
}

export function getAgenda() {
  if (!agendaInstance) {
    throw new Error('Agenda not initialized. Call createAgenda() first.');
  }
  return agendaInstance;
}
