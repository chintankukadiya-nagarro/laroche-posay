import { createShopifyRouteHandler, gql } from "@shopify/hydrogen";

import { brandConfig, literalSearchTerm, presentBrandCatalog } from "~/lib/brand";

const SUGGESTION_LIMIT = 5;

export const BRAND_SUGGESTION_QUERY = gql(`
  query BrandSuggestions(
    $term: String!
    $vendor: String!
    $first: Int!
    $country: CountryCode
    $language: LanguageCode
  ) @inContext(country: $country, language: $language) {
    search(
      query: $term
      types: [PRODUCT]
      first: $first
      prefix: LAST
      unavailableProducts: HIDE
      productFilters: [{ productVendor: $vendor }]
    ) {
      nodes {
        __typename
        ... on Product {
          id
          title
          handle
          vendor
          trackingParameters
          selectedOrFirstAvailableVariant(
            selectedOptions: []
            ignoreUnknownOptions: true
            caseInsensitiveMatch: true
          ) {
            id
            image {
              url
              altText
              width
              height
            }
            price {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`);

function emptySuggestions(term: string) {
  return {
    term,
    total: 0,
    items: {
      products: [],
      collections: [],
      pages: [],
      articles: [],
      queries: [],
    },
  };
}

/**
 * Suggestions use the Storefront `search` query, which accepts a vendor
 * filter. Predictive search does not, so this demo does not call it.
 * Request parameters cannot change the vendor or the result types.
 */
export const predictiveSearchHandlers = {
  get: createShopifyRouteHandler("/api/predictive-search", "GET", async ({ request, storefrontClient }) => {
    const rawTerm = new URL(request.url).searchParams.get("q") ?? "";
    const term = literalSearchTerm(rawTerm);
    if (!term) {
      return { type: "json" as const, data: emptySuggestions(rawTerm.trim()) };
    }

    const result = await storefrontClient.graphql(BRAND_SUGGESTION_QUERY, {
      variables: { term, vendor: brandConfig.vendor, first: SUGGESTION_LIMIT },
    });
    if (result.errors || !result.data?.search) {
      return {
        type: "error" as const,
        status: 400,
        error: {
          code: "invalid_predictive_search_request",
          message: "Suggestions are unavailable right now.",
        },
      };
    }

    const products = result.data.search.nodes.flatMap((node) =>
      node.__typename === "Product" ? [node] : [],
    );
    const scoped = presentBrandCatalog(products, { hasNextPage: false, endCursor: null }, products.length);

    return {
      type: "json" as const,
      data: {
        term: rawTerm.trim(),
        total: scoped.products.length,
        items: {
          products: scoped.products,
          collections: [],
          pages: [],
          articles: [],
          queries: [],
        },
      },
    };
  }),
};
