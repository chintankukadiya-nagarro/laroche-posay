import { cartQueries, gql, type StorefrontClient } from "@shopify/hydrogen";

import {
  brandConfig,
  foreignCartLines,
  rejectedVariantIds,
  removedLinesMessage,
  type BrandCartLine,
  type VariantVendorNode,
} from "~/lib/brand";

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
  lines: { nodes: BrandCartLine[] };
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

export function removalFailureMessage(): string {
  return `Some items are not ${brandConfig.name} and could not be removed. Checkout is unavailable until the cart only contains ${brandConfig.name} products.`;
}

export async function stripForeignLines<T extends StoredBrandCart>(
  storefront: StorefrontGraphql,
  cart: T,
): Promise<{ cart: T; notices: string[]; status: "clean" | "removed" | "failed" }> {
  const foreign = foreignCartLines(cart.lines.nodes);
  if (foreign.length === 0) return { cart, notices: [], status: "clean" };

  const titles = foreign.map((line) => line.merchandise?.product?.title?.trim() || "Item");

  try {
    const result = await storefront.graphql(cartQueries.cartLinesRemove, {
      variables: { cartId: cart.id, lineIds: foreign.map((line) => line.id) },
    });
    const payload = result.data?.cartLinesRemove;
    if (result.errors || !payload || payload.userErrors.length > 0 || !payload.cart) {
      return { cart: withoutCheckout(cart), notices: [removalFailureMessage()], status: "failed" };
    }

    const next = payload.cart as unknown as T;
    if (foreignCartLines(next.lines?.nodes ?? []).length > 0) {
      return { cart: withoutCheckout(next), notices: [removalFailureMessage()], status: "failed" };
    }

    return { cart: next, notices: [removedLinesMessage(titles)], status: "removed" };
  } catch {
    return { cart: withoutCheckout(cart), notices: [removalFailureMessage()], status: "failed" };
  }
}

function withoutCheckout<T extends StoredBrandCart>(cart: T): T {
  return { ...cart, checkoutUrl: null };
}
