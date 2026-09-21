/**
 * Collect / CRP lines must be SKUs the customer already has on the linked prior order.
 * Operators sometimes change "collect size" to the new size by mistake — reject that.
 */

function priorLineKeyParts(pi) {
  return {
    vid: String(pi.variantId?._id || pi.variantId || ''),
    sku: String(pi.sku || '').toUpperCase(),
    qty: Number(pi.quantity) || 0,
    unit: Number(pi.unitSellingPrice) || 0,
    title: pi.title,
    color: pi.color,
    size: pi.size,
    variantId: pi.variantId?._id || pi.variantId,
  };
}

/** GBMB-405-44 ? GBMB-405 (size is trailing numeric segment). */
export function skuFamily(sku) {
  return String(sku || '')
    .toUpperCase()
    .replace(/-\d+$/, '');
}

function buildPriorPools(priorOrder) {
  const remainingByVid = new Map();
  const remainingBySku = new Map();
  const lines = [];
  for (const pi of priorOrder?.items || []) {
    const row = priorLineKeyParts(pi);
    if (row.vid) remainingByVid.set(row.vid, (remainingByVid.get(row.vid) || 0) + row.qty);
    if (row.sku) remainingBySku.set(row.sku, (remainingBySku.get(row.sku) || 0) + row.qty);
    lines.push({ ...row, remaining: row.qty });
  }
  return { remainingByVid, remainingBySku, lines };
}

function takeFromPools(pools, vid, sku, qty) {
  const { remainingByVid, remainingBySku } = pools;
  let pool = null;
  let key = null;
  if (vid && remainingByVid.has(vid) && (remainingByVid.get(vid) || 0) > 0) {
    pool = remainingByVid;
    key = vid;
  } else if (sku && remainingBySku.has(sku) && (remainingBySku.get(sku) || 0) > 0) {
    pool = remainingBySku;
    key = sku;
  }
  if (!pool) return false;
  const left = pool.get(key) || 0;
  if (qty > left) return false;
  pool.set(key, left - qty);
  if (pool === remainingByVid && sku && remainingBySku.has(sku)) {
    remainingBySku.set(sku, Math.max(0, (remainingBySku.get(sku) || 0) - qty));
  } else if (pool === remainingBySku && vid && remainingByVid.has(vid)) {
    remainingByVid.set(vid, Math.max(0, (remainingByVid.get(vid) || 0) - qty));
  }
  for (const line of pools.lines) {
    if ((vid && line.vid === vid) || (sku && line.sku === sku)) {
      if (line.remaining > 0) {
        line.remaining = Math.max(0, line.remaining - qty);
        break;
      }
    }
  }
  return true;
}

export function assertCollectFromPriorOrder(collectItems, priorOrder, { kind = 'exchange' } = {}) {
  const lines = Array.isArray(collectItems) ? collectItems : [];
  if (!lines.length) {
    const err = new Error(
      kind === 'return'
        ? 'Select the items to pick up from the original order'
        : 'Select what the courier must collect from the original order'
    );
    err.statusCode = 400;
    throw err;
  }

  const priorItems = priorOrder?.items || [];
  if (!priorItems.length) {
    const err = new Error('Original order has no items to collect against');
    err.statusCode = 400;
    throw err;
  }

  const pools = buildPriorPools(priorOrder);
  const priorLabel =
    priorOrder.shopifyOrderName || priorOrder.shopifyOrderId || String(priorOrder._id || '');

  for (const r of lines) {
    const qty = Number(r.quantity) || 0;
    if (qty < 1) continue;
    const vid = String(r.variantId?._id || r.variantId || '');
    const sku = String(r.sku || '').toUpperCase();

    if (!takeFromPools(pools, vid, sku, qty)) {
      const left =
        (vid && pools.remainingByVid.get(vid)) ||
        (sku && pools.remainingBySku.get(sku)) ||
        0;
      if (
        (vid && pools.remainingByVid.has(vid)) ||
        (sku && pools.remainingBySku.has(sku))
      ) {
        const err = new Error(
          `Collect qty for ${sku || vid} exceeds what is on original order ${priorLabel} ` +
            `(asked ${qty}, available ${left})`
        );
        err.statusCode = 400;
        throw err;
      }
      const err = new Error(
        `Collect item ${sku || vid || 'unknown'} is not on original order ${priorLabel}. ` +
          'Collect must be what the customer already has — only Deliver can change size.'
      );
      err.statusCode = 400;
      throw err;
    }
  }

  return true;
}

/**
 * If collect was saved as the *new* size by mistake, remap each bad line to the
 * matching product family still on the prior order (e.g. GBMB-405-43 ? GBMB-405-44).
 * Returns { items, changed, fixes }.
 */
export function healCollectToPriorOrder(collectItems, priorOrder) {
  const input = Array.isArray(collectItems) ? collectItems : [];
  if (!input.length || !priorOrder?.items?.length) {
    return { items: input, changed: false, fixes: [] };
  }

  const pools = buildPriorPools(priorOrder);
  const healed = [];
  const fixes = [];

  for (const r of input) {
    const qty = Math.max(1, Number(r.quantity) || 1);
    const vid = String(r.variantId?._id || r.variantId || '');
    const sku = String(r.sku || '').toUpperCase();

    const exact = pools.lines.find(
      (l) => l.remaining > 0 && ((vid && l.vid === vid) || (sku && l.sku === sku))
    );
    if (exact && takeFromPools(pools, exact.vid, exact.sku, qty)) {
      healed.push({
        variantId: exact.variantId,
        sku: exact.sku,
        quantity: qty,
        title: r.title || exact.title,
        color: r.color || exact.color,
        size: exact.size ?? r.size,
        unitSellingPrice:
          Number(r.unitSellingPrice) > 0 ? Number(r.unitSellingPrice) : exact.unit || 0,
      });
      continue;
    }

    const family = skuFamily(sku);
    const candidate = pools.lines.find(
      (l) => l.remaining > 0 && family && skuFamily(l.sku) === family
    );
    if (candidate && takeFromPools(pools, candidate.vid, candidate.sku, qty)) {
      fixes.push({ from: sku || vid, to: candidate.sku });
      healed.push({
        variantId: candidate.variantId,
        sku: candidate.sku,
        quantity: qty,
        title: candidate.title || r.title,
        color: candidate.color || r.color,
        size: candidate.size ?? r.size,
        unitSellingPrice: candidate.unit || Number(r.unitSellingPrice) || 0,
      });
      continue;
    }

    // Cannot heal — keep original so assert still fails loudly
    healed.push({
      variantId: r.variantId,
      sku: r.sku,
      quantity: qty,
      title: r.title,
      color: r.color,
      size: r.size,
      unitSellingPrice: Number(r.unitSellingPrice) || 0,
    });
  }

  return { items: healed, changed: fixes.length > 0, fixes };
}
