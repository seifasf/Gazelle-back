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
    const { backfillBostaSince, syncOrderStatesFromBosta } = await import(
      '../integrations/bosta/orderStates.service.js'
    );
    const { syncBostaReturns } = await import('../integrations/bosta/returns.service.js');

    // { since: '2026-07-01' } → full ingest from that date (status + COD + returns).
    if (req.body?.since || req.body?.from) {
      const since = req.body.since || req.body.from;
      const endDate = req.body.to || req.body.endDate || undefined;
      const backfill = await backfillBostaSince({ since, endDate });
      const returns = await syncBostaReturns({
        from: new Date(since),
        to: endDate ? new Date(endDate) : new Date(),
        maxPages: 60,
      }).catch((err) => ({ error: err.message }));
      return res.json({ data: { backfill, returns } });
    }

    const agenda = getAgenda();
    await agenda.now(JOB_NAMES.BOSTA_ORDER_STATES_SYNC, {});
    // Also kick an immediate lightweight sync so Settings button feels live.
    const quick = await syncOrderStatesFromBosta({ limit: 120 }).catch((err) => ({
      error: err.message,
    }));
    res.json({ queued: true, job: JOB_NAMES.BOSTA_ORDER_STATES_SYNC, quick });
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
