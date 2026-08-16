import { bostaRequest } from './client.js';
import { config } from '../../config/index.js';
import Settings from '../../models/Settings.js';
import Order from '../../models/Order.js';
import { bostaWebhookUrl } from './webhookPayload.js';
import { fetchBostaDistricts } from './cities.service.js';
import logger from '../../utils/logger.js';

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
 * Cash the courier should collect from the customer.
 * - Prepaid / online paid → 0
 * - Customer return / refund pickup → always 0 (no cash to client)
 * - Exchange → (new − old) + shipping; if old > new the difference is a credit
 *   (exchangeCreditAmount) subtracted from COD so customer still pays shipping net of refund
 * - Creator / normal COD → goods + shipping
 */
export function bostaCodAmountForOrder(order) {
  if (!order) return 0;
  if (isOrderPrepaidForBosta(order)) return 0;
  if (order.isReturnOrder) return 0;
  const goods = Number(order.totalSellingPrice) || 0;
  const ship = Number(order.shippingFee) || 0;
  const credit = order.isExchangeOrder ? Number(order.exchangeCreditAmount) || 0 : 0;
  return Math.max(0, Math.round((goods + ship - credit) * 100) / 100);
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
    const credit = Number(order.exchangeCreditAmount) || 0;
    const upgrade = Number(order.totalSellingPrice) || 0;
    const ship = Number(order.shippingFee) || 0;
    if (credit > upgrade + ship) {
      const netRefund = Math.round((credit - upgrade - ship) * 100) / 100;
      tags.push(`EXCHANGE · COD 0 · PAY CUSTOMER ${netRefund} (credit − shipping)`);
    } else if (credit > 0) {
      tags.push(`EXCHANGE · COD ${cod} (shipping − credit ${credit})`);
    } else if (upgrade > 0) {
      tags.push(`EXCHANGE · COD ${cod} (upgrade ${upgrade} + shipping)`);
    } else {
      tags.push(cod > 0 ? `EXCHANGE · COD ${cod} (shipping)` : 'EXCHANGE · COD 0');
    }
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

/** Common neighborhood spellings → Bosta district English name. */
const AREA_ALIASES = {
  smouha: 'Smouha',
  smoha: 'Smouha',
  semouha: 'Smouha',
  سموحه: 'Smouha',
  سموحة: 'Smouha',
  mokattam: 'ElMokattam',
  المقطم: 'ElMokattam',
  مقطم: 'ElMokattam',
  maadi: 'Maadi',
  المعادي: 'Maadi',
  معادي: 'Maadi',
  nasrcity: 'Nasr City',
  مدينةنصر: 'Nasr City',
  '6october': '6 October',
  sixthofoctober: '6 October',
  اكتوبر: '6 October',
  أكتوبر: '6 October',
  sheikhzayed: 'Sheikh Zayed',
  الشيخزايد: 'Sheikh Zayed',
  haram: 'Haram',
  الهرم: 'Haram',
  dokki: 'Dokki',
  الدقي: 'Dokki',
  mohandessin: 'Mohandessin',
  المهندسين: 'Mohandessin',
  heliopolis: 'Heliopolis',
  مصرالجديدة: 'Heliopolis',
  zamalek: 'Zamalek',
  الزمالك: 'Zamalek',
  agouza: 'Agouza',
  العجوزه: 'Agouza',
  العجوزة: 'Agouza',
  qesmelraml: 'Qesm ElRaml',
  قسمالرمل: 'Qesm ElRaml',
  elraml: 'ElRaml',
  الرمل: 'ElRaml',
  sidigaber: 'Sidi Gaber',
  سيديجابر: 'Sidi Gaber',
  // Alexandria — prefer covered Sidi Gaber district (ElAmaria "Mostafa Kamel" is uncovered).
  mostafakamel: 'Mustafa Kamel (Sidi Gaber)',
  mustafakamel: 'Mustafa Kamel (Sidi Gaber)',
  mostafakamil: 'Mustafa Kamel (Sidi Gaber)',
  مصطفىكامل: 'Mustafa Kamel (Sidi Gaber)',
  مصطفيكامل: 'Mustafa Kamel (Sidi Gaber)',
  عماراتضباطمصطفىكامل: 'Mustafa Kamel (Sidi Gaber)',
};

/** Generic short tokens that match too many districts — never score alone. */
const WEAK_AREA_TOKENS = new Set([
  'كامل', // "complete/full" — appears in many Arabic district names
  'kamel',
  'kamil',
  'شارع',
  'street',
  'apartment',
  'floor',
  'third',
  'خلف',
  'مباشر',
]);

function normalizeDistrictNeedle(value) {
  return compactCity(String(value || ''))
    .replace(/٦/g, '6')
    .replace(/أكتوبر|اكتوبر/g, 'october')
    .replace(/المقطم|مقطم/g, 'mokattam')
    .replace(/سموحة/g, 'سموحه')
    .replace(/مصطفى/g, 'مصطفي');
}

function isDropOffCovered(district) {
  if (district?.dropOffAvailability === false) return false;
  return true;
}

/**
 * Split free-text address into searchable tokens (EN + AR), including bigrams.
 */
function addressTokens(...hints) {
  const raw = hints
    .flatMap((h) => String(h || '').split(/[·|,/+\n]/))
    .map((h) => h.trim())
    .filter(Boolean);

  const tokens = new Set();
  for (const part of raw) {
    const compact = normalizeDistrictNeedle(part);
    if (compact.length >= 3) tokens.add(compact);

    const words = part.split(/[\s,_-]+/).map((w) => normalizeDistrictNeedle(w)).filter((w) => w.length >= 2);
    for (const w of words) {
      if (w.length >= 3) tokens.add(w);
    }
    // Bigrams: "مصطفى كامل" → مصطفىكامل (matches AREA_ALIASES / district names)
    for (let i = 0; i < words.length - 1; i += 1) {
      const bi = `${words[i]}${words[i + 1]}`;
      if (bi.length >= 5) tokens.add(bi);
    }
  }

  for (const [alias, canonical] of Object.entries(AREA_ALIASES)) {
    const aliasC = normalizeDistrictNeedle(alias);
    const canonC = normalizeDistrictNeedle(canonical);
    if ([...tokens].some((t) => t === aliasC || t.includes(aliasC) || aliasC.includes(t))) {
      tokens.add(canonC);
      tokens.add(aliasC);
    }
  }

  return [...tokens].filter((t) => !WEAK_AREA_TOKENS.has(t));
}

/**
 * Match free-text zone / street against Bosta districts for a city.
 * Never picks uncovered districts (Bosta error 4009 "Uncovered drop off…").
 */
async function resolveBostaDistrict(cityId, cityName, ...hints) {
  if (!cityId) return null;
  let districts = [];
  try {
    districts = await fetchBostaDistricts(cityId);
  } catch {
    return null;
  }
  if (!districts.length) return null;

  // Zone equal to city ("Alexandria") is useless noise from Shopify.
  const cleanedHints = hints.filter((h) => {
    const c = normalizeDistrictNeedle(h);
    const cityC = normalizeDistrictNeedle(cityName);
    if (!c) return false;
    if (cityC && c === cityC) return false;
    if (isCountryLabel(h)) return false;
    return true;
  });

  const needles = addressTokens(...cleanedHints);
  if (!needles.length) return null;

  const scoreDistrict = (d) => {
    const districtFields = [d.districtName, d.districtOtherName]
      .map(normalizeDistrictNeedle)
      .filter(Boolean);
    const zoneFields = [d.zoneName, d.zoneOtherName].map(normalizeDistrictNeedle).filter(Boolean);
    let best = 0;
    for (const needle of needles) {
      const longNeedle = needle.length >= 8;
      for (const field of districtFields) {
        if (field === needle) best = Math.max(best, longNeedle ? 160 : 130);
        else if (field.includes(needle) && needle.length >= 5) {
          // Prefer longer needles so "mustafakamel" beats stray "كامل".
          best = Math.max(best, 80 + Math.min(40, needle.length));
        } else if (needle.includes(field) && field.length >= 6) {
          best = Math.max(best, 100);
        }
      }
      for (const field of zoneFields) {
        if (field === needle) best = Math.max(best, 45);
        else if (field.includes(needle) && needle.length >= 6) best = Math.max(best, 35);
      }
    }
    return best;
  };

  const covered = districts.filter(isDropOffCovered);
  const pool = covered.length ? covered : districts;

  let best = null;
  let bestScore = 0;
  for (const d of pool) {
    const score = scoreDistrict(d);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }

  // Require a strong district-level match (not a weak substring).
  return bestScore >= 100 ? best : null;
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

  const phone = String(shipping.phone || '').trim();
  if (!phone) {
    const err = new Error(
      'Shopify shipping phone is required to create a Bosta delivery. Fix the ship-to phone on Shopify, then retry.'
    );
    err.statusCode = 400;
    throw err;
  }

  // Paid Shopify / online → COD 0. Return pickups → COD 0 (never pay the customer).
  // Creator / exchange follow order totals (exchange goods = price diff in totalSellingPrice).
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

  // Receiver = Shopify ship-to name only (not the customer account name).
  const shipToName = String(shipping.fullName || '').trim();
  if (!shipToName) {
    const err = new Error(
      'Shopify ship-to name is required for Bosta. Fix shipping address name on Shopify, then retry.'
    );
    err.statusCode = 400;
    throw err;
  }
  const { firstName, lastName } = splitName(shipToName);
  if (customer?.fullName && customer.fullName.trim() !== shipToName) {
    logger.info(
      {
        orderId: String(order._id),
        accountName: customer.fullName,
        shipToName,
      },
      'Bosta receiver uses Shopify ship-to name (differs from customer account)'
    );
  }

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
  const cityId = resolved?.cityId || null;

  // Bosta rejects very short first lines ("6046") — enrich with area/city for the courier.
  if (line1.length < 10) {
    line1 = [line1, zone, bostaCityName].filter(Boolean).join(', ');
  }

  // Ignore zone when it duplicates the city (Shopify often sets both to "Alexandria").
  const zoneHint = compactCity(zone) && compactCity(zone) !== compactCity(bostaCityName) ? zone : '';
  const district = await resolveBostaDistrict(cityId, bostaCityName, zoneHint, shipping.line2, line1);

  // Prefer resolved Bosta zone/district so geocoder covers the area (Smouha, etc.).
  // When districtId is set, `zone` must be Bosta's zoneName (e.g. Sidi Gaber), not districtName.
  const dropOffAddress = {
    city: bostaCityName,
    ...(cityId ? { cityId } : {}),
    firstLine: line1,
    secondLine: shipping.line2 || '',
    zone: district?.zoneName || zoneHint || (resolved?.aliased ? shipping.city : '') || '',
  };
  if (district?.districtId) {
    dropOffAddress.districtId = district.districtId;
    dropOffAddress.districtName = district.districtName;
    if (district.zoneId) dropOffAddress.zoneId = district.zoneId;
  }

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

  // Bosta Flex otherwise prints a second customer shipping fee (~EGP 80) on the AWB
  // on top of our COD. Shipping is already in COD (exchange = diff+fee; SEND = goods+fee).
  // These fields are create-only (Bosta rejects later updates).
  if (order.isExchangeOrder || codAmount > 0 || isOrderPrepaidForBosta(order) || order.isReturnOrder) {
    payload.isCustomerPayShipping = false;
    payload.customerShippingFee = 0;
    payload.businessPaidShipping = true;
  }

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

    // Older Bosta accounts may reject Flex opt-out fields — retry once without them.
    if (
      payload.isCustomerPayShipping != null &&
      /isCustomerPayShipping|customerShippingFee|businessPaidShipping|flexShipping/i.test(msg)
    ) {
      const {
        isCustomerPayShipping: _a,
        customerShippingFee: _b,
        businessPaidShipping: _c,
        ...withoutFlexOptOut
      } = payload;
      try {
        const response = await bostaRequest('/deliveries', {
          method: 'POST',
          body: withoutFlexOptOut,
        });
        return response?.data || response;
      } catch {
        /* fall through to normal error handling with original err */
      }
    }

    // Uncovered (4009) / Zone Not Found (3002): bad district or zone pairing.
    // Retry once with zone = district name (no districtId) — Bosta geocodes Smouha etc. that way.
    if (/uncovered drop.?off|uncovered pickup|zone not found|errorCode.?(4009|3002)/i.test(msg)) {
      const areaHint =
        dropOffAddress.districtName ||
        dropOffAddress.zone ||
        zoneHint ||
        bostaCityName;
      if (payload.dropOffAddress?.districtId || /zone not found/i.test(msg)) {
        const retryAddress = {
          city: dropOffAddress.city,
          ...(dropOffAddress.cityId ? { cityId: dropOffAddress.cityId } : {}),
          firstLine: dropOffAddress.firstLine,
          secondLine: dropOffAddress.secondLine || '',
          zone: dropOffAddress.districtName || areaHint,
        };
        const retryPayload = {
          ...payload,
          dropOffAddress: retryAddress,
          ...(payload.pickupAddress ? { pickupAddress: { ...retryAddress } } : {}),
        };
        try {
          const response = await bostaRequest('/deliveries', { method: 'POST', body: retryPayload });
          return response?.data || response;
        } catch (retryErr) {
          const wrapped = new Error(
            `Bosta does not cover this area (“${areaHint}”). Open the order, pick a covered area/district (e.g. Smouha), then retry.`
          );
          wrapped.statusCode = 400;
          wrapped.code = 'UNCOVERED_ADDRESS';
          wrapped.cause = retryErr?.message;
          throw wrapped;
        }
      }
      const wrapped = new Error(
        `Bosta does not cover this drop-off area in ${bostaCityName}. Open the order, set a covered area/district from the street text (e.g. Smouha), then retry.`
      );
      wrapped.statusCode = 400;
      wrapped.code = 'UNCOVERED_ADDRESS';
      throw wrapped;
    }

    if (/insufficient parameters/i.test(msg)) {
      const wrapped = new Error(
        `Bosta needs a fuller street address (got “${shipping.line1 || ''}”). Open the order, add building/street details, then retry the policy.`
      );
      wrapped.statusCode = 400;
      throw wrapped;
    }
    if (/cannot read properties of undefined.*city/i.test(msg)) {
      const wrapped = new Error(
        `Bosta could not resolve the city/area for “${bostaCityName}${zone ? ` · ${zone}` : ''}”. Pick a Bosta city, then an area/district, then retry.`
      );
      wrapped.statusCode = 400;
      wrapped.code = 'INVALID_CITY';
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
 * In-transit shipments often reject `notes` — retry without notes if needed.
 */
export async function updateDeliveryPackageDescription(deliveryId, order) {
  const id = String(deliveryId || '').trim();
  if (!id || !order) return null;

  const variantsById = await loadVariantsForOrder(order);
  const itemsCount = (order.items || []).reduce((s, i) => s + (i.quantity || 0), 0);
  const description = buildPackageDescription(order, variantsById);
  const baseBody = {
    allowToOpenPackage: true,
    specs: { packageDetails: { itemsCount, description } },
    // Keep COD in sync — paid Shopify orders must stay 0 on the AWB.
    cod: bostaCodAmountForOrder(order),
  };

  const base = (config.BOSTA_API_BASE_URL || 'https://app.bosta.co/api/v2').replace(/\/api\/v2\/?$/, '');
  const url = `${base}/api/v0/deliveries/${encodeURIComponent(id)}`;

  async function put(body) {
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
    return { response, data };
  }

  let { response, data } = await put({ ...baseBody, notes: description });
  if (!response.ok && /notes/i.test(String(data?.message || ''))) {
    ({ response, data } = await put(baseBody));
  }
  if (!response.ok) {
    const err = new Error(data.message || `Bosta delivery update failed: ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }
  return { description, data };
}

/**
 * Push OMS shipping address + COD onto an existing Bosta AWB (v0 PUT).
 * Used when OM corrects destination after the AWB was already created.
 */
export async function updateDeliveryAddressAndCod(deliveryId, order, customer) {
  const id = String(deliveryId || '').trim();
  if (!id || !order) return null;

  const shipping = order.shippingAddress || {};
  let city = typeof shipping.city === 'string' ? shipping.city.trim() : '';
  let zone = typeof shipping.zone === 'string' ? shipping.zone.trim() : '';
  let line1 = typeof shipping.line1 === 'string' ? shipping.line1.trim() : '';
  if (!line1 || !city) {
    const err = new Error('Shipping address needs street and city to update Bosta');
    err.statusCode = 400;
    throw err;
  }

  const phone = String(shipping.phone || '').trim();
  if (!phone) {
    const err = new Error('Shopify shipping phone is required to update Bosta');
    err.statusCode = 400;
    throw err;
  }
  const shipToName = String(shipping.fullName || '').trim();
  if (!shipToName) {
    const err = new Error('Shopify ship-to name is required to update Bosta');
    err.statusCode = 400;
    throw err;
  }
  const { firstName, lastName } = splitName(shipToName);

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

  const bostaCityName = resolved?.resolvedName || city;
  const cityId = resolved?.cityId || null;
  if (line1.length < 10) {
    line1 = [line1, zone, bostaCityName].filter(Boolean).join(', ');
  }
  const zoneHint = compactCity(zone) && compactCity(zone) !== compactCity(bostaCityName) ? zone : '';
  const district = await resolveBostaDistrict(cityId, bostaCityName, zoneHint, shipping.line2, line1);

  const dropOffAddress = {
    city: bostaCityName,
    ...(cityId ? { cityId } : {}),
    firstLine: line1,
    secondLine: shipping.line2 || '',
    zone: district?.zoneName || zoneHint || (resolved?.aliased ? shipping.city : '') || '',
  };
  if (district?.districtId) {
    dropOffAddress.districtId = district.districtId;
    dropOffAddress.districtName = district.districtName;
    if (district.zoneId) dropOffAddress.zoneId = district.zoneId;
  }

  const body = {
    allowToOpenPackage: true,
    cod: bostaCodAmountForOrder(order),
    dropOffAddress,
    receiver: {
      firstName,
      lastName,
      ...(phone ? { phone } : {}),
    },
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
    const err = new Error(data.message || `Bosta address update failed: ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }
  logger.info(
    {
      deliveryId: id,
      orderId: String(order._id),
      city: bostaCityName,
      cod: body.cod,
    },
    'Updated Bosta delivery address + COD'
  );
  return { dropOffAddress, cod: body.cod, data };
}

export async function getDelivery(deliveryIdOrTracking) {
  const key = String(deliveryIdOrTracking || '').trim();
  if (!key) {
    const err = new Error('Missing Bosta delivery id/tracking');
    err.statusCode = 400;
    throw err;
  }

  const byBusinessTracking = async (tracking, { quiet = false } = {}) => {
    const byTracking = await bostaRequest(
      `/deliveries/business/${encodeURIComponent(tracking)}`,
      { quiet }
    );
    return byTracking?.data || byTracking;
  };

  // Prefer business tracking lookup — GET /deliveries/:id often 404s on v2
  // (PHP SDK get() also takes tracking numbers, not Mongo-style delivery ids).
  if (/^\d{8,}$/.test(key)) {
    return byBusinessTracking(key);
  }

  // Alphanumeric Bosta delivery id → resolve OMS tracking, then business lookup.
  try {
    const order = await Order.findOne({ bostaDeliveryId: key })
      .select('bostaTrackingNumber')
      .lean();
    const tracking =
      order?.bostaTrackingNumber != null ? String(order.bostaTrackingNumber).trim() : '';
    if (tracking) {
      return byBusinessTracking(tracking);
    }
  } catch {
    /* continue */
  }

  // Quiet probes — expected 404s must not spam "Bosta API error".
  try {
    return await byBusinessTracking(key, { quiet: true });
  } catch {
    /* continue */
  }

  try {
    const response = await bostaRequest(`/deliveries/${encodeURIComponent(key)}`, {
      quiet: true,
    });
    return response?.data || response;
  } catch (err) {
    err.message = err.message || `Bosta delivery not found: ${key}`;
    throw err;
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
  updateDeliveryAddressAndCod,
  isOrderPrepaidForBosta,
  bostaCodAmountForOrder,
  bostaDeliveryTypeForOrder,
  BOSTA_DELIVERY_TYPE,
};
