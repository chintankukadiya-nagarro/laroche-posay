import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CART_METAFIELD,
  SHOP_DOMAIN,
  createMemoryMetafields,
  customerGidFromProxy,
  parseLineId,
  handleAppProxyCart,
  handleSharedCart,
  proxyMessage,
  sameOrigin,
  signProxy,
  verifyProxySignature,
  type CartShopify,
  type StoredCart,
} from "@loreal/shared-cart";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const customerA = "gid://shopify/Customer/1";
const customerB = "gid://shopify/Customer/2";
const variantA = "gid://shopify/ProductVariant/1";
const variantB = "gid://shopify/ProductVariant/2";
const variantOther = "gid://shopify/ProductVariant/9";

function identity(customerGid: string) {
  return { shop: SHOP_DOMAIN, customerGid, accessToken: "token-a", buyerIp: "203.0.113.8" };
}

function fakeShopify(vendors: Record<string, string> = { [variantA]: "La Roche-Posay", [variantB]: "Kérastase" }) {
  let sequence = 0;
  const carts = new Map<string, StoredCart>();
  const shopify: CartShopify = {
    async catalogReady() {
      return true;
    },
    async variants(ids) {
      return ids.map((id) => ({ __typename: "ProductVariant", id, product: { title: "Item", vendor: vendors[id] ?? "Other" } }));
    },
    async loadCart(cartId) {
      return carts.get(cartId) ?? null;
    },
    async mutate(mutation, variables) {
      if (mutation === "create") {
        const input = variables.input as { lines?: { merchandiseId: string; quantity: number }[] };
        const id = `gid://shopify/Cart/${++sequence}?key=secret${sequence}`;
        const cart = cartFrom(id, input.lines ?? []);
        carts.set(id, cart);
        return { cart, userErrors: [], warnings: [] };
      }
      const cartId = String(variables.cartId);
      const cart = carts.get(cartId);
      if (!cart) return { cart: null, userErrors: [{ message: "Cart not found" }], warnings: [] };
      if (mutation === "add") {
        const lines = variables.lines as { merchandiseId: string; quantity: number }[];
        for (const line of lines) addLine(cart, line.merchandiseId, line.quantity);
        return { cart, userErrors: [], warnings: [] };
      }
      if (mutation === "buyer") return { cart, userErrors: [], warnings: [] };
      return { cart, userErrors: [], warnings: [] };
    },
  };
  return { shopify, carts };
}

function cartFrom(id: string, lines: { merchandiseId: string; quantity: number }[]): StoredCart {
  const cart: StoredCart = {
    id,
    checkoutUrl: `https://${SHOP_DOMAIN}/cart/c/1?key=${id.split("key=")[1]}`,
    totalQuantity: 0,
    note: null,
    attributes: [],
    discountCodes: [],
    cost: {
      subtotalAmount: { amount: "0.00", currencyCode: "INR" },
      totalAmount: { amount: "0.00", currencyCode: "INR" },
    },
    lines: { nodes: [] },
  };
  for (const line of lines) addLine(cart, line.merchandiseId, line.quantity);
  return cart;
}

function addLine(cart: StoredCart, merchandiseId: string, quantity: number) {
  const existing = cart.lines.nodes.find((line) => line.merchandise?.id === merchandiseId);
  if (existing) existing.quantity += quantity;
  else {
    cart.lines.nodes.push({
      id: `gid://shopify/CartLine/${cart.lines.nodes.length + 1}`,
      quantity,
      attributes: [],
      sellingPlanAllocation: null,
      cost: {
        totalAmount: { amount: "1.00", currencyCode: "INR" },
        amountPerQuantity: { amount: "1.00", currencyCode: "INR" },
      },
      merchandise: { id: merchandiseId, title: "Item", product: { title: "Item", handle: "item", vendor: "La Roche-Posay" } },
    });
  }
  cart.totalQuantity = cart.lines.nodes.reduce((sum, line) => sum + line.quantity, 0);
}

function deps() {
  const admin = createMemoryMetafields();
  const { shopify, carts } = fakeShopify();
  return { admin, shopify, carts, pepper: "pepper" };
}

