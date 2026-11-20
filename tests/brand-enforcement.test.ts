import { describe, expect, it } from "vitest";

import {
  brandConfig,
  cartHasConfirmedForeignVendor,
  emptyCatalogMessage,
  foreignCartLines,
  foreignLineIdsTargetedByUpdate,
  hideVendorFacet,
  isAllowedCollectionHandle,
  isAllowedVendor,
  isBuyPermalink,
  isUnscopedCartProxy,
  isUnscopedStorefrontProxy,
  literalSearchTerm,
  merchandiseIdsToVerify,
  presentBrandCatalog,
  readBrandNotices,
  rejectedVariantIds,
  serializeBrandNotices,
  shopifyCheckoutUrl,
  variantGidsFromCartPermalink,
  withBrandVendorFilter,
} from "~/lib/brand";
import { formatPrice } from "~/lib/money";

const lrp = { vendor: "La Roche-Posay" };
const other = { vendor: "Kérastase" };

describe("brand catalog", () => {
  it("allows only the configured brand vendor and collection", () => {
    expect(brandConfig.vendor).toBe("La Roche-Posay");
    expect(brandConfig.collectionHandle).toBe("la-roche-posay");
    expect(isAllowedVendor("La Roche-Posay")).toBe(true);
    expect(isAllowedVendor("Kérastase")).toBe(false);
    expect(isAllowedVendor("la roche-posay")).toBe(false);
    expect(isAllowedVendor(null)).toBe(false);
    expect(isAllowedCollectionHandle("la-roche-posay")).toBe(true);
    expect(isAllowedCollectionHandle("kerastase")).toBe(false);
    expect(isAllowedCollectionHandle("kerastase-1")).toBe(false);
  });

  it("renders an allowed brand product and drops a page that leaks another brand", () => {
    const allowed = presentBrandCatalog([lrp], { hasNextPage: true, endCursor: "cursor" }, 4);
    expect(allowed.products).toEqual([lrp]);
    expect(allowed.pageInfo.hasNextPage).toBe(true);
    expect(allowed.totalCount).toBe(4);

    const leaked = presentBrandCatalog(
      [lrp, other],
      { hasNextPage: true, endCursor: "cursor" },
      20,
    );
    expect(leaked.products).toEqual([]);
    expect(leaked.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
    expect(leaked.totalCount).toBe(0);
  });

  it("renders an empty brand collection without substituting other products", () => {
    const empty = presentBrandCatalog([], { hasNextPage: false, endCursor: null }, 0);
    expect(empty.products).toEqual([]);
    expect(empty.totalCount).toBe(0);
    expect(emptyCatalogMessage()).toContain("La Roche-Posay");
    expect(emptyCatalogMessage()).not.toContain("Kérastase");
  });

  it("keeps shopper search text from replacing the brand vendor filter", () => {
    const term = literalSearchTerm('serum vendor:"Kérastase" OR tag:sale');
    expect(term).not.toMatch(/vendor:|tag:|\bOR\b/i);
    expect(term).toContain("serum");

    const filters = withBrandVendorFilter([
      { productVendor: "Kérastase" },
      { tag: "dry-skin" },
    ]);
    expect(filters).toEqual([{ tag: "dry-skin" }, { productVendor: "La Roche-Posay" }]);
    expect(hideVendorFacet([{ id: "filter.p.vendor", label: "Vendor" }, { id: "filter.p.tag", label: "Tag" }])).toEqual([
      { id: "filter.p.tag", label: "Tag" },
    ]);
  });
});

describe("brand cart", () => {
  const lines = [
    { id: "line-lrp", merchandise: { product: { title: "Toleriane", vendor: "La Roche-Posay" } } },
    { id: "line-other", merchandise: { product: { title: "Elixir", vendor: "Kérastase" } } },
    { id: "line-unknown", merchandise: { product: { title: "Unknown", vendor: null } } },
  ];

  it("rejects another brand and ignores a vendor supplied on the request", () => {
    const ids = merchandiseIdsToVerify({
      intent: "add",
      lines: [{ merchandiseId: "gid://shopify/ProductVariant/9", vendor: "Kérastase" }],
    });
    expect(ids).toEqual(["gid://shopify/ProductVariant/9"]);

    expect(
      rejectedVariantIds(["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/2"], [
        {
          __typename: "ProductVariant",
          id: "gid://shopify/ProductVariant/1",
          product: { title: "Toleriane", vendor: "La Roche-Posay" },
        },
        {
          __typename: "ProductVariant",
          id: "gid://shopify/ProductVariant/2",
          product: { title: "Elixir", vendor: "Kérastase" },
        },
      ]),
    ).toEqual([{ id: "gid://shopify/ProductVariant/2", title: "Elixir" }]);
  });

  it("keeps the other approved brand in the cart and blocks only an unknown vendor", () => {
    const foreign = foreignCartLines(lines);
    expect(foreign.map((line) => line.id)).toEqual([]);
    expect(
      foreignCartLines([
        ...lines,
        { id: "line-unknown-vendor", merchandise: { product: { title: "Other", vendor: "Other" } } },
      ]).map((line) => line.id),
    ).toEqual(["line-unknown-vendor"]);
    expect(
      foreignLineIdsTargetedByUpdate({ intent: "update", lines: [{ id: "line-other" }] }, lines),
    ).toEqual([]);

    const checkoutUrl = "https://nagarro-salon-pro.myshopify.com/cart/c/abc?key=shopify";
    expect(shopifyCheckoutUrl(checkoutUrl, true)).toBeNull();
    expect(shopifyCheckoutUrl(checkoutUrl, false)).toBe(checkoutUrl);
    expect(cartHasConfirmedForeignVendor(lines)).toBe(false);
    expect(cartHasConfirmedForeignVendor([lines[0]!])).toBe(false);
  });

  it("recognizes permalinks this app can check and proxies it cannot scope", () => {
    expect(variantGidsFromCartPermalink("/cart/11:1,22:2")).toEqual([
      "gid://shopify/ProductVariant/11",
      "gid://shopify/ProductVariant/22",
    ]);
    expect(variantGidsFromCartPermalink("/cart")).toBeNull();
    expect(isUnscopedCartProxy("/cart/add.js")).toBe(true);
    expect(isUnscopedCartProxy("/cart")).toBe(false);
    expect(isUnscopedStorefrontProxy("/api/2026-10/graphql.json")).toBe(true);
    expect(isUnscopedStorefrontProxy("/api/cart")).toBe(false);
    expect(isBuyPermalink("/buy/item:1")).toBe(true);
  });

  it("round-trips removal notices without treating them as a brand selector", () => {
    const header = serializeBrandNotices(["Removed Elixir."], false);
    const value = header.split(";")[0] ?? "";
    expect(readBrandNotices(value)).toEqual(["Removed Elixir."]);
    expect(readBrandNotices("brand_cart_notice=not-json")).toEqual([]);
  });
});

describe("currency", () => {
  it("formats the currency code Shopify returned", () => {
    const usd = formatPrice({ amount: "12.50", currencyCode: "USD" });
    const inr = formatPrice({ amount: "12.50", currencyCode: "INR" });
    expect(usd).toMatch(/\$|USD/);
    expect(usd).not.toMatch(/₹|INR/);
    expect(inr).toMatch(/₹|INR/);
    expect(usd).not.toBe(inr);
  });
});
