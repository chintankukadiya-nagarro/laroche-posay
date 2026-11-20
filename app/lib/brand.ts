/**
 * Server-owned brand for this storefront.
 *
 * This repository is La Roche-Posay. The Kérastase repository should change
 * only this object:
 * - name: "Kérastase"
 * - vendor: "Kérastase" (exact Storefront API vendor)
 * - collectionHandle: "kerastase"
 * - themeId: "kerastase"
 *
 * Do not use the "kerastase-1" collection. It is a separate empty collection.
 * Never read the brand from a query parameter, form field, cookie, or any
 * other untrusted request input. Separate Storefront API tokens do not grant
 * brand-specific product permissions.
 */
export const brandConfig = {
  name: "La Roche-Posay",
  vendor: "La Roche-Posay",
  collectionHandle: "la-roche-posay",
  themeId: "la-roche-posay",
} as const;

export const allowedCollectionHandles = [brandConfig.collectionHandle] as const;

const BRAND_NOTICE_COOKIE = "brand_cart_notice";

export function isAllowedVendor(vendor: string | null | undefined): boolean {
  return vendor === brandConfig.vendor;
}

/** Cart lines may contain either approved brand. Browsing still uses `isAllowedVendor`. */
export function isSharedCartVendor(vendor: string | null | undefined): boolean {
  return vendor === "La Roche-Posay" || vendor === "Kérastase";
}

export function isAllowedCollectionHandle(handle: string | undefined): handle is string {
  return handle != null && allowedCollectionHandles.some((allowed) => allowed === handle);
}

export function emptyCatalogMessage(): string {
  return `No published ${brandConfig.name} products are available on this storefront yet.`;
}

