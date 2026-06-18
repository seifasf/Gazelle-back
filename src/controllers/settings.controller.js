import Settings from '../models/Settings.js';
import BostaStatusMapping from '../models/BostaStatusMapping.js';
import { syncCatalogFromShopify } from '../integrations/shopify/sync.service.js';
import { getAgenda } from '../config/agenda.js';
import { JOB_NAMES } from '../constants/index.js';

export async function getSettings(req, res, next) {
  try {
    const settings = await Settings.findOne({ key: 'global' });
    const mappings = await BostaStatusMapping.find({ isActive: true });
    res.json({
      data: {
        settings: settings || {},
        bostaStatusMappings: mappings,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function updateSettings(req, res, next) {
  try {
    const { shopifyLocationId, bostaPollingThresholdHours, defaultLowStockThreshold } = req.body;
    const settings = await Settings.findOneAndUpdate(
      { key: 'global' },
      {
        shopifyLocationId,
        bostaPollingThresholdHours,
        defaultLowStockThreshold,
      },
      { upsert: true, new: true }
    );
    res.json({ data: settings });
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

export default { getSettings, updateSettings, upsertBostaMapping, forceShopifySync };
