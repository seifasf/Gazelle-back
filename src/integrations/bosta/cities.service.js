import { bostaRequest } from './client.js';
import Settings from '../../models/Settings.js';
import logger from '../../utils/logger.js';

let citiesCache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

export async function fetchBostaCities({ force = false } = {}) {
  if (!force && citiesCache && Date.now() - cacheTime < CACHE_TTL_MS) {
    return citiesCache;
  }

  const response = await bostaRequest('/cities');
  const cities = response?.data?.list || response?.data || response?.list || [];

  citiesCache = cities;
  cacheTime = Date.now();

  await Settings.findOneAndUpdate(
    { key: 'global' },
    {
      bostaCities: cities.map((c) => ({
        id: c._id,
        name: c.name,
        nameAr: c.nameAr,
        code: c.code,
      })),
      bostaConnectionHealthy: true,
      bostaLastSyncAt: new Date(),
    },
    { upsert: true }
  );

  logger.info({ count: cities.length }, 'Bosta cities synced');
  return cities;
}

export async function getBostaCitiesFromDb() {
  const settings = await Settings.findOne({ key: 'global' }).select('bostaCities');
  return settings?.bostaCities || [];
}

export default { fetchBostaCities, getBostaCitiesFromDb };
