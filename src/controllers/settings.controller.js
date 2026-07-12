import Settings from '../models/Settings.js';
import BostaStatusMapping from '../models/BostaStatusMapping.js';
import { syncCatalog } from '../integrations/shopify/sync.service.js';
import { fetchBostaCities } from '../integrations/bosta/cities.service.js';
import { isBostaConfigured } from '../integrations/bosta/client.js';
import { getAgenda } from '../config/agenda.js';
import { JOB_NAMES } from '../constants/index.js';
import { maskSecret } from '../integrations/shopify/credentials.js';

function sanitizeSettings(settings) {
  if (!settings) return {};
  const obj = settings.toObject ? settings.toObject() : { ...settings };
  if (obj.shopifyAccessToken) obj.shopifyAccessTokenMasked = maskSecret(obj.shopifyAccessToken);
  if (obj.shopifyWebhookSecret) obj.shopifyWebhookSecretMasked = maskSecret(obj.shopifyWebhookSecret);
  if (obj.shopifyClientId) obj.shopifyClientIdMasked = maskSecret(obj.shopifyClientId);
  if (obj.shopifyClientSecret) obj.shopifyClientSecretMasked = maskSecret(obj.shopifyClientSecret);
  delete obj.shopifyAccessToken;
  delete obj.shopifyWebhookSecret;
  delete obj.shopifyClientSecret;
  return obj;
}

export async function getSettings(req, res, next) {
  try {
    let settings = await Settings.findOne({ key: 'global' });

    if (isBostaConfigured() && (!settings?.bostaCities?.length || !settings?.bostaConnectionHealthy)) {
      try {
        await fetchBostaCities();
        settings = await Settings.findOne({ key: 'global' });
      } catch {
        // keep existing settings if live sync fails
      }
    }

    const mappings = await BostaStatusMapping.find({ isActive: true });
    res.json({
      data: {
        settings: sanitizeSettings(settings),
        bostaStatusMappings: mappings,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function updateSettings(req, res, next) {
  try {
    const {
      shopifyLocationId,
      shopifyShopDomain,
      shopifyApiVersion,
      bostaPollingThresholdHours,
      defaultLowStockThreshold,
    } = req.body;
    const settings = await Settings.findOneAndUpdate(
      { key: 'global' },
      {
        shopifyLocationId,
        shopifyShopDomain,
        shopifyApiVersion,
        bostaPollingThresholdHours,
        defaultLowStockThreshold,
      },
      { upsert: true, new: true }
    );
    res.json({ data: sanitizeSettings(settings) });
  } catch (err) {
    next(err);
  }
}

export async function upsertBostaMapping(req, res, next) {
  try {
    const { bostaState, internalStatus, description } = req.body;
    const mapping = await BostaStatusMapping.findOneAndUpdate(
      { bostaState },
      { bostaState, internalStatus, description, isActive: true },
      { upsert: true, new: true }
    );
    res.json({ data: mapping });
  } catch (err) {
    next(err);
  }
}

export async function forceShopifySync(req, res, next) {
  try {
    const agenda = getAgenda();
    await agenda.now(JOB_NAMES.SHOPIFY_CATALOG_SYNC, {});
    res.json({ queued: true });
  } catch (err) {
    next(err);
  }
}

export async function forceBostaStatesSync(req, res, next) {
  try {
    const agenda = getAgenda();
    await agenda.now(JOB_NAMES.BOSTA_ORDER_STATES_SYNC, {});
    res.json({ queued: true, job: JOB_NAMES.BOSTA_ORDER_STATES_SYNC });
  } catch (err) {
    next(err);
  }
}

export default {
  getSettings,
  updateSettings,
  upsertBostaMapping,
  forceShopifySync,
  forceBostaStatesSync,
};
