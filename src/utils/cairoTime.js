/** Business calendar for Gazelle (Egypt). */
export const BUSINESS_TZ = 'Africa/Cairo';

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Format a Date as YYYY-MM-DD in the business timezone. */
export function formatYmdInTz(date, timeZone = BUSINESS_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Convert a calendar YYYY-MM-DD in BUSINESS_TZ to a UTC Date at start/end of that day.
 */
export function zonedDayBound(ymd, end = false, timeZone = BUSINESS_TZ) {
  const m = String(ymd).match(YMD_RE);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hour = end ? 23 : 0;
  const minute = end ? 59 : 0;
  const second = end ? 59 : 0;
  const ms = end ? 999 : 0;

  // Guess UTC instant, then correct using the zone offset at that instant.
  let utc = Date.UTC(y, mo - 1, d, hour, minute, second, ms);
  const asTz = new Date(utc).toLocaleString('en-US', { timeZone });
  const asUtc = new Date(utc).toLocaleString('en-US', { timeZone: 'UTC' });
  const shift = new Date(asUtc).getTime() - new Date(asTz).getTime();
  utc += shift;

  // Re-check after shift (DST edges).
  const ymdCheck = formatYmdInTz(new Date(utc), timeZone);
  if (ymdCheck !== `${m[1]}-${m[2]}-${m[3]}`) {
    utc += (ymdCheck < `${m[1]}-${m[2]}-${m[3]}` ? 1 : -1) * 60 * 60 * 1000;
  }
  return new Date(utc);
}

function parseRangeBound(value, end) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  const s = String(value).trim();
  if (YMD_RE.test(s)) return zonedDayBound(s, end);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Range `from` value: a bare YYYY-MM-DD means start of that Cairo day; full timestamps pass through. */
export function rangeStart(value) {
  return parseRangeBound(value, false);
}

/** Range `to` value: a bare YYYY-MM-DD means end of that Cairo day (inclusive); full timestamps pass through. */
export function rangeEnd(value) {
  return parseRangeBound(value, true);
}

/** Mongo `{ $gte, $lte }` for a from/to query pair, or null when neither bound is usable. */
export function dateRangeFilter(from, to) {
  const start = rangeStart(from);
  const end = rangeEnd(to);
  if (!start && !end) return null;
  const filter = {};
  if (start) filter.$gte = start;
  if (end) filter.$lte = end;
  return filter;
}
