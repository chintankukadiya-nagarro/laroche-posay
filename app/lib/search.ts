import { gql, parseCollectionParams, type StorefrontApi } from "@shopify/hydrogen";
import type { StorefrontClient } from "@shopify/hydrogen";
import type { ProductFilter as StorefrontApiProductFilter } from "@shopify/hydrogen/storefront-api-types";

import { PRODUCT_CARD_FRAGMENT } from "~/components/ProductCard";
import { hideVendorFacet, literalSearchTerm, presentBrandCatalog, withBrandVendorFilter } from "~/lib/brand";

export const SEARCH_PAGE_SIZE = 9;

export const SEARCH_QUERY = gql(
  `
    query SearchPage(
      $term: String!
      $first: Int!
      $after: String
      $sortKey: SearchSortKeys
      $reverse: Boolean
      $productFilters: [ProductFilter!]
    ) {
      shop {
        paymentSettings {
          currencyCode
        }
      }
      search(
        query: $term
        types: [PRODUCT]
        first: $first
        after: $after
        sortKey: $sortKey
        reverse: $reverse
        prefix: LAST
        productFilters: $productFilters
      ) {
        totalCount
        productFilters {
          id
          label
          type
          presentation
          values {
            id
            label
            count
            input
            swatch {
              color
              image {
                previewImage {
                  url
                  altText
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on Product {
            ...ProductCard
          }
        }
      }
    }
  `,
  [PRODUCT_CARD_FRAGMENT],
);

type SearchQueryResult = StorefrontApi.ResultOf<typeof SEARCH_QUERY>;
type SearchQueryVariables = StorefrontApi.VariablesOf<typeof SEARCH_QUERY>;
type SearchNode = SearchQueryResult["search"]["nodes"][number];
type SearchProductNode = Extract<SearchNode, { __typename: "Product" }>;
type SearchFilters = SearchQueryResult["search"]["productFilters"];
type SearchPageInfo = SearchQueryResult["search"]["pageInfo"];
type SearchCurrencyCode = SearchQueryResult["shop"]["paymentSettings"]["currencyCode"];

type SearchPageEmptyData = {
  performed: false;
  searchTerm: string;
  products: [];
  availableFilters: [];
  pageInfo: { hasNextPage: false; endCursor: null };
  currencyCode: null;
  totalCount: 0;
  dataSearch: string;
  origin: string;
};

type SearchPagePerformedData = {
  performed: true;
  searchTerm: string;
  products: SearchProductNode[];
  availableFilters: SearchFilters;
  pageInfo: SearchPageInfo;
  currencyCode: SearchCurrencyCode;
  totalCount: number;
  dataSearch: string;
  origin: string;
};

export type SearchPageData = SearchPageEmptyData | SearchPagePerformedData;

export async function loadSearchPage({
  storefrontClient,
  request,
}: {
  storefrontClient: StorefrontClient;
  request: Request;
}): Promise<SearchPageData> {
  const url = new URL(request.url);
  const searchTerm = (url.searchParams.get("q") ?? "").trim();
  const empty: SearchPageData = {
    performed: false,
    searchTerm,
    products: [],
    availableFilters: [],
    pageInfo: { hasNextPage: false, endCursor: null },
    currencyCode: null,
    totalCount: 0,
    dataSearch: url.searchParams.toString(),
    origin: url.origin,
  };

  // Operators are stripped before the query. A term that is only search syntax
  // never reaches the API, and the vendor filter below is not taken from it.
  const term = literalSearchTerm(searchTerm);
  if (!searchTerm || !term) return empty;

  const browse = parseCollectionParams(url.searchParams);
  const after = url.searchParams.get("after") || undefined;
  const sortKey = browse.sortKey === "PRICE" ? "PRICE" : "RELEVANCE";

  const variables: SearchQueryVariables = {
    term,
    first: SEARCH_PAGE_SIZE,
    after,
    productFilters: withBrandVendorFilter(browse.filters as StorefrontApiProductFilter[]),
    sortKey,
    reverse: sortKey === "PRICE" ? browse.reverse || undefined : undefined,
  };

  const { data } = await storefrontClient.graphql(SEARCH_QUERY, { variables });

  if (!data?.search) throw new Response("Search unavailable", { status: 502 });

  const products = data.search.nodes.filter(
    (node): node is SearchProductNode => node.__typename === "Product",
  );
  const scoped = presentBrandCatalog(products, data.search.pageInfo, data.search.totalCount);

  return {
    performed: true,
    searchTerm,
    products: scoped.products,
    availableFilters: hideVendorFacet(data.search.productFilters),
    pageInfo: scoped.pageInfo,
    currencyCode: data.shop.paymentSettings.currencyCode,
    totalCount: scoped.totalCount,
    dataSearch: url.searchParams.toString(),
    origin: url.origin,
  };
}
