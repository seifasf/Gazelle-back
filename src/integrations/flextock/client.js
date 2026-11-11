import { config } from '../../config/index.js';
import Settings from '../../models/Settings.js';
import logger from '../../utils/logger.js';
import { maskSecret } from '../shopify/credentials.js';

const DEFAULT_BASE = 'https://api.flextock.com';

let cachedAccess = null;
let cachedRefresh = null;
let cachedExpMs = 0;
/** @type {{ username: string, password: string, key: string } | null} */
let cachedCreds = null;
let cachedCredsAt = 0;

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

function envCredentials() {
  return {
    username: cleanFlextockSecret(config.FLEXTOCK_USERNAME),
    password: cleanFlextockSecret(config.FLEXTOCK_PASSWORD),
    key: cleanFlextockSecret(config.FLEXTOCK_API_KEY),
  };
}

/**
 * Settings DB overrides env when a field is set (same pattern as Shopify tokens).
 * Lets staff fix Flextock login from OMS Settings without a Render redeploy.
 */
export async function loadFlextockCredentials({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedCreds && now - cachedCredsAt < 30_000) {
    return cachedCreds;
  }
  const env = envCredentials();
  let fromDb = { username: '', password: '', key: '' };
  try {
    const settings = await Settings.findOne({ key: 'global' })
      .select('flextockUsername flextockPassword flextockApiKey')
      .lean();
    fromDb = {
      username: cleanFlextockSecret(settings?.flextockUsername),
      password: cleanFlextockSecret(settings?.flextockPassword),
      key: cleanFlextockSecret(settings?.flextockApiKey),
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'Flextock credentials: Settings read failed — using env only');
  }
  cachedCreds = {
    username: fromDb.username || env.username,
    password: fromDb.password || env.password,
    key: fromDb.key || env.key,
  };
  cachedCredsAt = now;
  return cachedCreds;
}

/** Sync helper for tests / boot — env + in-memory cache only. */
export function flextockCredentials() {
  if (cachedCreds) return cachedCreds;
  return envCredentials();
}

export async function isFlextockConfigured() {
  const { username, password, key } = await loadFlextockCredentials();
  return Boolean(username && password && key);
}

/** Sync: true if env or cached Settings creds are complete. */
export function isFlextockConfiguredSync() {
  const { username, password, key } = flextockCredentials();
  return Boolean(username && password && key);
}

export function resetFlextockAuthCache() {
  cachedAccess = null;
  cachedRefresh = null;
  cachedExpMs = 0;
}

export function resetFlextockCredentialCache() {
  cachedCreds = null;
  cachedCredsAt = 0;
  resetFlextockAuthCache();
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

async function assertConfigured() {
  if (!(await isFlextockConfigured())) {
    const err = new Error(
      'Flextock API is not configured yet. Add merchant username, password, and API key in Settings → Flextock (or Render FLEXTOCK_*), then retry.'
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

function authFailureError(data, status, username) {
  const raw = errorMessage(data, status);
  const lower = String(raw || '').toLowerCase();
  const badCreds =
    lower.includes('no active account')
    || lower.includes('credentials')
    || lower.includes('missing data')
    || status === 401
    || status === 403;
  const who = username ? ` (tried username ${maskSecret(username)})` : '';
  const err = new Error(
    badCreds
      ? `Flextock login failed (${raw})${who}. Open Settings → Flextock and enter the merchant username, password, and API key from Flextock (same values as their portal login + API key). Do not use quotes or spaces.`
      : raw
  );
  // Never forward Flextock 401/403 — the OMS frontend treats bare 401 as session expiry.
  err.statusCode = 502;
  err.upstreamStatus = status;
  err.payload = data;
  return err;
}

/** Map third-party HTTP codes so they never look like Gazelle JWT failures. */
function mapUpstreamStatus(status) {
  if (status === 401 || status === 403) return 502;
  if (status >= 400 && status < 600) return status;
  return 502;
}

export async function authenticateFlextock({ force = false } = {}) {
  await assertConfigured();
  const now = Date.now();
  if (!force && cachedAccess && cachedExpMs - 30_000 > now) {
    return { access: cachedAccess, refresh: cachedRefresh };
  }

  const { username, password, key } = await loadFlextockCredentials({ force: true });
  const url = `${apiBase()}/base/auth/`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, key }),
  });
  const data = await parseBody(response);
  if (!response.ok) {
    logger.error(
      { status: response.status, data, path: '/base/auth/', username: maskSecret(username) },
      'Flextock auth error'
    );
    resetFlextockAuthCache();
    throw authFailureError(data, response.status, username);
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
  const { username, password, key } = await loadFlextockCredentials({ force: true });
  const configured = Boolean(username && password && key);
  if (!configured) {
    return {
      ok: false,
      configured: false,
      error:
        'Missing Flextock username, password, or API key. Save them in Settings → Flextock (or set FLEXTOCK_* on Render).',
      username: null,
      usernameMasked: null,
    };
  }
  try {
    resetFlextockAuthCache();
    await authenticateFlextock({ force: true });
    return {
      ok: true,
      configured: true,
      username,
      usernameMasked: maskSecret(username),
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      username,
      usernameMasked: maskSecret(username),
      error: err.message,
      statusCode: err.statusCode || null,
    };
  }
}

/**
 * Authenticated call to api.flextock.com. Retries once after a 401 by re-authing.
 */
export async function flextockRequest(path, { method = 'POST', body, query, quiet = false } = {}) {
  await assertConfigured();
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
    const raw = errorMessage(data, response.status);
    const err = new Error(
      response.status === 401 || response.status === 403
        ? `Flextock API rejected the request (${raw}). Check Flextock credentials in Settings.`
        : raw
    );
    err.statusCode = mapUpstreamStatus(response.status);
    err.upstreamStatus = response.status;
    err.payload = data;
    throw err;
  }

  return data;
}

export default {
  flextockRequest,
  isFlextockConfigured,
  isFlextockConfiguredSync,
  authenticateFlextock,
  resetFlextockAuthCache,
  resetFlextockCredentialCache,
  testFlextockConnection,
  cleanFlextockSecret,
  flextockCredentials,
  loadFlextockCredentials,
};
