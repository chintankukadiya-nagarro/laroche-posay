import { describe, expect, it } from "vitest";

import { AdminTokenError, createAdminTokenClient } from "@loreal/shared-cart";

const shop = "nagarro-salon-pro.myshopify.com";
const clientId = "client-id";
const clientSecret = "client-secret";
const token = "admin-access-token";
const env = { PUBLIC_STORE_DOMAIN: shop, SHOPIFY_CLIENT_ID: clientId, SHOPIFY_CLIENT_SECRET: clientSecret };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("admin client credentials", () => {
  it("exchanges the client secret for a token and reuses it until near expiry", async () => {
    let now = 1_000;
    let exchanges = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/admin/oauth/access_token")) {
        exchanges += 1;
        const body = String(init?.body);
        expect(body).toContain("grant_type=client_credentials");
        expect(body).toContain(`client_secret=${clientSecret}`);
        return jsonResponse({ access_token: token, scope: "write_customers", expires_in: 3600 });
      }
      expect(init?.headers).toMatchObject({ "X-Shopify-Access-Token": token });
      return jsonResponse({ access_scopes: [{ handle: "write_customers" }] });
    };
    const client = createAdminTokenClient(fetchImpl, () => now);
    expect(await client.getAccessToken(env)).toBe(token);
    expect(await client.getAccessToken(env)).toBe(token);
    expect(exchanges).toBe(1);
    now += 3600 * 1000 - 30_000;
    expect(await client.getAccessToken(env)).toBe(token);
    expect(exchanges).toBe(2);
  });

  it("refuses a token that does not grant write_customers and keeps the secret out of the error", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/access_token")) return jsonResponse({ access_token: token, scope: "read_products", expires_in: 3600 });
      return jsonResponse({ access_scopes: [{ handle: "read_products" }] });
    };
    const client = createAdminTokenClient(fetchImpl);
    const error = await client.getAccessToken(env).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdminTokenError);
    expect(error instanceof Error ? error.message : "").toBe("write_customers is not granted.");
    expect(String(error)).not.toContain(clientSecret);
    expect(String(error)).not.toContain(token);
  });

  it("drops a cached token when it is invalidated", async () => {
    let issued = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/access_token")) {
        issued += 1;
        return jsonResponse({ access_token: `token-${issued}`, scope: "write_customers", expires_in: 3600 });
      }
      return jsonResponse({ access_scopes: [{ handle: "write_customers" }] });
    };
    const client = createAdminTokenClient(fetchImpl);
    expect(await client.getAccessToken(env)).toBe("token-1");
    client.invalidate(env);
    expect(await client.getAccessToken(env)).toBe("token-2");
  });
});