/** Shopper-facing search text with Storefront search operators removed. */
export function literalSearchTerm(input: string): string {
  return input
    .replace(/["']/g, " ")
    .replace(/\b(?:AND|OR|NOT)\b/gi, " ")
    .replace(/[\w.]+\s*:/g, " ")
    .replace(/[()*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type VendorScopedFilter = { productVendor?: string | null };

export function withBrandVendorFilter<T extends VendorScopedFilter>(filters: readonly T[]): T[] {
  const withoutVendor = filters.filter((filter) => filter.productVendor == null);
  return [...withoutVendor, { productVendor: brandConfig.vendor } as T];
}

export function hideVendorFacet<T extends { id?: string | null; label?: string | null }>(
  filters: readonly T[],
): T[] {
  return filters.filter((filter) => {
    const id = filter.id?.toLowerCase() ?? "";
    const label = filter.label?.toLowerCase() ?? "";
    return !id.includes("vendor") && label !== "vendor";
  });
}

type BrandProduct = { vendor?: string | null };
type BrandPageInfo = { hasNextPage: boolean; endCursor: string | null };

/**
 * Keeps a server-filtered page only when every product matches the brand.
 * A single mismatch means the query was not actually brand-scoped, so the
 * page is discarded instead of trimmed into a fake complete result.
 */
export function presentBrandCatalog<T extends BrandProduct>(
  products: readonly T[],
  pageInfo: BrandPageInfo,
  totalCount: number,
): { products: T[]; pageInfo: BrandPageInfo; totalCount: number } {
  if (products.some((product) => !isAllowedVendor(product.vendor))) {
    return {
      products: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      totalCount: 0,
    };
  }

  return { products: [...products], pageInfo, totalCount };
}

export type BrandCartLine = {
  id: string;
  merchandise?: {
    product?: { title?: string | null; vendor?: string | null } | null;
  } | null;
};

export function foreignCartLines(lines: readonly BrandCartLine[]): BrandCartLine[] {
  return lines.filter((line) => {
    const vendor = line.merchandise?.product?.vendor;
    return typeof vendor === "string" && !isSharedCartVendor(vendor);
  });
}

/** Confirmed wrong vendor only. Missing vendor is an optimistic line, not proof. */
export function cartHasConfirmedForeignVendor(
  lines: readonly {
    merchandise?: { product?: { vendor?: string | null } | null } | null;
  }[],
): boolean {
  return lines.some((line) => {
    const vendor = line.merchandise?.product?.vendor;
    return typeof vendor === "string" && !isSharedCartVendor(vendor);
  });
}

export function shopifyCheckoutUrl(
  checkoutUrl: string | null | undefined,
  blocked: boolean,
): string | null {
  if (blocked || !checkoutUrl) return null;
  return checkoutUrl;
}

export function removedLinesMessage(titles: readonly string[]): string {
  const label = titles.length === 1 ? "item" : "items";
  const verb = titles.length === 1 ? "is" : "are";
  return `Removed ${titles.length} ${label} that ${verb} not ${brandConfig.name}: ${titles.join(", ")}. Checkout only includes ${brandConfig.name} products.`;
}

export function rejectedMerchandiseMessage(title: string): string {
  return `${title} is not sold by ${brandConfig.name}. It was not added to your cart.`;
}

export function unverifiedMerchandiseMessage(): string {
  return `This product could not be verified as ${brandConfig.name}. It was not added to your cart.`;
}

type CartLineRef = { id?: string; merchandiseId?: string; vendor?: string };

export function merchandiseIdsToVerify(action: {
  intent: string;
  lines?: readonly CartLineRef[];
}): string[] {
  if (action.intent !== "add" && action.intent !== "update") return [];
  return (action.lines ?? []).flatMap((line) => (line.merchandiseId ? [line.merchandiseId] : []));
}

export function foreignLineIdsTargetedByUpdate(
  action: { intent: string; lines?: readonly { id?: string }[] },
  lines: readonly BrandCartLine[],
): string[] {
  if (action.intent !== "update") return [];
  const foreign = new Set(foreignCartLines(lines).map((line) => line.id));
  return (action.lines ?? []).flatMap((line) => (line.id && foreign.has(line.id) ? [line.id] : []));
}

export type VariantVendorNode = {
  __typename?: string;
  id?: string;
  product?: { title?: string | null; vendor?: string | null } | null;
} | null;

export function rejectedVariantIds(
  requestedIds: readonly string[],
  nodes: readonly VariantVendorNode[],
): { id: string; title: string }[] {
  const byId = new Map<string, VariantVendorNode>();
  for (const node of nodes) {
    if (node?.id) byId.set(node.id, node);
  }

  return requestedIds.flatMap((id) => {
    const node = byId.get(id);
    if (node?.__typename === "ProductVariant" && isAllowedVendor(node.product?.vendor)) return [];
    return [{ id, title: node?.product?.title?.trim() || "This product" }];
  });
}

const STOREFRONT_PROXY = /^\/api\/(?:unstable|\d{4}-\d{2})\/graphql\.json$/;
const CART_PERMALINK = /^\/cart\/(\d+:\d+(?:,\d+:\d+)*)$/;
const UNSCOPED_CART_PROXY =
  /^\/cart(?:\.(?:js|json)|\/(?:add|update|change|clear)(?:\.(?:js|json))?)$/i;

export function variantGidsFromCartPermalink(pathname: string): string[] | null {
  const match = CART_PERMALINK.exec(pathname);
  if (!match?.[1]) return null;
  return match[1].split(",").map((pair) => `gid://shopify/ProductVariant/${pair.split(":")[0]}`);
}

export function isUnscopedCartProxy(pathname: string): boolean {
  return UNSCOPED_CART_PROXY.test(pathname);
}

/** Arbitrary Storefront queries cannot be pinned to the brand vendor. */
export function isUnscopedStorefrontProxy(pathname: string): boolean {
  return STOREFRONT_PROXY.test(pathname);
}

export function isBuyPermalink(pathname: string): boolean {
  return pathname.startsWith("/buy/");
}

export function readBrandNotices(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const pair = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${BRAND_NOTICE_COOKIE}=`));
  if (!pair) return [];

  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(pair.slice(BRAND_NOTICE_COOKIE.length + 1)));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  } catch {
    return [];
  }
}

export function serializeBrandNotices(messages: readonly string[], secure: boolean): string {
  const value = encodeURIComponent(JSON.stringify(messages.slice(0, 5)));
  const secureAttr = secure ? "; Secure" : "";
  return `${BRAND_NOTICE_COOKIE}=${value}; Path=/; Max-Age=120; HttpOnly; SameSite=Lax${secureAttr}`;
}

export function clearBrandNoticesCookie(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${BRAND_NOTICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureAttr}`;
}
