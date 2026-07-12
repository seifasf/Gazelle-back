import { config } from '../../config/index.js';
import PaymobReceived from '../../models/PaymobReceived.js';

const ACCEPT_BASE = 'https://accept.paymob.com/api';

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
 * Sum successful Paymob Accept transactions in [from, to].
 * Newest-first pagination; stops once page ages past `from`.
 */
export async function sumSuccessfulTransactions({ from, to, maxPages = 40 } = {}) {
  const token = await getAuthToken();
  let url = `${ACCEPT_BASE}/acceptance/transactions?page=1`;
  let amount = 0;
  let count = 0;
  let pages = 0;
  const seen = new Set();

  while (url && pages < maxPages) {
    pages += 1;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data?.detail || data?.message || `Paymob transactions failed (${response.status})`);
      err.statusCode = response.status;
      throw err;
    }

    const results = data.results || [];
    let oldestOnPage = null;
    const upserts = [];

    for (const tx of results) {
      const created = new Date(tx.paid_at || tx.created_at || 0);
      if (Number.isNaN(created.getTime())) continue;
      if (!oldestOnPage || created < oldestOnPage) oldestOnPage = created;

      if (!tx.success || tx.pending || tx.is_voided || tx.is_refunded || tx.error_occured) continue;
      if (created < from || created > to) continue;

      const id = String(tx.id);
      if (seen.has(id)) continue;
      seen.add(id);

      const egp = Number(tx.amount_cents || 0) / 100;
      if (!(egp > 0)) continue;
      amount += egp;
      count += 1;

      upserts.push(
        PaymobReceived.updateOne(
          { externalId: id },
          {
            $setOnInsert: {
              externalId: id,
              amountEgp: egp,
              receivedAt: created,
            },
          },
          { upsert: true }
        )
      );
    }

    if (upserts.length) {
      await Promise.allSettled(upserts);
    }

    if (oldestOnPage && oldestOnPage < from) break;
    url = data.next || null;
  }

  return { amount, count, source: 'paymob_api', pages };
}

export default { isPaymobApiConfigured, sumSuccessfulTransactions };
