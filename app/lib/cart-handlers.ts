import {
  createCartServerHandlers,
  createShopifyRouteHandler,
  getCart,
  getCartId,
  parseCartRequest,
} from "@shopify/hydrogen";

import {
  foreignLineIdsTargetedByUpdate,
  merchandiseIdsToVerify,
  readBrandNotices,
  rejectedMerchandiseMessage,
  serializeBrandNotices,
  unverifiedMerchandiseMessage,
} from "~/lib/brand";
import {
  findRejectedMerchandise,
  stripForeignLines,
  type StoredBrandCart,
} from "~/lib/brand-cart";

const baseCartHandlers = createCartServerHandlers();

/** Typed Hydrogen cart handlers. Brand checks wrap the routes registered separately. */
export const cartHandlers = baseCartHandlers;

type CartContext = {
  request: Request;
  storefrontClient: Parameters<typeof baseCartHandlers.get>[0]["storefrontClient"];
};

function rejectionMessages(rejected: { title: string }[] | "unverified"): string[] {
  if (rejected === "unverified") return [unverifiedMerchandiseMessage()];
  return rejected.map((item) => rejectedMerchandiseMessage(item.title));
}

function noticeCookie(request: Request, notices: readonly string[]): string | null {
  if (notices.length === 0) return null;
  return serializeBrandNotices(notices, new URL(request.url).protocol === "https:");
}

export async function loadBrandCart(context: {
  request?: Request;
  storefrontClient: CartContext["storefrontClient"];
}) {
  const result = await baseCartHandlers.get(context);
  const cookieNotices = readBrandNotices(context.request?.headers.get("cookie") ?? null);
  const cart = result.data.cart as StoredBrandCart | null;
  if (!cart) return { result, notices: cookieNotices };

  const stripped = await stripForeignLines(context.storefrontClient, cart);
  const headers = new Headers(result.headers);
  const cookie = context.request ? noticeCookie(context.request, stripped.notices) : null;
  if (cookie) headers.append("set-cookie", cookie);

  return {
    result: {
      ...result,
      headers,
      data: {
        ...result.data,
        cart: stripped.cart as typeof result.data.cart,
      },
    },
    notices: [...cookieNotices, ...stripped.notices],
  };
}

async function postBrandCart(context: CartContext) {
  const { request, storefrontClient } = context;
  let parsed: Awaited<ReturnType<typeof parseCartRequest>> | null = null;
  try {
    parsed = await parseCartRequest(request.clone());
  } catch {
    parsed = null;
  }

  const notices: string[] = [];
  if (parsed) {
    const action = parsed.action as {
      intent: string;
      lines?: { id?: string; merchandiseId?: string; vendor?: string }[];
    };
    const ids = merchandiseIdsToVerify(action);
    if (ids.length > 0) {
      const rejected = await findRejectedMerchandise(storefrontClient, ids);
      if (rejected === "unverified" || rejected.length > 0) {
        return rejectCartChange(request, storefrontClient, rejectionMessages(rejected));
      }
    }

    const cartId = parsed.cartId ?? getCartId(request);
    if (cartId) {
      const loaded = await getCart(cartId, storefrontClient);
      const cart = loaded.cart as StoredBrandCart | null;
      if (cart) {
        const targeted =
          action.intent === "update" ? foreignLineIdsTargetedByUpdate(action, cart.lines.nodes) : [];
        const stripped = await stripForeignLines(storefrontClient, cart);
        if (targeted.length > 0 || stripped.status === "failed") {
          return rejectCartChange(request, storefrontClient, stripped.notices, stripped.cart);
        }
        notices.push(...stripped.notices);
      }
    }
  }

  const result = await baseCartHandlers.post(context);
  return attachNotices(request, result, notices);
}

async function rejectCartChange(
  request: Request,
  storefrontClient: CartContext["storefrontClient"],
  notices: string[],
  cart?: StoredBrandCart | null,
) {
  const headers = new Headers();
  const cookie = noticeCookie(request, notices);
  if (cookie) headers.append("set-cookie", cookie);

  if (!request.headers.get("content-type")?.includes("application/json")) {
    return {
      type: "redirect" as const,
      location: sameOriginPath(request),
      status: 303 as const,
      headers,
    };
  }

  let current = cart ?? null;
  if (!current) {
    const cartId = getCartId(request);
    if (cartId) {
      const loaded = await getCart(cartId, storefrontClient);
      current = (loaded.cart as StoredBrandCart | null) ?? null;
    }
  }

  return {
    type: "json" as const,
    headers,
    data: {
      cart: current,
      userErrors: notices.map((message) => ({ message })),
      warnings: [],
    },
  };
}

function attachNotices(
  request: Request,
  result: Awaited<ReturnType<typeof baseCartHandlers.post>>,
  notices: string[],
) {
  if (notices.length === 0) return result;
  const headers = new Headers(result.headers);
  const cookie = noticeCookie(request, notices);
  if (cookie) headers.append("set-cookie", cookie);
  if (result.type === "redirect") return { ...result, headers };
  if (result.type !== "json") return result;

  const existing = Array.isArray(result.data.userErrors) ? result.data.userErrors : [];
  return {
    ...result,
    headers,
    data: {
      ...result.data,
      userErrors: [...existing, ...notices.map((message) => ({ message }))],
    },
  };
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

export const brandCartHandlers = {
  get: createShopifyRouteHandler("/api/cart", "GET", async (context) => {
    const loaded = await loadBrandCart(context);
    return loaded.result;
  }),
  post: createShopifyRouteHandler("/api/cart", "POST", async (context) => postBrandCart(context)),
};
