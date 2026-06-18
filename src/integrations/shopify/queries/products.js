import { shopifyGraphQL } from '../client.js';

const PRODUCTS_QUERY = `
  query Products($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          status
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                inventoryItem { id }
                inventoryQuantity
              }
            }
          }
        }
      }
    }
  }
`;

export async function fetchAllProducts() {
  const products = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const data = await shopifyGraphQL(PRODUCTS_QUERY, { cursor });
    const connection = data.products;
    for (const edge of connection.edges) {
      products.push(edge.node);
    }
    hasNext = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  return products;
}

export default { fetchAllProducts };