describe("shared cart gates", () => {
  it("documents private metafield access and the Hydrogen home storefront", () => {
    const doc = readFileSync(path.join(root, "laroche-posay/docs/shared-cart.md"), "utf8");
    const routes = readFileSync(path.join(root, "laroche-posay/app/routes.ts"), "utf8");
    expect(CART_METAFIELD).toMatchObject({
      ownerType: "CUSTOMER",
      namespace: "$app",
      cartKey: "cart_id",
      mergesKey: "merges",
      access: { admin: "merchant_read", storefront: "none", customerAccount: "read_write" },
    });
    expect(doc).toContain("`access.storefront`: `none`");
    expect(doc).toContain("`access.customer_account`: `read_write`");
    expect(doc).toContain("customer_write_customers");
    expect(doc).toContain("nagarro-salon-home");
    expect(doc).toContain("Horizon and the app proxy are not part of the cart");
    expect(routes).not.toContain("apps/shared-cart/cart");
  });

  it("keeps the first compareDigest create and moves the loser lines onto that cart", async () => {
    const gate = deps();
    const [first, second] = await Promise.all([
      handleSharedCart(gate, identity(customerA), { op: "add", lines: [{ merchandiseId: variantA, quantity: 1 }] }),
      handleSharedCart(gate, identity(customerA), { op: "add", lines: [{ merchandiseId: variantB, quantity: 1 }] }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const stored = await gate.admin.read(customerA, CART_METAFIELD.cartKey);
    expect(stored.value).toMatch(/\?key=/);
    const cart = gate.carts.get(stored.value!);
    expect(cart?.lines.nodes.map((line) => line.merchandise?.id).sort()).toEqual([variantA, variantB]);
    expect(JSON.stringify(first.body)).not.toContain("key=");
    expect(JSON.stringify(second.body)).not.toContain("key=");
  });

  it("merges a guest cart once and a retry does not add the line again", async () => {
    const gate = deps();
    const lines = [{ merchandiseId: variantA, quantity: 2 }];
    const source = "anonymous-cart-token";
    const first = await handleSharedCart(gate, identity(customerA), { op: "merge", sourceCartId: source, lines });
    const second = await handleSharedCart(gate, identity(customerA), { op: "merge", sourceCartId: source, lines });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const stored = await gate.admin.read(customerA, CART_METAFIELD.cartKey);
    expect(gate.carts.get(stored.value!)?.lines.nodes[0]?.quantity).toBe(2);
  });

  it("rejects another vendor and ignores a customer id supplied on the operation", async () => {
    const gate = deps();
    const rejected = await handleSharedCart(gate, identity(customerA), {
      op: "add",
      lines: [{ merchandiseId: variantOther, quantity: 1 }],
    });
    expect(JSON.stringify(rejected.body)).toContain("shared catalog");
    expect((await gate.admin.read(customerA, CART_METAFIELD.cartKey)).value).toBeNull();

    await handleSharedCart(gate, identity(customerA), { op: "add", lines: [{ merchandiseId: variantA, quantity: 1 }] });
    const other = await handleSharedCart(
      gate,
      identity(customerB),
      { op: "get", customerGid: customerA } as { op: "get" },
    );
    expect(other.status).toBe(200);
    expect("cart" in other.body && other.body.cart).toBeNull();
  });

  it("replaces a missing Shopify cart and hides it after an account switch", async () => {
    const gate = deps();
    await handleSharedCart(gate, identity(customerA), { op: "add", lines: [{ merchandiseId: variantA, quantity: 1 }] });
    const stored = await gate.admin.read(customerA, CART_METAFIELD.cartKey);
    gate.carts.delete(stored.value!);
    const replaced = await handleSharedCart(gate, identity(customerA), { op: "add", lines: [{ merchandiseId: variantB, quantity: 1 }] });
    const next = await gate.admin.read(customerA, CART_METAFIELD.cartKey);
    expect(next.value).not.toBe(stored.value);
    expect(gate.carts.get(next.value!)?.lines.nodes.map((line) => line.merchandise?.id)).toEqual([variantB]);
    expect(JSON.stringify(replaced.body)).not.toContain("key=");
    const switched = await handleSharedCart(gate, identity(customerB), { op: "get" });
    expect("cart" in switched.body && switched.body.cart).toBeNull();
  });

  it("rejects a tampered proxy signature, a stale timestamp, and a cross-origin mutation", async () => {
    const secret = "proxy-secret";
    const now = 1_700_000_000;
    const params = new URLSearchParams({
      shop: SHOP_DOMAIN,
      logged_in_customer_id: "1",
      path_prefix: "/apps/shared-cart",
      timestamp: String(now),
      signature: "placeholder",
    });
    const message = proxyMessage(params);
    expect(message).toBeTruthy();
    params.set("signature", await signProxy(message!, secret));
    const url = new URL(`https://oxygen.example/apps/shared-cart/cart?${params}`);
    expect((await verifyProxySignature(url, secret, now))?.customerId).toBe("1");
    params.set("logged_in_customer_id", "2");
    expect(await verifyProxySignature(new URL(`https://oxygen.example/apps/shared-cart/cart?${params}`), secret, now)).toBeNull();
    params.set("logged_in_customer_id", "1");
    params.set("signature", await signProxy(proxyMessage(params)!, secret));
    expect(await verifyProxySignature(new URL(`https://oxygen.example/apps/shared-cart/cart?${params}`), secret, now + 200)).toBeNull();

    const request = new Request("https://laroche.example/api/cart", { method: "POST", headers: { origin: "https://kerastase.example" } });
    expect(sameOrigin(request)).toBe(false);
    expect(customerGidFromProxy("1")).toBe(customerA);
    expect(customerGidFromProxy("")).toBeNull();
    expect(parseLineId("gid://shopify/CartLine/abc?cart=gid://shopify/Cart/xyz")).toBe(
      "gid://shopify/CartLine/abc?cart=gid://shopify/Cart/xyz",
    );
    expect(parseLineId("gid://shopify/CartLine/abc")).toBe("gid://shopify/CartLine/abc");
    expect(parseLineId("gid://shopify/CartLine/abc?cart=gid://shopify/Cart/xyz&x=1")).toBeNull();
  });

  it("serves a signed proxy cart without the cart secret and rejects a direct call", async () => {
    const gate = deps();
    const secret = "proxy-secret";
    const now = 1_700_000_000;
    const params = new URLSearchParams({
      shop: SHOP_DOMAIN,
      logged_in_customer_id: "1",
      path_prefix: "/apps/shared-cart",
      timestamp: String(now),
      signature: "placeholder",
    });
    params.set("signature", await signProxy(proxyMessage(params)!, secret));
    const request = new Request(`https://oxygen.example/apps/shared-cart/cart?${params}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ op: "add", lines: [{ merchandiseId: variantA, quantity: 1 }], cartId: "gid://shopify/Cart/attacker?key=nope" }),
    });
    const response = await handleAppProxyCart(request, { PUBLIC_STORE_DOMAIN: SHOP_DOMAIN, APP_PROXY_SECRET: secret }, { now, deps: gate });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("key=");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();

    const direct = await handleAppProxyCart(new Request("https://oxygen.example/apps/shared-cart/cart"), { APP_PROXY_SECRET: secret }, { now, deps: gate });
    expect(direct.status).toBe(401);
  });
});
