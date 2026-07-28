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
  const cities = (response?.data?.list || response?.data || response?.list || []).filter(Boolean);

  citiesCache = cities;
  cacheTime = Date.now();

  await Settings.findOneAndUpdate(
    { key: 'global' },
    {
      bostaCities: cities.map((c) => ({
        id: c._id || c.id,
        name: c.name,
        nameAr: c.nameAr,
        code: c.code,
        alias: c.alias || '',
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

const districtsCache = new Map();
const DISTRICTS_TTL_MS = 60 * 60 * 1000;

/**
 * Bosta districts (areas) for a city — used for address pickers + shipment cityId/districtId.
 */
export async function fetchBostaDistricts(cityId, { force = false } = {}) {
  const id = String(cityId || '').trim();
  if (!id) return [];

  const cached = districtsCache.get(id);
  if (!force && cached && Date.now() - cached.at < DISTRICTS_TTL_MS) {
    return cached.list;
  }

  const response = await bostaRequest(`/cities/${encodeURIComponent(id)}/districts`);
  const list = (response?.data || response?.list || []).filter(Boolean);
  districtsCache.set(id, { at: Date.now(), list });
  return list;
}

export default { fetchBostaCities, getBostaCitiesFromDb, fetchBostaDistricts };
