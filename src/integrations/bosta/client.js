import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

const DEFAULT_BASE = 'https://app.bosta.co/api/v2';

export function isBostaConfigured() {
  return Boolean(config.BOSTA_API_KEY);
}

export async function bostaRequest(path, { method = 'GET', body, query } = {}) {
  if (!config.BOSTA_API_KEY) {
    throw new Error('Bosta API key not configured');
  }

  const base = config.BOSTA_API_BASE_URL || DEFAULT_BASE;
  let url = `${base}${path}`;
  if (query && typeof query === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else {
        params.set(key, String(value));
      }
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: config.BOSTA_API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    logger.error({ status: response.status, data, path }, 'Bosta API error');
    const err = new Error(data.message || `Bosta API error: ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }

  return data;
}

export default { bostaRequest, isBostaConfigured };
