import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

const DEFAULT_BASE = 'https://api.flextock.com';

let cachedAccess = null;
let cachedRefresh = null;
let cachedExpMs = 0;

export function isFlextockConfigured() {
  return Boolean(
    config.FLEXTOCK_USERNAME && config.FLEXTOCK_PASSWORD && config.FLEXTOCK_API_KEY
  );
}

export function resetFlextockAuthCache() {
  cachedAccess = null;
  cachedRefresh = null;
  cachedExpMs = 0;
}

function apiBase() {
  return String(config.FLEXTOCK_API_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

function jwtExpMs(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload?.exp) return 0;
    return Number(payload.exp) * 1000;
  } catch {
    return 0;
  }
}

function assertConfigured() {
  if (!isFlextockConfigured()) {
    const err = new Error(
      'Flextock API is not configured yet. Add FLEXTOCK_USERNAME, FLEXTOCK_PASSWORD, and FLEXTOCK_API_KEY, then retry.'
    );
    err.statusCode = 503;
    throw err;
  }
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function errorMessage(data, status) {
  if (!data || typeof data !== 'object') return `Flextock API error: ${status}`;
  return (
    data.message
    || data.detail
    || data.error
    || (typeof data.raw === 'string' && data.raw.slice(0, 240))
    || `Flextock API error: ${status}`
  );
}

export async function authenticateFlextock({ force = false } = {}) {
  assertConfigured();
  const now = Date.now();
  if (!force && cachedAccess && cachedExpMs - 30_000 > now) {
    return { access: cachedAccess, refresh: cachedRefresh };
  }

  const url = `${apiBase()}/base/auth/`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: config.FLEXTOCK_USERNAME,
      password: config.FLEXTOCK_PASSWORD,
      key: config.FLEXTOCK_API_KEY,
    }),
  });
  const data = await parseBody(response);
  if (!response.ok) {
    logger.error({ status: response.status, data, path: '/base/auth/' }, 'Flextock auth error');
    const err = new Error(errorMessage(data, response.status));
    err.statusCode = response.status;
    throw err;
  }

  const access = data.access || data.access_token;
  if (!access) {
    const err = new Error('Flextock auth did not return an access token');
    err.statusCode = 502;
    throw err;
  }
  cachedAccess = access;
  cachedRefresh = data.refresh || data.refresh_token || null;
  cachedExpMs = jwtExpMs(access) || now + 50 * 60 * 1000;
  return { access: cachedAccess, refresh: cachedRefresh };
}

/**
 * Authenticated call to api.flextock.com. Retries once after a 401 by re-authing.
 */
export async function flextockRequest(path, { method = 'POST', body, query, quiet = false } = {}) {
  assertConfigured();
  const { access } = await authenticateFlextock();

  let url = `${apiBase()}${path.startsWith('/') ? path : `/${path}`}`;
  if (query && typeof query === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const run = async (token) => {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await parseBody(response);
    return { response, data };
  };

  let { response, data } = await run(access);
  if (response.status === 401) {
    resetFlextockAuthCache();
    const next = await authenticateFlextock({ force: true });
    ({ response, data } = await run(next.access));
  }

  if (!response.ok) {
    if (!quiet) {
      logger.error({ status: response.status, data, path }, 'Flextock API error');
    }
    const err = new Error(errorMessage(data, response.status));
    err.statusCode = response.status;
    err.payload = data;
    throw err;
  }

  return data;
}

export default { flextockRequest, isFlextockConfigured, authenticateFlextock, resetFlextockAuthCache };
