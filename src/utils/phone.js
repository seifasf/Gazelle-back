/** Egyptian phone helpers — match 010… / +2010… / 2010… forms. */

export function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/** National mobile without leading 0 (10 digits when complete). */
export function normalizeEgPhoneDigits(phone) {
  let d = digitsOnly(phone);
  if (!d) return '';
  if (d.startsWith('20') && d.length >= 12) d = d.slice(2);
  if (d.startsWith('0') && d.length >= 11) d = d.slice(1);
  return d.slice(-10);
}

/** Regex-safe patterns that match common stored phone formats for the same handset. */
export function phoneMatchRegexes(phone) {
  const core = normalizeEgPhoneDigits(phone);
  if (core.length < 7) return [];
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match ending with national digits (covers 0…, +20…, spaces/dashes stripped in stored forms poorly —
  // so also allow optional non-digits between and prefix noise via suffix match on digits-only we can't do in Mongo easily).
  // Practical: suffix match on the national number as typed in OMS.
  return [
    new RegExp(`${escaped}$`),
    new RegExp(`0${escaped}$`),
    new RegExp(`20${escaped}$`),
  ];
}
