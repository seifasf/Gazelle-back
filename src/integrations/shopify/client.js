import { GraphQLClient } from 'graphql-request';
import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

let client = null;

export function getShopifyClient() {
  if (!config.SHOPIFY_SHOP_DOMAIN || !config.SHOPIFY_ACCESS_TOKEN) {
    throw new Error('Shopify credentials not configured');
  }
  if (!client) {
    const url = `https://${config.SHOPIFY_SHOP_DOMAIN}/admin/api/${config.SHOPIFY_API_VERSION}/graphql.json`;
    client = new GraphQLClient(url, {
      headers: {
        'X-Shopify-Access-Token': config.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });
  }
  return client;
}

export async function shopifyGraphQL(query, variables = {}) {
  const gql = getShopifyClient();
  try {
    return await gql.request(query, variables);
  } catch (error) {
    logger.error({ err: error, query: query.slice(0, 80) }, 'Shopify GraphQL error');
    throw error;
  }
}

export function isShopifyConfigured() {
  return Boolean(config.SHOPIFY_SHOP_DOMAIN && config.SHOPIFY_ACCESS_TOKEN);
}
