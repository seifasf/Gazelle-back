/**
 * Shopify shipping zones (Gazelle store) — synced from Admin shipping_zones + rate cards.
 * Local courier is NOT zone-based (always LOCAL_SHIPPING_FEE).
 */

export const SHOPIFY_FREE_SHIPPING_MIN = 2999;

/** Compact lowercase alnum for city / province matching. */
export function compactPlace(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, '');
}

/**
 * Zone id → standard fee (EGP). Zones 1–4 get free shipping at SHOPIFY_FREE_SHIPPING_MIN+.
 * Zone 5 has no free-shipping option.
 */
export const SHOPIFY_SHIPPING_ZONES = [
  {
    id: 'cairo-50',
    name: 'Cairo-50',
    fee: 95,
    /** What Bosta invoices Gazelle (not the customer shipping rate). */
    bostaFee: 50,
    freeOver: SHOPIFY_FREE_SHIPPING_MIN,
    // Shopify provinces: 6th of October | Cairo | Giza | Helwan
    places: [
      'cairo', 'giza', 'helwan', '6thofoctober', '6thoctober', 'sixthofoctober', 'october',
      'newcairo', 'madinaty', 'rehab', 'shorouk', 'heliopolis', 'nasrcity', 'maadi',
      'mokattam', 'zamalek', 'dokki', 'mohandessin', 'haram', 'sheikhzayed', 'el sheikh zayed',
      'القاهرة', 'القاهره', 'الجيزة', 'الجيزه', 'حلوان', 'اكتوبر', 'أكتوبر', 'الشيخزايد',
      'مدينتي', 'الرحاب', 'الشروق', 'مصرالجديدة', 'مدينةنصر', 'المعادي', 'المقطم',
    ],
  },
  {
    id: 'zone2-60',
    name: 'Zone2-60',
    fee: 100,
    bostaFee: 60,
    freeOver: SHOPIFY_FREE_SHIPPING_MIN,
    // Al Sharqia | Ismailia | Monufia | Port Said | Qalyubia | Alexandria
    places: [
      'alexandria', 'alsharqia', 'sharqia', 'sharkia', 'ismailia', 'monufia', 'menoufia',
      'portsaid', 'qalyubia', 'kalioubia', 'elkalioubia', 'obour', 'العبور',
      'الاسكندرية', 'الاسكندريه', 'الشرقية', 'الإسماعيلية', 'الاسماعيلية', 'المنوفية',
      'بورسعيد', 'القليوبية', 'القليوبيه',
    ],
  },
  {
    id: 'zone3-70',
    name: 'Zone3-70',
    fee: 105,
    bostaFee: 65,
    freeOver: SHOPIFY_FREE_SHIPPING_MIN,
    // Beheira | Beni Suef | Dakahlia | Damietta | Faiyum | Gharbia | Kafr el-Sheikh | Suez
    places: [
      'beheira', 'behira', 'benisuef', 'banisuif', 'dakahlia', 'damietta', 'faiyum', 'fayoum',
      'gharbia', 'kafrels heikh', 'kafralsheikh', 'kafrelsheikh', 'suez',
      'tanta', 'mansoura', 'البحيرة', 'بنيسويف', 'الدقهلية', 'دمياط', 'الفيوم',
      'الغربية', 'كفرالشيخ', 'السويس', 'طنطا', 'المنصورة',
    ],
  },
  {
    id: 'zone4-90',
    name: 'Zone4-90',
    fee: 140,
    bostaFee: 85,
    freeOver: SHOPIFY_FREE_SHIPPING_MIN,
    // Aswan | Asyut | Luxor | Minya | Qena | Sohag
    places: [
      'aswan', 'asyut', 'assuit', 'assiut', 'luxor', 'minya', 'menya', 'qena', 'sohag',
      'اسوان', 'اسيوط', 'أسيوط', 'الأقصر', 'الاقصر', 'المنيا', 'قنا', 'سوهاج',
    ],
  },
  {
    id: 'zone5-100',
    name: 'Zone5-100',
    fee: 195,
    bostaFee: 110,
    freeOver: null,
    // North Sinai | South Sinai | Matrouh | Red Sea | New Valley
    places: [
      'northsinai', 'southsinai', 'matrouh', 'redsea', 'newvalley', 'hurghada', 'sharm',
      'northcoast', 'الساحلالشمالي', 'شمالسيناء', 'جنوبسيناء', 'مطروح', 'البحرالأحمر',
      'البحرالاحمر', 'الواديالجديد', 'الغردقة', 'شرمالشيخ',
    ],
  },
];

const PLACE_TO_ZONE = (() => {
  const map = new Map();
  for (const zone of SHOPIFY_SHIPPING_ZONES) {
    for (const place of zone.places) {
      map.set(compactPlace(place), zone);
    }
  }
  return map;
})();

export function findShopifyShippingZone(city) {
  const raw = String(city || '').trim();
  if (!raw) return null;
  const compact = compactPlace(raw);
  if (!compact) return null;

  const exact = PLACE_TO_ZONE.get(compact);
  if (exact) return exact;

  // Fuzzy: city string contains a known place token (or vice versa).
  for (const [place, zone] of PLACE_TO_ZONE) {
    if (place.length < 4) continue;
    if (compact.includes(place) || place.includes(compact)) return zone;
  }
  return null;
}

/**
 * Shopify-matched shipping for Bosta / online checkout destinations.
 * @param {string} city
 * @param {number} [goodsTotal=0] merchandise subtotal (excludes shipping)
 * @returns {{ fee: number, zone: object|null, free: boolean }}
 */
export function resolveShopifyZoneShippingFee(city, goodsTotal = 0) {
  const zone = findShopifyShippingZone(city);
  const goods = Number(goodsTotal);
  const safeGoods = Number.isFinite(goods) && goods > 0 ? goods : 0;

  if (!zone) {
    // Fallback = Cairo-50 standard (most common destination).
    const fee = 95;
    const free = safeGoods >= SHOPIFY_FREE_SHIPPING_MIN;
    return { fee: free ? 0 : fee, zone: null, free };
  }

  const free =
    zone.freeOver != null &&
    Number.isFinite(zone.freeOver) &&
    safeGoods >= zone.freeOver;
  return { fee: free ? 0 : zone.fee, zone, free };
}

/** Default Bosta courier cost when city is unknown (Cairo-50). */
export const DEFAULT_BOSTA_COURIER_FEE = 50;

/**
 * What Bosta charges Gazelle for this destination — not the Shopify/customer shipping fee.
 * Pickup and local courier are 0 (Bosta is not used).
 */
export function resolveBostaCourierFee(orderOrCity) {
  if (orderOrCity && typeof orderOrCity === 'object') {
    const method = orderOrCity.shippingMethod || 'bosta';
    if (method === 'pickup' || method === 'local_shipping') return 0;
    const city = orderOrCity.shippingAddress?.city;
    const zone = findShopifyShippingZone(city);
    return zone?.bostaFee ?? DEFAULT_BOSTA_COURIER_FEE;
  }
  const zone = findShopifyShippingZone(orderOrCity);
  return zone?.bostaFee ?? DEFAULT_BOSTA_COURIER_FEE;
}
