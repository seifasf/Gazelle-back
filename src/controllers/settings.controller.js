import Settings from '../models/Settings.js';
import BostaStatusMapping from '../models/BostaStatusMapping.js';
import { syncCatalog } from '../integrations/shopify/sync.service.js';
import { fetchBostaCities } from '../integrations/bosta/cities.service.js';
import { isBostaConfigured } from '../integrations/bosta/client.js';
import {
  isFlextockConfigured,
  testFlextockConnection,
  resetFlextockCredentialCache,
  cleanFlextockSecret,
} from '../integrations/flextock/client.js';
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
  if (obj.flextockUsername) obj.flextockUsernameMasked = maskSecret(obj.flextockUsername);
  if (obj.flextockPassword) obj.flextockPasswordMasked = maskSecret(obj.flextockPassword);
  if (obj.flextockApiKey) obj.flextockApiKeyMasked = maskSecret(obj.flextockApiKey);
  delete obj.shopifyAccessToken;
  delete obj.shopifyWebhookSecret;
  delete obj.shopifyClientSecret;
  delete obj.flextockPassword;
  delete obj.flextockApiKey;
  // Keep flextockUsername for the form default (merchant username is not a high-risk secret).
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
        bostaConfigured: isBostaConfigured(),
        flextockConfigured: await isFlextockConfigured(),
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
      flextockUsername,
      flextockPassword,
      flextockApiKey,
    } = req.body;
    const patch = {
      shopifyLocationId,
      shopifyShopDomain,
      shopifyApiVersion,
      bostaPollingThresholdHours,
      defaultLowStockThreshold,
    };
    if (flextockUsername !== undefined) {
      patch.flextockUsername = cleanFlextockSecret(flextockUsername) || null;
    }
    if (flextockPassword !== undefined && String(flextockPassword).trim() !== '') {
      patch.flextockPassword = cleanFlextockSecret(flextockPassword) || null;
    }
    if (flextockApiKey !== undefined && String(flextockApiKey).trim() !== '') {
      patch.flextockApiKey = cleanFlextockSecret(flextockApiKey) || null;
    }
    const settings = await Settings.findOneAndUpdate(
      { key: 'global' },
      { $set: patch },
      { upsert: true, new: true }
    );
    if (
      flextockUsername !== undefined
      || flextockPassword !== undefined
      || flextockApiKey !== undefined
    ) {
      resetFlextockCredentialCache();
    }
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

export async function forceFlextockStatesSync(req, res, next) {
  try {
    if (!(await isFlextockConfigured())) {
      return res.status(503).json({
        error:
          'Flextock API is not configured yet. Add merchant username, password, and API key in Settings → Flextock, then retry.',
      });
    }
    const { syncFlextockOrderStates } = await import('../integrations/flextock/sync.service.js');
    const agenda = getAgenda();
    await agenda.now(JOB_NAMES.FLEXTOCK_ORDER_STATES_SYNC, {});
    const quick = await syncFlextockOrderStates({ limit: 80 }).catch((err) => ({
      error: err.message,
    }));
    res.json({ queued: true, job: JOB_NAMES.FLEXTOCK_ORDER_STATES_SYNC, quick });
  } catch (err) {
    next(err);
  }
}

export async function testFlextockAuth(req, res, next) {
  try {
    // Optional body lets Settings "Save & test" write creds then probe in one request.
    const { flextockUsername, flextockPassword, flextockApiKey } = req.body || {};
    if (
      flextockUsername !== undefined
      || flextockPassword !== undefined
      || flextockApiKey !== undefined
    ) {
      const patch = {};
      if (flextockUsername !== undefined) {
        patch.flextockUsername = cleanFlextockSecret(flextockUsername) || null;
      }
      if (flextockPassword !== undefined && String(flextockPassword).trim() !== '') {
        patch.flextockPassword = cleanFlextockSecret(flextockPassword) || null;
      }
      if (flextockApiKey !== undefined && String(flextockApiKey).trim() !== '') {
        patch.flextockApiKey = cleanFlextockSecret(flextockApiKey) || null;
      }
      if (Object.keys(patch).length) {
        await Settings.findOneAndUpdate({ key: 'global' }, { $set: patch }, { upsert: true });
        resetFlextockCredentialCache();
      }
    }

    const result = await testFlextockConnection();
    await Settings.findOneAndUpdate(
      { key: 'global' },
      {
        $set: {
          flextockLastSyncAt: new Date(),
          flextockConnectionHealthy: Boolean(result.ok),
          flextockLastError: result.ok ? null : (result.error || 'Flextock auth failed'),
        },
      },
      { upsert: true }
    );
    if (!result.ok) {
      // Always 502/503 — never 401 — so the OMS UI does not treat this as session expiry.
      return res.status(result.configured ? 502 : 503).json({
        error: result.error || 'Flextock auth failed',
        data: result,
      });
    }
    res.json({ data: result });
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
  forceFlextockStatesSync,
  testFlextockAuth,
};
