import logger from './logger.js';

const BUSINESS_TZ = 'Africa/Cairo';
const PING_EVERY_MS = 10 * 60 * 1000;
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "8-24" -> { start: 8, end: 24 }. End may be smaller than start to run past midnight (e.g. "9-2"). */
export function parseAwakeHours(value = '8-24') {
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(value));
  if (!match) return { start: 8, end: 24 };
  const start = Math.min(Number(match[1]), 23);
  const end = Math.min(Number(match[2]), 24);
  return { start, end };
}

/** "fri,sat" -> ['fri', 'sat'] */
export function parseOffDays(value = 'fri') {
  return String(value)
    .split(',')
    .map((d) => d.trim().toLowerCase().slice(0, 3))
    .filter((d) => DAY_KEYS.includes(d));
}

function cairoClock(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday').value.toLowerCase().slice(0, 3);
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  return { dayIndex: DAY_KEYS.indexOf(weekday), hour };
}

/** True while the business wants the API warm (working hours, not an off day), in Cairo time. */
export function isWithinAwakeWindow(date, { start, end, offDays }) {
  const { dayIndex, hour } = cairoClock(date);
  const wraps = end <= start;
  let shiftDay = dayIndex;
  if (wraps) {
    if (hour >= start) shiftDay = dayIndex;
    else if (hour < end) shiftDay = (dayIndex + 6) % 7;
    else return false;
  } else if (hour < start || hour >= end) {
    return false;
  }
  return !offDays.includes(DAY_KEYS[shiftDay]);
}

/**
 * Render free web services sleep after 15 minutes without inbound traffic.
 * Pinging our own public URL during working hours keeps the API fast for staff,
 * while nights and off days are allowed to sleep to stay under the free instance hours.
 */
export function startKeepAwake({ appUrl, mode = 'auto', nodeEnv, hours, offDays }) {
  const enabled =
    mode === 'on' || (mode === 'auto' && nodeEnv === 'production' && /^https:\/\//.test(appUrl || ''));
  if (!enabled) return null;

  const awakeWindow = { ...parseAwakeHours(hours), offDays: parseOffDays(offDays) };
  const url = `${appUrl.replace(/\/+$/, '')}/api/v1/health`;

  const tick = async () => {
    if (!isWithinAwakeWindow(new Date(), awakeWindow)) return;
    try {
      await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      logger.warn({ err: err?.message || err }, 'Keep-awake ping failed');
    }
  };

  const timer = setInterval(tick, PING_EVERY_MS);
  timer.unref();
  logger.info({ url, ...awakeWindow }, 'Keep-awake enabled (working hours only)');
  return timer;
}
