import mongoose from 'mongoose';
import { config } from './index.js';
import logger from '../utils/logger.js';

let listenersBound = false;

function bindConnectionListeners() {
  if (listenersBound) return;
  listenersBound = true;

  const conn = mongoose.connection;
  conn.on('connected', () => logger.info('MongoDB connection established'));
  conn.on('disconnected', () => logger.warn('MongoDB disconnected — driver will retry'));
  conn.on('reconnected', () => logger.info('MongoDB reconnected'));
  conn.on('error', (err) => logger.error({ err }, 'MongoDB connection error'));
}

/**
 * Connect to MongoDB with production-grade pooling and timeouts. The driver
 * transparently retries reads/writes and re-establishes the pool on transient
 * network blips, which keeps the API resilient over long-running deployments.
 */
export async function connectDatabase() {
  mongoose.set('strictQuery', true);
  bindConnectionListeners();

  await mongoose.connect(config.MONGODB_URI, {
    // Pool sizing: enough concurrency for the API without exhausting Atlas.
    maxPoolSize: config.MONGODB_MAX_POOL_SIZE,
    minPoolSize: config.MONGODB_MIN_POOL_SIZE,
    // Fail fast when the cluster is unreachable rather than hanging requests.
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    // Drop idle sockets so the pool stays healthy across quiet periods.
    maxIdleTimeMS: 60_000,
    retryWrites: true,
    retryReads: true,
  });

  logger.info(
    { maxPoolSize: config.MONGODB_MAX_POOL_SIZE, minPoolSize: config.MONGODB_MIN_POOL_SIZE },
    'MongoDB connected'
  );
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
  logger.info('MongoDB disconnected');
}
