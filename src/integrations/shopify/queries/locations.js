import { shopifyGraphQL } from '../client.js';

const LOCATIONS_QUERY = `
  query Locations {
    locations(first: 20) {
      edges {
        node {
          id
          name
          isActive
          address {
            city
            country
          }
        }
      }
    }
  }
`;

export async function fetchLocations() {
  const data = await shopifyGraphQL(LOCATIONS_QUERY);
  return data.locations.edges.map(({ node }) => node);
}

export default { fetchLocations };
