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

/**
 * Paid on Shopify / Paymob / marked online → Bosta COD must be 0 (never double-charge).
 * Creator totals follow the manual Total field — not forced to 0 here.
 */
export function isOrderPrepaidForBosta(order) {
  if (!order) return false;
  const method = String(order.paymentMethod || '').toLowerCase();
  if (method === 'online' || method === 'prepaid') return true;
  const status = String(order.onlinePaymentStatus || '').toLowerCase();
  if (status === 'paid' || status === 'success' || status === 'captured') return true;
  if (order.onlinePaidAt) return true;
  return false;
}

/**
 * Cash the courier should collect from the customer (never pay the customer).
 * - Prepaid / online paid → 0
 * - Customer return / refund pickup → always 0 (no cash to client)
 * - Exchange → shipping only (goods free on the OMS order)
 * - Creator / normal COD → goods + shipping
 */
export function bostaCodAmountForOrder(order) {
  if (!order) return 0;
  if (isOrderPrepaidForBosta(order)) return 0;
  if (order.isReturnOrder) return 0;
  return Math.max(0, (order.totalSellingPrice || 0) + (order.shippingFee || 0));
}

/** Bosta delivery type codes (live API — verified against Gazelle Bosta account). */
export const BOSTA_DELIVERY_TYPE = {
  SEND: 10,
  /** Return to Origin (failed delivery coming back) — not used for create. */
  RTO: 20,
  /** Customer return / refund pickup — courier collects from customer, COD must be 0. */
  CUSTOMER_RETURN_PICKUP: 25,
  /** Exchange — deliver new + collect old; returnSpecs required. */
  EXCHANGE: 30,
};

export function bostaDeliveryTypeForOrder(order) {
  if (order?.isReturnOrder) return BOSTA_DELIVERY_TYPE.CUSTOMER_RETURN_PICKUP;
  if (order?.isExchangeOrder) return BOSTA_DELIVERY_TYPE.EXCHANGE;
  return BOSTA_DELIVERY_TYPE.SEND;
}

/**
 * Build Bosta package description (وصف الشحنة) with product name, SKU, size, color.
 * Prefer keeping every line intact; only soft-truncate if very long.
 */
function formatItemLines(items, variantsById = new Map()) {
  const lines = [];
  for (const item of items || []) {
    const variant =
      (item.variantId && typeof item.variantId === 'object' && (item.variantId.sku || item.variantId.title)
        ? item.variantId
        : null) ||
      variantsById.get(String(item.variantId?._id || item.variantId)) ||
      {};
    const name =
      item.title ||
      variant.productTitle ||
      (variant.productId && typeof variant.productId === 'object' ? variant.productId.title : null) ||
      variant.title ||
      '';
    const sku = variant.sku || item.sku || '';
    const size =
      item.size != null && item.size !== ''
        ? `Size ${item.size}`
        : variant.size != null && variant.size !== ''
          ? `Size ${variant.size}`
          : '';
    const color = item.color || variant.color || '';
    const qty = item.quantity || 1;
    const bits = [name, sku, size, color].filter(Boolean);
    const label = bits.length ? bits.join(' · ') : sku || 'item';
    lines.push(`${label} x${qty}`);
  }
  return lines;
}

function countItems(items) {
  return (items || []).reduce((s, i) => s + (i.quantity || 0), 0);
}

function buildPackageDescription(order, variantsById = new Map()) {
  const ref =
    order.shopifyOrderName ||
    (order.shopifyOrderId ? `#${order.shopifyOrderId}` : null) ||
    `Order ${order._id}`;

  const cod = bostaCodAmountForOrder(order);
  const tags = [];
  if (order.isReturnOrder) tags.push('RETURN PICKUP · COD 0 · NO CASH TO CUSTOMER');
  else if (order.isExchangeOrder) {
    tags.push(cod > 0 ? `EXCHANGE · COD ${cod} (shipping only)` : 'EXCHANGE · COD 0');
  } else if (order.isCreatorOrder) {
    tags.push(cod > 0 ? `CREATOR · COD ${cod}` : 'CREATOR/GIFT · COD 0');
  } else if (isOrderPrepaidForBosta(order)) {
    tags.push('PAID · COD 0');
  }

  const outboundLines = formatItemLines(order.items, variantsById);
  const returnSource =
    order.bostaReturnItems?.length
      ? order.bostaReturnItems
      : order.isReturnOrder
        ? order.items
        : [];
  const returnLines = formatItemLines(returnSource, variantsById);

  const parts = [tags.length ? tags.join(' | ') : null, ref].filter(Boolean);
  if (order.isReturnOrder) {
    if (returnLines.length) parts.push(`PICK UP FROM CUSTOMER: ${returnLines.join(' | ')}`);
  } else if (order.isExchangeOrder) {
    if (outboundLines.length) parts.push(`DELIVER: ${outboundLines.join(' | ')}`);
    if (returnLines.length) parts.push(`COLLECT FROM CUSTOMER: ${returnLines.join(' | ')}`);
  } else if (outboundLines.length) {
    parts.push(outboundLines.join(' | '));
  }

  const full = parts.join(' | ');
  if (full.length <= 400) return full;
  return `${full.slice(0, 397)}…`;
}

