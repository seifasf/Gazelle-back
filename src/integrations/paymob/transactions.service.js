import { config } from '../../config/index.js';
import PaymobReceived from '../../models/PaymobReceived.js';
import logger from '../../utils/logger.js';

const ACCEPT_BASE = 'https://accept.paymob.com/api';
const PAGE_SIZE = 50;
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

async function fetchTransactionsPage(token, page, { maxRetries = 4 } = {}) {
  const url = `${ACCEPT_BASE}/acceptance/transactions?page=${page}&page_size=${PAGE_SIZE}`;
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
      // Retry transient 5xx / rate limits.
      if (response.status >= 500 || response.status === 429) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      throw lastErr;
    } catch (err) {
      lastErr = err;
      await sleep(700 * (attempt + 1));
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

/**
 * Pull successful Paymob Accept transactions in [from, to] into PaymobReceived,
 * then return the summed amount/count for that window.
 *
 * Uses page_size=50 (Accept default is only 10) and retries flaky 500s.
 */
export async function sumSuccessfulTransactions({ from, to, maxPages = 80 } = {}) {
  const token = await getAuthToken();
  let amount = 0;
  let count = 0;
  let pages = 0;
  const seen = new Set();
  const upserts = [];

  for (let page = 1; page <= maxPages; page += 1) {
    pages = page;
    const { results, hasNext } = await fetchTransactionsPage(token, page);
    if (!results.length) break;

    let oldestOnPage = null;
    for (const tx of results) {
      const created = new Date(tx.paid_at || tx.created_at || 0);
      if (Number.isNaN(created.getTime())) continue;
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

    // Past the requested window (newest-first listing).
    if (oldestOnPage && oldestOnPage < from) break;
    if (!hasNext) break;
  }

  if (upserts.length) {
    const BATCH = 200;
    for (let i = 0; i < upserts.length; i += BATCH) {
      await PaymobReceived.bulkWrite(upserts.slice(i, i + BATCH), { ordered: false });
    }
  }

  logger.info({ amount, count, pages, from, to }, 'Paymob transactions sync complete');
  return { amount, count, source: 'paymob_api', pages };
}

/**
 * Sync Paymob into the ledger for a range, then return the ledger aggregate
 * (source of truth for the dashboard after sync).
 */
export async function syncAndSumPaymobReceived({ from, to, maxPages = 80 } = {}) {
  if (!isPaymobApiConfigured()) {
    return { amount: 0, count: 0, source: 'unavailable', real: false };
  }

  try {
    await sumSuccessfulTransactions({ from, to, maxPages });
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
    source: 'paymob',
    real: true,
  };
}

export default {
  isPaymobApiConfigured,
  sumSuccessfulTransactions,
  syncAndSumPaymobReceived,
};
