import { config } from '../../config/index.js';
import PaymobReceived from '../../models/PaymobReceived.js';
import logger from '../../utils/logger.js';

const ACCEPT_BASE = 'https://accept.paymob.com/api';
const PAGE_SIZE = 50;
const BUSINESS_TZ = 'Africa/Cairo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isPaymobApiConfigured() {
  return Boolean(config.PAYMOB_API_KEY);
}

async function getAuthToken() {
  if (!config.PAYMOB_API_KEY) {
    const err = new Error('Paymob API key not configured');
    err.statusCode = 400;
    throw err;
  }
  const response = await fetch(`${ACCEPT_BASE}/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: config.PAYMOB_API_KEY }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) {
    const err = new Error(data?.detail || data?.message || `Paymob auth failed (${response.status})`);
    err.statusCode = response.status;
    throw err;
  }
  return data.token;
}

/**
 * Paymob often returns naive datetimes (no Z). Treat those as Africa/Cairo wall time
 * so Render (UTC) and local (Cairo) store the same instant.
 */
export function parsePaymobTimestamp(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?/);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = Number(m[6]);
  const ms = m[7] ? Math.round(Number(`0${m[7]}`) * 1000) : 0;

  // Guess UTC, then correct by Cairo offset at that instant.
  let utc = Date.UTC(y, mo - 1, day, h, mi, sec, ms);
  const asTz = new Date(utc).toLocaleString('en-US', { timeZone: BUSINESS_TZ });
  const asUtc = new Date(utc).toLocaleString('en-US', { timeZone: 'UTC' });
  const shift = new Date(asUtc).getTime() - new Date(asTz).getTime();
  utc += shift;
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymdInCairo(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

async function fetchTransactionsPage(token, page, { dateFrom, dateTo, maxRetries = 4 } = {}) {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(PAGE_SIZE),
  });
  // Prefer server-side date filter when Accept supports it (Cairo calendar days).
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);

  const url = `${ACCEPT_BASE}/acceptance/transactions?${params}`;
  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        return { results: data.results || [], hasNext: Boolean(data.next) };
      }
      lastErr = new Error(data?.detail || data?.message || `Paymob transactions failed (${response.status})`);
      lastErr.statusCode = response.status;
      if (response.status >= 500 || response.status === 429) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw lastErr;
    } catch (err) {
      lastErr = err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr || new Error('Paymob transactions failed');
}

function isSuccessfulTx(tx) {
  return Boolean(
    tx?.success &&
      !tx.pending &&
      !tx.is_voided &&
      !tx.is_refunded &&
      !tx.error_occured
  );
}

async function flushUpserts(upserts) {
  if (!upserts.length) return;
  const BATCH = 200;
  for (let i = 0; i < upserts.length; i += BATCH) {
    await PaymobReceived.bulkWrite(upserts.slice(i, i + BATCH), { ordered: false });
  }
  upserts.length = 0;
}

/**
 * Pull successful Paymob Accept transactions in [from, to].
 * Returns the live API sum (source of truth) and upserts into PaymobReceived page-by-page
 * so a dashboard timeout still leaves a useful ledger.
 */
export async function sumSuccessfulTransactions({ from, to, maxPages = 80 } = {}) {
  const token = await getAuthToken();
  let amount = 0;
  let count = 0;
  let pages = 0;
  const seen = new Set();
  const upserts = [];
  const dateFrom = ymdInCairo(from);
  const dateTo = ymdInCairo(to);
  // Accept's date_from/date_to under-counts vs the portal "Total Sales" filter —
  // page newest-first without server date filter, then clip client-side.
  const useDateFilter = false;

  for (let page = 1; page <= maxPages; page += 1) {
    pages = page;
    const { results, hasNext } = await fetchTransactionsPage(token, page, {
      dateFrom: useDateFilter ? dateFrom : undefined,
      dateTo: useDateFilter ? dateTo : undefined,
    });
    if (!results.length) break;

    let oldestOnPage = null;
    for (const tx of results) {
      const created = parsePaymobTimestamp(tx.paid_at || tx.created_at);
      if (!created) continue;
      if (!oldestOnPage || created < oldestOnPage) oldestOnPage = created;

      if (!isSuccessfulTx(tx)) continue;
      if (created < from || created > to) continue;

      const id = String(tx.id);
      if (seen.has(id)) continue;
      seen.add(id);

      const egp = Number(tx.amount_cents || 0) / 100;
      if (!(egp > 0)) continue;
      amount += egp;
      count += 1;

      upserts.push({
        updateOne: {
          filter: { externalId: id },
          update: {
            $set: {
              externalId: id,
              amountEgp: egp,
              receivedAt: created,
            },
          },
          upsert: true,
        },
      });
    }

    // Persist each page so timeouts don't leave the ledger stuck on old totals.
    await flushUpserts(upserts);

    // Newest-first listing: once oldest on this page is before the window, later pages are older.
    if (oldestOnPage && oldestOnPage < from) break;
    if (!hasNext) break;
  }

  amount = Math.round(amount * 100) / 100;
  logger.info({ amount, count, pages, from, to, dateFrom, dateTo }, 'Paymob transactions sync complete');
  return { amount, count, source: 'paymob_api', pages };
}

/**
 * Sync Paymob into the ledger for a range, then return live API totals
 * (not a stale ledger aggregate if sync was partial).
 */
export async function syncAndSumPaymobReceived({ from, to, maxPages = 80 } = {}) {
  if (!isPaymobApiConfigured()) {
    return { amount: 0, count: 0, source: 'unavailable', real: false };
  }

  try {
    const live = await sumSuccessfulTransactions({ from, to, maxPages });
    return {
      amount: live.amount,
      count: live.count,
      source: 'paymob',
      real: true,
      pages: live.pages,
    };
  } catch (err) {
    logger.warn({ err }, 'Paymob live sync failed — using ledger only');
  }

  const [row] = await PaymobReceived.aggregate([
    { $match: { receivedAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: null,
        amount: { $sum: '$amountEgp' },
        count: { $sum: 1 },
      },
    },
  ]);

  return {
    amount: row?.amount ?? 0,
    count: row?.count ?? 0,
    source: 'paymob_ledger',
    real: true,
  };
}

export default {
  isPaymobApiConfigured,
  parsePaymobTimestamp,
  sumSuccessfulTransactions,
  syncAndSumPaymobReceived,
};