async function loadVariantsForOrder(order) {
  const map = new Map();
  const idsToFetch = [];

  const allLines = [...(order.items || []), ...(order.bostaReturnItems || [])];
  for (const item of allLines) {
    const v = item.variantId;
    if (!v) continue;
    // Populated variant doc (has sku/title). Plain ObjectId is also typeof 'object'.
    const isPopulatedDoc =
      typeof v === 'object' &&
      v._bsontype !== 'ObjectId' &&
      !(v instanceof Buffer) &&
      (v.sku != null || v.title != null || (v._id && (v.color != null || v.size != null || v.productId)));
    if (isPopulatedDoc) {
      map.set(String(v._id), v);
    } else {
      idsToFetch.push(String(v._id || v));
    }
  }

  if (idsToFetch.length) {
    const Variant = (await import('../../models/Variant.js')).default;
    const Product = (await import('../../models/Product.js')).default;
    const variants = await Variant.find({ _id: { $in: [...new Set(idsToFetch)] } })
      .select('sku title color size productId imageUrl')
      .lean();
    const productIds = [...new Set(variants.map((v) => String(v.productId)).filter(Boolean))];
    const products = productIds.length
      ? await Product.find({ _id: { $in: productIds } }).select('title').lean()
      : [];
    const productTitleById = Object.fromEntries(products.map((p) => [String(p._id), p.title]));
    for (const v of variants) {
      const pt = productTitleById[String(v.productId)] || v.title;
      map.set(String(v._id), {
        ...v,
        productTitle: pt,
        title: pt,
      });
    }
  }

  // Resolve product titles for already-populated variants that only have productId
  const needProduct = [];
  for (const v of map.values()) {
    if (v.productId && typeof v.productId !== 'object' && !v.productTitle) {
      needProduct.push(String(v.productId));
    }
  }
  if (needProduct.length) {
    const Product = (await import('../../models/Product.js')).default;
    const products = await Product.find({ _id: { $in: [...new Set(needProduct)] } })
      .select('title')
      .lean();
    const titles = Object.fromEntries(products.map((p) => [String(p._id), p.title]));
    for (const [id, v] of map) {
      const pt =
        (v.productId && typeof v.productId === 'object' ? v.productId.title : null) ||
        titles[String(v.productId)];
      if (pt) map.set(id, { ...v, productTitle: pt, title: pt });
    }
  }

  return map;
}

function compactCity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]/g, '');
}

/** Country / invalid labels customers sometimes put in the city field. */
const COUNTRY_LABELS = new Set([
  'egypt',
  'eg',
  'egy',
  'مصر',
  'جمهوريةمصرالعربية',
  'egypte',
]);

