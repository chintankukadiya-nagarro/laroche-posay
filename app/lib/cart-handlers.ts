import { createCartServerHandlers, createShopifyRouteHandler, type StorefrontClient } from "@shopify/hydrogen";
import type { ShopifyRequestContext } from "@shopify/hydrogen";
import type { WritableCustomerSessionManager } from "@shopify/hydrogen/customer-account";

import {
  merchandiseIdsToVerify,
  readBrandNotices,
  rejectedMerchandiseMessage,
  serializeBrandNotices,
  unverifiedMerchandiseMessage,
} from "~/lib/brand";
import { findRejectedMerchandise } from "~/lib/brand-cart";
import {
  actionToOperation,
  callSharedCart,
  mergeAnonymousCart,
  EMPTY_SHARED_CART,
  presentSharedCart,
  readCartAction,
  readCustomerAccessToken,
  sameOrigin,
  sharedCartConfigured,
  type SharedCartResponse,
} from "@loreal/shared-cart";

const baseCartHandlers = createCartServerHandlers();

export const cartHandlers = baseCartHandlers;

type CartContext = {
  request: Request;
  storefrontClient: StorefrontClient;
  sessionManager: WritableCustomerSessionManager;
  requestContext: ShopifyRequestContext;
};

function rejectionMessages(rejected: { title: string }[] | "unverified"): string[] {
  if (rejected === "unverified") return [unverifiedMerchandiseMessage()];
  return rejected.map((item) => rejectedMerchandiseMessage(item.title));
}

function noticeCookie(request: Request, notices: readonly string[]): string | null {
  if (notices.length === 0) return null;
  return serializeBrandNotices(notices, new URL(request.url).protocol === "https:");
}

function privateHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("cache-control", "private, no-store");
  return headers;
}

function messages(body: SharedCartResponse): { message: string }[] {
  return [
    ...(body.userErrors ?? []),
    ...(body.error ? [{ message: body.error }] : []),
  ];
}

async function signedInCart(context: CartContext, body: Record<string, unknown>) {
  const { request } = context;
  const headers = privateHeaders();
  if (request.method === "POST" && !sameOrigin(request)) {
    return {
      type: "error" as const,
      status: 403,
      error: { code: "forbidden", message: "Forbidden" },
      headers,
    };
  }
  const accessToken = await readCustomerAccessToken(context);
  if (!accessToken) return null;
  if (!sharedCartConfigured()) {
    return {
      type: "json" as const,
      headers,
      notices: ["Shared cart is not configured."],
      data: {
        cart: EMPTY_SHARED_CART,
        userErrors: [{ message: "Shared cart is not configured." }],
        warnings: [],
      } as unknown as Awaited<ReturnType<typeof baseCartHandlers.get>>["data"],
    };
  }

  const merged = await mergeAnonymousCart(request, context.storefrontClient, accessToken, context.requestContext);
  if (merged.cookie) headers.append("set-cookie", merged.cookie);
  const sessionHeaders = await context.sessionManager.commit?.();
  if (sessionHeaders) {
    for (const cookie of new Headers(sessionHeaders).getSetCookie()) headers.append("set-cookie", cookie);
  }

  const result = await callSharedCart(request, accessToken, body, context.requestContext);
  const cart = presentSharedCart(result.body.cart) ?? EMPTY_SHARED_CART;
  const isForm = !request.headers.get("content-type")?.includes("application/json");
  if (isForm && request.method === "POST") {
    return { type: "redirect" as const, location: sameOriginPath(request), headers };
  }
  const userErrors = [...messages(result.body), ...merged.userErrors];
  return {
    type: "json" as const,
    headers,
    notices: userErrors.map((error) => error.message),
    data: {
      cart,
      userErrors,
      warnings: [...(result.body.warnings ?? []), ...merged.warnings],
    } as unknown as Awaited<ReturnType<typeof baseCartHandlers.get>>["data"],
  };
}

async function postAnonymous(context: CartContext) {
  const { request, storefrontClient } = context;
  const parsed = await readCartAction(request.clone());
  if (parsed) {
    const ids = merchandiseIdsToVerify(parsed);
    if (ids.length > 0) {
      const rejected = await findRejectedMerchandise(storefrontClient, ids);
      if (rejected === "unverified" || rejected.length > 0) {
        const notices = rejectionMessages(rejected);
        const headers = privateHeaders();
        const cookie = noticeCookie(request, notices);
        if (cookie) headers.append("set-cookie", cookie);
        if (!request.headers.get("content-type")?.includes("application/json")) {
          return { type: "redirect" as const, location: sameOriginPath(request), status: 303 as const, headers };
        }
        const current = await baseCartHandlers.get(context);
        return {
          type: "json" as const,
          headers,
          data: {
            cart: current.data.cart,
            userErrors: notices.map((message) => ({ message })),
            warnings: [],
          },
        };
      }
    }
  }
  return baseCartHandlers.post(context);
}

function sameOriginPath(request: Request): string {
  const referer = request.headers.get("referer");
  if (!referer) return "/cart";
  try {
    const target = new URL(referer);
    if (target.origin !== new URL(request.url).origin) return "/cart";
    return `${target.pathname}${target.search}` || "/cart";
  } catch {
    return "/cart";
  }
}

export async function loadBrandCart(context: CartContext) {
  const signedIn = await signedInCart(context, { op: "get" });
  if (signedIn && signedIn.type === "json") {
    return {
      result: { type: signedIn.type, headers: signedIn.headers, data: signedIn.data },
      notices: [...readBrandNotices(context.request.headers.get("cookie")), ...signedIn.notices],
    };
  }
  const result = await baseCartHandlers.get(context);
  return { result, notices: readBrandNotices(context.request.headers.get("cookie")) };
}

export const brandCartHandlers = {
  get: createShopifyRouteHandler("/api/cart", "GET", async (context: CartContext) => {
    const loaded = await loadBrandCart(context);
    return loaded.result;
  }),
  post: createShopifyRouteHandler("/api/cart", "POST", async (context: CartContext) => {
    const cartRequest = context.request.clone();
    const parsed = await readCartAction(cartRequest);
    await cartRequest.arrayBuffer().catch(() => undefined);
    const signedIn = await signedInCart(context, parsed ? actionToOperation(parsed) : { op: "get" });
    if (signedIn) await context.request.arrayBuffer().catch(() => undefined);
    if (signedIn?.type === "json") {
      return { type: signedIn.type, headers: signedIn.headers, data: signedIn.data };
    }
    if (signedIn) return signedIn;
    return postAnonymous(context);
  }),
};
