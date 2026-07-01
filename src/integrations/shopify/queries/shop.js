import { shopifyGraphQL } from '../client.js';

const SHOP_QUERY = `
  query ShopInfo {
    shop {
      name
      email
      myshopifyDomain
      currencyCode
      primaryDomain { url }
    }
  }
`;

export async function fetchShopInfo() {
  const data = await shopifyGraphQL(SHOP_QUERY);
  return data.shop;
}

export default { fetchShopInfo };
