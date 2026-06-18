import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

const DEFAULT_BASE = 'https://app.bosta.co/api/v2';

export function isBostaConfigured() {
  return Boolean(config.BOSTA_API_KEY);
}

export async function bostaRequest(path, { method = 'GET', body } = {}) {
  if (!config.BOSTA_API_KEY) {
    throw new Error('Bosta API key not configured');
  }

  const base = config.BOSTA_API_BASE_URL || DEFAULT_BASE;
  const url = `${base}${path}`;

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
