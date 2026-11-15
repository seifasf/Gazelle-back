/**
 * Flextock create-order requires city/area from their supported English lists.
 * Staff often type Arabic neighborhoods or lowercase cities — normalize before send.
 */

function compact(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

function titleCaseEnglish(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => {
      if (/^\d/.test(w)) return w; // 6th, 6
      if (w.length <= 2 && /^(el|al|of)$/i.test(w)) return w.toLowerCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ')
    .replace(/\bEl\b/g, 'El')
    .replace(/\bAl\b/g, 'Al');
}

/** Governorate / city names Flextock-style (English). */
const CITY_ALIASES = {
  cairo: 'Cairo',
  القاهره: 'Cairo',
  القاهرهالكبري: 'Cairo',
  giza: 'Giza',
  الجيزه: 'Giza',
  alexandria: 'Alexandria',
  alex: 'Alexandria',
  الاسكندريه: 'Alexandria',
  '6october': '6th of October',
  '6thofoctober': '6th of October',
  sixthofoctober: '6th of October',
  october: '6th of October',
  اكتوبر: '6th of October',
  اكتوبر٦: '6th of October',
  sheikhzayed: 'Sheikh Zayed',
  الشيخزايد: 'Sheikh Zayed',
  newcairo: 'New Cairo',
  القاهرهالجديده: 'New Cairo',
  helwan: 'Helwan',
  حلوان: 'Helwan',
  shubra: 'Shubra',
  شبرا: 'Shubra',
  mansoura: 'Mansoura',
  المنصوره: 'Mansoura',
  tanta: 'Tanta',
  طنطا: 'Tanta',
  ismailia: 'Ismailia',
  الاسماعيليه: 'Ismailia',
  portsaid: 'Port Said',
  بورسعيد: 'Port Said',
  suez: 'Suez',
  السويس: 'Suez',
  aswan: 'Aswan',
  اسوان: 'Aswan',
  luxor: 'Luxor',
  الاقصر: 'Luxor',
};

/** Common Cairo/Giza area spellings → Latin names used by carriers. */
const AREA_ALIASES = {
  zeitoun: 'El Zeitoun',
  zaitoun: 'El Zeitoun',
  zaytoun: 'El Zeitoun',
  zayton: 'El Zeitoun',
  zaiton: 'El Zeitoun',
  elzeitoun: 'El Zeitoun',
  elzaitoun: 'El Zeitoun',
  elzaytoun: 'El Zeitoun',
  elzayton: 'El Zeitoun',
  elzaiton: 'El Zeitoun',
  الزيتون: 'El Zeitoun',
  زيتون: 'El Zeitoun',
  heliopolis: 'Heliopolis',
  مصرالجديده: 'Heliopolis',
  nasrcity: 'Nasr City',
  مدينهنصر: 'Nasr City',
  maadi: 'Maadi',
  المعادي: 'Maadi',
  معادي: 'Maadi',
  mokattam: 'Mokattam',
  المقطم: 'Mokattam',
  مقطم: 'Mokattam',
  dokki: 'Dokki',
  الدقي: 'Dokki',
  mohandessin: 'Mohandessin',
  المهندسين: 'Mohandessin',
  zamalek: 'Zamalek',
  الزمالك: 'Zamalek',
  agouza: 'Agouza',
  العجوزه: 'Agouza',
  haram: 'Haram',
  الهرم: 'Haram',
  faisal: 'Faisal',
  فيصل: 'Faisal',
  imbaba: 'Imbaba',
  امبابه: 'Imbaba',
  shubrakheima: 'Shubra El Kheima',
  شبراالخيمه: 'Shubra El Kheima',
  ainshams: 'Ain Shams',
  عينشمس: 'Ain Shams',
  matariya: 'El Matareya',
  المطرية: 'El Matareya',
  المطريه: 'El Matareya',
  tagamou: 'New Cairo',
  tagamou3: 'New Cairo',
  التجمع: 'New Cairo',
  التجمعالخامس: 'New Cairo',
  fifthsettlement: 'New Cairo',
  rehab: 'El Rehab',
  الرحاب: 'El Rehab',
  madinaty: 'Madinaty',
  مدينتي: 'Madinaty',
  obour: 'El Obour',
  العبور: 'El Obour',
  shorouk: 'El Shorouk',
  الشروق: 'El Shorouk',
  newgiza: 'New Giza',
  نيوجيزه: 'New Giza',
  smouha: 'Smouha',
  سموحه: 'Smouha',
  montaza: 'Montaza',
  المنتزه: 'Montaza',
};

function lookupAlias(map, value) {
  const key = compact(value);
  if (!key) return '';
  if (map[key]) return map[key];
  // Partial: "el zaiton cairo" style zone strings — pick longest matching alias key.
  let best = '';
  let bestLen = 0;
  for (const [alias, canonical] of Object.entries(map)) {
    if (alias.length >= 4 && key.includes(alias) && alias.length > bestLen) {
      best = canonical;
      bestLen = alias.length;
    }
  }
  return best;
}

export function normalizeFlextockCity(city) {
  const raw = String(city || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const aliased = lookupAlias(CITY_ALIASES, raw);
  if (aliased) return aliased;
  // Already Latin letters — title-case.
  if (/^[a-z0-9\s.'\-]+$/i.test(raw)) return titleCaseEnglish(raw);
  return raw;
}

export function normalizeFlextockArea(area, city = '') {
  const raw = String(area || '').replace(/\s+/g, ' ').trim();
  if (!raw) return normalizeFlextockCity(city);
  const aliased = lookupAlias(AREA_ALIASES, raw);
  if (aliased) return aliased;
  if (/^[a-z0-9\s.'\-]+$/i.test(raw)) return titleCaseEnglish(raw);
  // Arabic with no alias — keep as-is but staff should fix; callers can warn.
  return raw;
}

export function flextockAddressNeedsReview(city, area) {
  const c = String(city || '');
  const a = String(area || '');
  const arabic = /[\u0600-\u06FF]/;
  return arabic.test(c) || arabic.test(a);
}

export default {
  normalizeFlextockCity,
  normalizeFlextockArea,
  flextockAddressNeedsReview,
};
