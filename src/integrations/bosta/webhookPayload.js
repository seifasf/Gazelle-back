/**
 * Normalize inbound Bosta webhook bodies into a flat delivery-shaped payload.
 * Bosta may send the delivery at the root, under `data`, or under `delivery`.
 */
export function normalizeBostaWebhookPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return { payload: {}, deliveryId: null, state: null, trackingNumber: null, businessReference: null };
  }

  const payload =
    raw.data && typeof raw.data === 'object' && (raw.data._id || raw.data.id || raw.data.trackingNumber || raw.data.state)
      ? raw.data
      : raw.delivery && typeof raw.delivery === 'object'
        ? raw.delivery
        : raw;

  const deliveryId =
    payload._id ??
    payload.deliveryId ??
    payload.delivery_id ??
    payload.id ??
    raw.deliveryId ??
    raw.delivery_id ??
    raw._id ??
    null;

  const state = payload.state ?? payload.status ?? raw.state ?? raw.status ?? null;

  const trackingNumber =
    payload.trackingNumber ??
    payload.tracking_number ??
    raw.trackingNumber ??
    raw.tracking_number ??
    null;

  const businessReference =
    payload.businessReference ??
    payload.business_reference ??
    raw.businessReference ??
    raw.business_reference ??
    null;

  // Doc fields: type, cod (Delivered only), timeStamp, exceptionCode, …
  const type = payload.type ?? raw.type ?? null;
  const cod = payload.cod ?? raw.cod ?? null;
  const timeStamp = payload.timeStamp ?? payload.timestamp ?? raw.timeStamp ?? raw.timestamp ?? null;
  const exceptionCode = payload.exceptionCode ?? payload.exception_code ?? raw.exceptionCode ?? null;
  const exceptionReason =
    payload.exceptionReason ?? payload.exception_reason ?? raw.exceptionReason ?? null;
  const numberOfAttempts =
    payload.numberOfAttempts ?? payload.number_of_attempts ?? raw.numberOfAttempts ?? null;
  const isConfirmedDelivery =
    payload.isConfirmedDelivery ?? payload.is_confirmed_delivery ?? raw.isConfirmedDelivery ?? null;

  // Keep identifiers on the payload so order matching stays consistent.
  const enriched = {
    ...payload,
    ...(deliveryId != null ? { _id: String(deliveryId) } : {}),
    ...(trackingNumber != null ? { trackingNumber } : {}),
    ...(businessReference != null ? { businessReference: String(businessReference) } : {}),
    ...(state != null ? { state } : {}),
    ...(type != null ? { type } : {}),
    ...(cod != null ? { cod } : {}),
    ...(timeStamp != null ? { timeStamp } : {}),
    ...(exceptionCode != null ? { exceptionCode } : {}),
    ...(exceptionReason != null ? { exceptionReason } : {}),
    ...(numberOfAttempts != null ? { numberOfAttempts } : {}),
    ...(isConfirmedDelivery != null ? { isConfirmedDelivery } : {}),
  };

  return {
    payload: enriched,
    deliveryId: deliveryId != null ? String(deliveryId) : null,
    state,
    trackingNumber: trackingNumber != null ? String(trackingNumber) : null,
    businessReference: businessReference != null ? String(businessReference) : null,
    type,
    timeStamp,
    exceptionCode,
  };
}

export function bostaWebhookExternalId({ deliveryId, state, trackingNumber }) {
  const stateKey =
    state && typeof state === 'object'
      ? state.code ?? state.value ?? state.name ?? state.state
      : state;
  const idPart = deliveryId || trackingNumber || 'unknown';
  return `${idPart}-${stateKey ?? Date.now()}`;
}

/** Public base URL for webhook callbacks (no trailing slash). */
export function appPublicBaseUrl(appUrl) {
  return String(appUrl || '').replace(/\/$/, '');
}

export function bostaWebhookUrl(appUrl) {
  return `${appPublicBaseUrl(appUrl)}/webhooks/bosta`;
}

export default {
  normalizeBostaWebhookPayload,
  bostaWebhookExternalId,
  appPublicBaseUrl,
  bostaWebhookUrl,
};
