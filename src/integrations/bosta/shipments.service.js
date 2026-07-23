import { bostaRequest } from './client.js';
import { config } from '../../config/index.js';
import Settings from '../../models/Settings.js';
import { bostaWebhookUrl } from './webhookPayload.js';

function splitName(fullName) {
  const parts = (fullName || 'Customer').trim().split(/\s+/);
  return {
    firstName: parts[0] || 'Customer',
    lastName: parts.slice(1).join(' ') || '.',
  };
}

function compactCity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]/g, '');
}

/** Common Egypt district / typo labels → Bosta top-level city name. */
const CITY_ALIASES = {
  madinty: 'Cairo',
  madinaty: 'Cairo',
  مدينتي: 'Cairo',
  newcairo: 'Cairo',
  التجمع: 'Cairo',
  nasrcity: 'Cairo',
  مدينةنصر: 'Cairo',
  heliopolis: 'Cairo',
  مصرالجديدة: 'Cairo',
  rehab: 'Cairo',
  الرحاب: 'Cairo',
  shorouk: 'Cairo',
  الشروق: 'Cairo',
  mokattam: 'Cairo',
  المقطم: 'Cairo',
  maadi: 'Cairo',
  المعادي: 'Cairo',
  zamalek: 'Cairo',
  الزمالك: 'Cairo',
  sixthofoctober: 'Giza',
  '6thofoctober': 'Giza',
  october: 'Giza',
  اكتوبر: 'Giza',
  أكتوبر: 'Giza',
  sheikhzayed: 'Giza',
  الشيخزايد: 'Giza',
  haram: 'Giza',
  الهرم: 'Giza',
  dokki: 'Giza',
  الدقي: 'Giza',
  mohandessin: 'Giza',
  المهندسين: 'Giza',
};

async function resolveBostaCityId(cityName) {
  if (!cityName || typeof cityName !== 'string') return null;
  const settings = await Settings.findOne({ key: 'global' });
  const cities = (settings?.bostaCities || []).filter((c) => c && (c.name || c.nameAr || c.code));
  const normalized = cityName.trim().toLowerCase();
  if (!normalized) return null;

  const aliasTarget = CITY_ALIASES[compactCity(normalized)];
  const lookupName = aliasTarget || normalized;

  const exact = cities.find(
    (c) =>
      c.name?.toLowerCase() === lookupName.toLowerCase() ||
      c.nameAr?.toLowerCase() === lookupName.toLowerCase() ||
      c.code?.toLowerCase() === lookupName.toLowerCase() ||
      compactCity(c.alias) === compactCity(lookupName)
  );
  if (exact) return { cityId: exact.id || exact.code || null, resolvedName: exact.name, aliased: Boolean(aliasTarget) };

  const needle = compactCity(lookupName);
  if (needle.length < 3) return null;
  const fuzzy = cities.find((c) => {
    const en = compactCity(c.name);
    const ar = compactCity(c.nameAr);
    const al = compactCity(c.alias);
    return (en && (en.includes(needle) || needle.includes(en)))
      || (ar && (ar.includes(needle) || needle.includes(ar)))
      || (al && (al.includes(needle) || needle.includes(al)));
  });
  if (!fuzzy) return null;
  return { cityId: fuzzy.id || fuzzy.code || null, resolvedName: fuzzy.name, aliased: Boolean(aliasTarget) };
}

