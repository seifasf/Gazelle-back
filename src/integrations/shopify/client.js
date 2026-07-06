import { GraphQLClient } from 'graphql-request';
import logger from '../../utils/logger.js';
import { getShopifyCredentials, getValidAccessToken } from './credentials.js';

export function resetShopifyClient() {
  // Tokens are resolved per request via getValidAccessToken(), so there is no
  // cached client/token to clear. Kept for backwards compatibility.
}

export async function getShopifyClient() {
  const creds = await getShopifyCredentials();
  const token = await getValidAccessToken();
  if (!creds.shopDomain || !token) {
    throw new Error('Shopify credentials not configured');
  }

  const url = `https://${creds.shopDomain}/admin/api/${creds.apiVersion}/graphql.json`;
  return new GraphQLClient(url, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  });
}

function isThrottled(error) {
  const errors = error?.response?.errors;
  return Array.isArray(errors) && errors.some((e) => e?.extensions?.code === 'THROTTLED');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function shopifyGraphQL(query, variables = {}, { maxRetries = 6 } = {}) {
  const gql = await getShopifyClient();
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await gql.request(query, variables);
    } catch (error) {
      if (isThrottled(error) && attempt < maxRetries) {
        attempt += 1;
        const wait = Math.min(2000 * attempt, 8000);
        logger.warn({ attempt, wait }, 'Shopify GraphQL throttled — backing off');
        await sleep(wait);
        continue;
      }
      logger.error({ err: error, query: query.slice(0, 80) }, 'Shopify GraphQL error');
      throw error;
    }
  }
}

export async function shopifyRest(path, { method = 'GET', body, returnHeaders = false } = {}) {
  const creds = await getShopifyCredentials();
  const token = await getValidAccessToken();
  if (!creds.shopDomain || !token) {
    throw new Error('Shopify credentials not configured');
  }

  // Allow callers to pass either a relative path or an absolute Shopify URL (used for pagination cursors).
  const url = path.startsWith('http')
    ? path
    : `https://${creds.shopDomain}/admin/api/${creds.apiVersion}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': token,
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
    const err = new Error(data.errors || data.error || `Shopify REST error: ${response.status}`);
    err.statusCode = response.status;
    throw err;
  }

  if (returnHeaders) return { data, headers: response.headers };
  return data;
}

/** Extract the rel="next" cursor URL from a Shopify Link header, if present. */
function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetch every page of a paginated Shopify REST collection using cursor-based
 * (Link header) pagination. `firstPath` should include any filters + limit=250.
 * After the first request only the page_info cursor is honored by Shopify.
 */
export async function shopifyRestPaginated(firstPath, collectionKey, { maxItems = Infinity, onPage } = {}) {
  const items = [];
  let nextUrl = firstPath;

  while (nextUrl) {
    const { data, headers } = await shopifyRest(nextUrl, { returnHeaders: true });
    const pageItems = data[collectionKey] || [];
    items.push(...pageItems);
    if (typeof onPage === 'function') await onPage(pageItems);
    if (items.length >= maxItems) break;
    nextUrl = parseNextLink(headers.get('link'));
  }

  return items;
}

export { isShopifyConfigured } from './credentials.js';