function isCountryLabel(value) {
  return COUNTRY_LABELS.has(compactCity(value));
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
  elshelkhzayed: 'Giza',
  haram: 'Giza',
  الهرم: 'Giza',
  dokki: 'Giza',
  الدقي: 'Giza',
  mohandessin: 'Giza',
  المهندسين: 'Giza',
  القاهره: 'Cairo',
  القاهرة: 'Cairo',
  cahiro: 'Cairo',
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
  let city = typeof shipping.city === 'string' ? shipping.city.trim() : '';
  let zone = typeof shipping.zone === 'string' ? shipping.zone.trim() : '';
  let line1 = typeof shipping.line1 === 'string' ? shipping.line1.trim() : '';

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

  // Paid Shopify / online → COD 0. Return pickups → COD 0 (never pay the customer).
  // Creator / exchange follow order totals (exchange = shipping only when goods are 0).
  const codAmount = bostaCodAmountForOrder(order);
  if (isOrderPrepaidForBosta(order) && codAmount !== 0) {
    const err = new Error('Paid order must have Bosta COD = 0');
    err.statusCode = 500;
    throw err;
  }
  if (order.isReturnOrder && codAmount !== 0) {
    const err = new Error('Return pickup must have Bosta COD = 0 (no cash to customer)');
    err.statusCode = 500;
    throw err;
  }
  const { firstName, lastName } = splitName(shipping.fullName || customer?.fullName);

  // Shopify sometimes puts country in city ("Egypt") and the real city in province/zone.
  let resolved = await resolveBostaCityId(city);
  if (!resolved || isCountryLabel(city)) {
    const fromZone = zone ? await resolveBostaCityId(zone) : null;
    if (fromZone) {
      const originalCity = city;
      resolved = { ...fromZone, aliased: true };
      city = fromZone.resolvedName;
      zone = [originalCity !== city ? originalCity : null, zone !== city ? zone : null]
        .filter(Boolean)
        .join(' · ');
    }
  }

  if (!resolved && isCountryLabel(city)) {
    const err = new Error(
      `City is set to “${shipping.city}” (country). Set a real Bosta city (e.g. Cairo) — often it is already in Zone/province.`
    );
    err.statusCode = 400;
    err.code = 'INVALID_CITY';
    throw err;
  }

  const bostaCityName = resolved?.resolvedName || city;

  // Bosta rejects very short first lines ("6046") — enrich with area/city for the courier.
  if (line1.length < 10) {
    line1 = [line1, zone, bostaCityName].filter(Boolean).join(', ');
  }

  // Bosta create API expects dropOffAddress.city (name), not receiver.address.cityId.
  const dropOffAddress = {
    city: bostaCityName,
    firstLine: line1,
    secondLine: shipping.line2 || '',
    zone: zone || (resolved?.aliased ? shipping.city : '') || '',
  };

  const webhookUrl = bostaWebhookUrl(config.APP_URL);
  const variantsById = await loadVariantsForOrder(order);
  const deliveryType = bostaDeliveryTypeForOrder(order);
  const description = buildPackageDescription(order, variantsById);

  const outboundCount = countItems(order.items);
  const outboundDesc =
    formatItemLines(order.items, variantsById).join(' | ') || description;
  const returnSource =
    order.bostaReturnItems?.length
      ? order.bostaReturnItems
      : order.isReturnOrder
        ? order.items
        : [];
  const returnCount = countItems(returnSource);
  const returnDesc = formatItemLines(returnSource, variantsById).join(' | ');

  if (deliveryType === BOSTA_DELIVERY_TYPE.EXCHANGE && returnCount < 1) {
    const err = new Error(
      'Exchange policy needs items to collect from the customer. Re-create the exchange and tick the returned items.'
    );
    err.statusCode = 400;
    throw err;
  }
  if (deliveryType === BOSTA_DELIVERY_TYPE.CUSTOMER_RETURN_PICKUP && returnCount < 1) {
    const err = new Error('Return pickup needs at least one item to collect from the customer');
    err.statusCode = 400;
    throw err;
  }

  // SEND / EXCHANGE: packageDetails = what we deliver.
  // CRP return: packageDetails = what we pick up from the customer.
  const primaryDetails =
    deliveryType === BOSTA_DELIVERY_TYPE.CUSTOMER_RETURN_PICKUP
      ? {
          itemsCount: returnCount,
          description: returnDesc || description,
        }
      : {
          itemsCount: Math.max(1, outboundCount),
          description: outboundDesc,
        };

  const payload = {
    type: deliveryType,
    allowToOpenPackage: true, // فتح الشحنة = نعم
    specs: {
      packageType: 'Parcel',
      size: 'MEDIUM',
      packageDetails: primaryDetails,
    },
    receiver: {
      firstName,
      lastName,
      phone,
    },
    dropOffAddress,
    businessReference: order._id.toString(),
    cod: codAmount,
    notes: description,
  };

  // CRP (type 25): Bosta requires pickupAddress (customer) — dropOff alone fails with city error.
  if (deliveryType === BOSTA_DELIVERY_TYPE.CUSTOMER_RETURN_PICKUP) {
    payload.pickupAddress = { ...dropOffAddress };
  }

  // Exchange (type 30): deliver new + collect old — returnSpecs required by Bosta.
  if (deliveryType === BOSTA_DELIVERY_TYPE.EXCHANGE) {
    payload.returnSpecs = {
      packageType: 'Parcel',
      size: 'MEDIUM',
      packageDetails: {
        itemsCount: returnCount,
        description: returnDesc || 'Customer return items',
      },
    };
  }

  // Bosta rejects localhost webhook URLs — only send public ones (Render/prod).
  if (webhookUrl && !/localhost|127\.0\.0\.1/i.test(webhookUrl)) {
    payload.webhookUrl = webhookUrl;
  }

  try {
    const response = await bostaRequest('/deliveries', { method: 'POST', body: payload });
    return response?.data || response;
  } catch (err) {
    const msg = err?.message || 'Bosta delivery create failed';
    if (/insufficient parameters/i.test(msg)) {
      const wrapped = new Error(
        `Bosta needs a fuller street address (got “${shipping.line1 || ''}”). Open the order, add building/street details, then retry the policy.`
      );
      wrapped.statusCode = 400;
      throw wrapped;
    }
    if (/city/i.test(msg) || err?.statusCode === 400 || err?.statusCode === 500) {
      const wrapped = new Error(
        resolved?.resolvedName
          ? msg
          : `Bosta rejected the city “${shipping.city || city}”. Pick a Bosta city (e.g. Cairo) and put the area in Zone, then retry.`
      );
      wrapped.statusCode = err.statusCode || 502;
      throw wrapped;
    }
    throw err;
  }
}

