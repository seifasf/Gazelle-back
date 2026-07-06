import { shopifyGraphQL } from '../client.js';

const PRODUCTS_QUERY = `
  query Products($cursor: String) {
    products(first: 8, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          tags
          status
          options {
            id
            name
            position
            values
          }
          featuredImage {
            url
            altText
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                barcode
                price
                compareAtPrice
                image {
                  url
                  altText
                }
                selectedOptions {
                  name
                  value
                }
                inventoryItem {
                  id
                }
                inventoryQuantity
              }
            }
          }
        }
      }
    }
  }
`;

function readAvailableQuantity(variantNode) {
  return variantNode.inventoryQuantity ?? 0;
}

const COLOR_NAMES = ['color', 'colour', 'لون', 'اللون'];
const SIZE_NAMES = ['size', 'مقاس', 'المقاس', 'eu', 'us', 'uk'];

export function parseVariantOptions(selectedOptions = [], productOptions = []) {
  const result = { color: null, size: null };

  const optionNameByPosition = {};
  for (const opt of productOptions) {
    optionNameByPosition[opt.position] = (opt.name || '').toLowerCase();
  }

  for (const opt of selectedOptions) {
    const name = (opt.name || '').toLowerCase();
    const value = opt.value;
    if (!value) continue;

    if (COLOR_NAMES.some((c) => name.includes(c))) {
      result.color = value;
    } else if (SIZE_NAMES.some((s) => name.includes(s))) {
      result.size = value;
    } else if (!result.color && productOptions.length === 2) {
      const pos = productOptions.find((o) => o.name?.toLowerCase() === name)?.position;
      if (pos === 1) result.color = value;
      else if (pos === 2) result.size = value;
    }
  }

  if (!result.color && !result.size && selectedOptions.length >= 2) {
    result.color = selectedOptions[0].value;
    result.size = selectedOptions[1].value;
  } else if (!result.size && selectedOptions.length === 1 && !result.color) {
    result.size = selectedOptions[0].value;
  }

  return result;
}

export async function fetchAllProducts() {
  const products = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const data = await shopifyGraphQL(PRODUCTS_QUERY, { cursor });
    const connection = data.products;
    for (const edge of connection.edges) {
      const node = edge.node;
      node.featuredImageUrl = node.featuredImage?.url || null;
      node.tagsList = node.tags || [];
      node.variants.edges = node.variants.edges.map(({ node: variant }) => {
        const { color, size } = parseVariantOptions(variant.selectedOptions, node.options);
        return {
          node: {
            ...variant,
            resolvedColor: color,
            resolvedSize: size,
            resolvedImageUrl: variant.image?.url || node.featuredImage?.url || null,
            resolvedOnlineStock: readAvailableQuantity(variant),
            resolvedCompareAtPrice: variant.compareAtPrice
              ? parseFloat(variant.compareAtPrice)
              : null,
          },
        };
      });
      products.push(node);
    }
    hasNext = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  return products;
}

export default { fetchAllProducts, parseVariantOptions };