export async function createDelivery(order, customer) {
  const shipping = order.shippingAddress || {};
  const city = typeof shipping.city === 'string' ? shipping.city.trim() : '';
  const line1 = typeof shipping.line1 === 'string' ? shipping.line1.trim() : '';

  if (!line1 || !city) {
    const err = new Error(
      'Shipping address needs street and city before creating a Bosta delivery. Open the order and fix the address, then retry.'
    );
    err.statusCode = 400;
    err.code = 'MISSING_SHIPPING_ADDRESS';
    throw err;
  }

  const phone = shipping.phone || customer?.phone;
  if (!phone) {
    const err = new Error('Customer phone is required to create a Bosta delivery');
    err.statusCode = 400;
    throw err;
  }

  const codAmount = (order.totalSellingPrice || 0) + (order.shippingFee || 0);
  const { firstName, lastName } = splitName(shipping.fullName || customer?.fullName);
  const resolved = await resolveBostaCityId(city);
  const bostaCityName = resolved?.resolvedName || city;

  // Bosta create API expects dropOffAddress.city (name), not receiver.address.cityId.
  const dropOffAddress = {
    city: bostaCityName,
    firstLine: line1,
    secondLine: shipping.line2 || '',
    zone: shipping.zone || (resolved?.aliased ? city : '') || '',
  };

  const webhookUrl = bostaWebhookUrl(config.APP_URL);
  const payload = {
    type: 10,
    specs: {
      packageDetails: {
        itemsCount: (order.items || []).reduce((s, i) => s + (i.quantity || 0), 0),
        description: `Order ${order.shopifyOrderId}`,
      },
    },
    receiver: {
      firstName,
      lastName,
      phone,
    },
    dropOffAddress,
    businessReference: order._id.toString(),
    cod: codAmount,
  };

  // Bosta rejects localhost webhook URLs — only send public ones (Render/prod).
  if (webhookUrl && !/localhost|127\.0\.0\.1/i.test(webhookUrl)) {
    payload.webhookUrl = webhookUrl;
  }

  try {
    const response = await bostaRequest('/deliveries', { method: 'POST', body: payload });
    return response?.data || response;
  } catch (err) {
    const msg = err?.message || 'Bosta delivery create failed';
    if (/city/i.test(msg) || err?.statusCode === 400 || err?.statusCode === 500) {
      const wrapped = new Error(
        resolved?.resolvedName
          ? msg
          : `Bosta rejected the city “${city}”. Pick a Bosta city (e.g. Cairo) and put the area in Zone, then retry.`
      );
      wrapped.statusCode = err.statusCode || 502;
      throw wrapped;
    }
    throw err;
  }
}

export async function getDelivery(deliveryIdOrTracking) {
  const key = String(deliveryIdOrTracking || '').trim();
  if (!key) {
    const err = new Error('Missing Bosta delivery id/tracking');
    err.statusCode = 400;
    throw err;
  }

  // Prefer business tracking lookup — GET /deliveries/:id often 404s for plugin-created shipments.
  if (/^\d{8,}$/.test(key)) {
    const byTracking = await bostaRequest(`/deliveries/business/${encodeURIComponent(key)}`);
    return byTracking?.data || byTracking;
  }

  try {
    const response = await bostaRequest(`/deliveries/${encodeURIComponent(key)}`);
    return response?.data || response;
  } catch (err) {
    // Fall back: treat key as tracking if id lookup fails.
    const byTracking = await bostaRequest(`/deliveries/business/${encodeURIComponent(key)}`);
    return byTracking?.data || byTracking;
  }
}

/**
 * Print Air Waybill (بوليصة) — official Bosta SDK path:
 * GET /deliveries/awb?ids=<deliveryId>
 * Returns a PDF URL string or object with url.
 */
export async function getAwb(deliveryId) {
  const id = String(deliveryId || '').trim();
  if (!id) {
    const err = new Error('Missing Bosta delivery id');
    err.statusCode = 400;
    throw err;
  }

  const response = await bostaRequest('/deliveries/awb', {
    method: 'GET',
    query: { ids: id },
  });
  const raw = response?.data ?? response;
  return normalizeAwbPayload(raw, id);
}

function normalizeAwbPayload(raw, deliveryId) {
  if (typeof raw === 'string') {
    if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) {
      return { url: raw, deliveryId };
    }
    // Some responses return bare base64 PDF
    if (raw.length > 100 && !raw.includes(' ')) {
      return { url: `data:application/pdf;base64,${raw}`, deliveryId };
    }
    return { url: raw, deliveryId };
  }
  if (raw && typeof raw === 'object') {
    const url =
      raw.url ||
      raw.awbUrl ||
      raw.pdfUrl ||
      raw.data?.url ||
      (typeof raw.data === 'string' ? raw.data : null);
    return { url: url || null, deliveryId, ...raw };
  }
  return { url: null, deliveryId, raw };
}

export default { createDelivery, getDelivery, getAwb };