/**
 * Update وصف الشحنة on an existing Bosta delivery (v0 PUT — v2 has no update route).
 */
export async function updateDeliveryPackageDescription(deliveryId, order) {
  const id = String(deliveryId || '').trim();
  if (!id || !order) return null;

  const variantsById = await loadVariantsForOrder(order);
  const itemsCount = (order.items || []).reduce((s, i) => s + (i.quantity || 0), 0);
  const description = buildPackageDescription(order, variantsById);
  const body = {
    allowToOpenPackage: true,
    specs: { packageDetails: { itemsCount, description } },
    notes: description,
    // Keep COD in sync — paid Shopify orders must stay 0 on the AWB.
    cod: bostaCodAmountForOrder(order),
  };

  const base = (config.BOSTA_API_BASE_URL || 'https://app.bosta.co/api/v2').replace(/\/api\/v2\/?$/, '');
  const url = `${base}/api/v0/deliveries/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: config.BOSTA_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(data.message || `Bosta delivery update failed: ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }
  return { description, data };
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
 * Print Air Waybill (بوليصة).
 * Bosta v2 path that works: GET /deliveries/mass-awb?ids=<deliveryId>
 * Response `data` is a base64-encoded PDF (string starting with JVBERi…).
 * Legacy SDK path GET /deliveries/awb is v1-only and 404s on v2.
 */
export async function getAwb(deliveryId, trackingNumber) {
  const id = String(deliveryId || '').trim();
  const tracking = String(trackingNumber || '').trim();
  if (!id && !tracking) {
    const err = new Error('Missing Bosta delivery id');
    err.statusCode = 400;
    throw err;
  }

  const attempts = [];
  if (id) attempts.push({ label: 'mass-awb-id', path: '/deliveries/mass-awb', query: { ids: id } });
  if (tracking) attempts.push({ label: 'mass-awb-tracking', path: '/deliveries/mass-awb', query: { ids: tracking } });
  // Fallbacks for older API shapes
  if (id) attempts.push({ label: 'awb-query', path: '/deliveries/awb', query: { ids: id } });
  if (id) attempts.push({ label: 'awb-by-id', path: `/deliveries/${encodeURIComponent(id)}/awb` });

  let lastErr;
  for (const attempt of attempts) {
    try {
      const response = await bostaRequest(attempt.path, {
        method: 'GET',
        query: attempt.query,
      });
      const raw = response?.data ?? response;
      const normalized = normalizeAwbPayload(raw, id || tracking);
      if (normalized.url) return normalized;
      lastErr = new Error('Bosta AWB response had no PDF');
    } catch (err) {
      lastErr = err;
      // Try next variant on 404 / not-found; rethrow hard failures
      if (err.statusCode && err.statusCode !== 404 && err.statusCode !== 400) throw err;
    }
  }

  const err = new Error(lastErr?.message || 'Failed to print Bosta AWB');
  err.statusCode = lastErr?.statusCode || 502;
  throw err;
}

function normalizeAwbPayload(raw, deliveryId) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) {
      return { url: trimmed, deliveryId };
    }
    // mass-awb returns raw base64 PDF (JVBERi0… = %PDF)
    if (trimmed.length > 100) {
      return { url: `data:application/pdf;base64,${trimmed}`, deliveryId };
    }
    return { url: trimmed, deliveryId };
  }
  if (raw && typeof raw === 'object') {
    const nested = raw.url || raw.awbUrl || raw.pdfUrl || raw.data?.url;
    if (nested) return { url: nested, deliveryId };
    if (typeof raw.data === 'string' && raw.data.length > 100) {
      const d = raw.data.trim();
      if (/^https?:\/\//i.test(d) || d.startsWith('data:')) return { url: d, deliveryId };
      return { url: `data:application/pdf;base64,${d}`, deliveryId };
    }
    return { url: null, deliveryId, ...raw };
  }
  return { url: null, deliveryId, raw };
}

export default {
  createDelivery,
  getDelivery,
  getAwb,
  updateDeliveryPackageDescription,
  isOrderPrepaidForBosta,
  bostaCodAmountForOrder,
  bostaDeliveryTypeForOrder,
  BOSTA_DELIVERY_TYPE,
};
