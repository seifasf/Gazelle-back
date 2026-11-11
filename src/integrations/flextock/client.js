import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

const DEFAULT_BASE = 'https://api.flextock.com';

let cachedAccess = null;
let cachedRefresh = null;
let cachedExpMs = 0;

/** Strip whitespace / wrapping quotes common when pasting into Render env UI. */
export function cleanFlextockSecret(value) {
  let s = String(value ?? '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"'))
    || (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function flextockCredentials() {
  return {
    username: cleanFlextockSecret(config.FLEXTOCK_USERNAME),
    password: cleanFlextockSecret(config.FLEXTOCK_PASSWORD),
    key: cleanFlextockSecret(config.FLEXTOCK_API_KEY),
  };
}

export function isFlextockConfigured() {
  const { username, password, key } = flextockCredentials();
  return Boolean(username && password && key);
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
      'Flextock API is not configured yet. Add FLEXTOCK_USERNAME, FLEXTOCK_PASSWORD, and FLEXTOCK_API_KEY on Render, then retry.'
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

function authFailureError(data, status) {
  const raw = errorMessage(data, status);
  const lower = String(raw || '').toLowerCase();
  const badCreds =
    lower.includes('no active account')
    || lower.includes('credentials')
    || lower.includes('missing data')
    || status === 401
    || status === 403;
  const err = new Error(
    badCreds
      ? `Flextock login failed (${raw}). Check Render env FLEXTOCK_USERNAME, FLEXTOCK_PASSWORD, and FLEXTOCK_API_KEY — they must be the merchant username, password, and API key from Flextock (no extra quotes/spaces).`
      : raw
  );
  err.statusCode = status >= 400 && status < 600 ? status : 502;
  err.payload = data;
  return err;
}

export async function authenticateFlextock({ force = false } = {}) {
  assertConfigured();
  const now = Date.now();
  if (!force && cachedAccess && cachedExpMs - 30_000 > now) {
    return { access: cachedAccess, refresh: cachedRefresh };
  }

  const { username, password, key } = flextockCredentials();
  const url = `${apiBase()}/base/auth/`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, key }),
  });
  const data = await parseBody(response);
  if (!response.ok) {
    logger.error(
      { status: response.status, data, path: '/base/auth/', username },
      'Flextock auth error'
    );
    resetFlextockAuthCache();
    throw authFailureError(data, response.status);
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
 * Live probe used by Settings / health. Does not throw for expected auth failures.
 */
export async function testFlextockConnection() {
  const { username, password, key } = flextockCredentials();
  const configured = Boolean(username && password && key);
  if (!configured) {
    return {
      ok: false,
      configured: false,
      error:
        'Missing FLEXTOCK_USERNAME, FLEXTOCK_PASSWORD, or FLEXTOCK_API_KEY on the server.',
      username: null,
    };
  }
  try {
    resetFlextockAuthCache();
    await authenticateFlextock({ force: true });
    return {
      ok: true,
      configured: true,
      username,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      username,
      error: err.message,
      statusCode: err.statusCode || null,
    };
  }
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

export default {
  flextockRequest,
  isFlextockConfigured,
  authenticateFlextock,
  resetFlextockAuthCache,
  testFlextockConnection,
  cleanFlextockSecret,
  flextockCredentials,
};
