import { gql, type StorefrontClient } from "@shopify/hydrogen";

import { rejectedVariantIds, type VariantVendorNode } from "~/lib/brand";

export const VARIANT_VENDOR_QUERY = gql(`
  query VariantVendors($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      id
      ... on ProductVariant {
        product {
          title
          vendor
        }
      }
    }
  }
`);

export type StoredBrandCart = {
  id: string;
  checkoutUrl?: string | null;
  lines: { nodes: { id: string; merchandise?: { product?: { vendor?: string | null } | null } | null }[] };
};

type StorefrontGraphql = Pick<StorefrontClient, "graphql">;

export async function findRejectedMerchandise(
  storefront: StorefrontGraphql,
  ids: readonly string[],
): Promise<{ id: string; title: string }[] | "unverified"> {
  if (ids.length === 0) return [];

  try {
    const result = await storefront.graphql(VARIANT_VENDOR_QUERY, {
      variables: { ids: [...ids] },
    });
    if (result.errors || !result.data) return "unverified";
    return rejectedVariantIds(ids, result.data.nodes as VariantVendorNode[]);
  } catch {
    return "unverified";
  }
}
