import { getCart, getCartId, type StorefrontClient } from "@shopify/hydrogen";

import {
  cartHasConfirmedForeignVendor,
  clearBrandNoticesCookie,
  isBuyPermalink,
  isUnscopedCartProxy,
  isUnscopedStorefrontProxy,
  rejectedMerchandiseMessage,
  serializeBrandNotices,
  variantGidsFromCartPermalink,
} from "~/lib/brand";
import { findRejectedMerchandise, type StoredBrandCart } from "~/lib/brand-cart";

const DISABLED_PROXY_MESSAGE =
  "This cart endpoint is disabled on this demo because it cannot be limited to one brand. Add products from the product page instead.";

const DISABLED_BUY_MESSAGE =
  "Buy links are disabled on this demo because they cannot be limited to one brand.";

const DISABLED_STOREFRONT_PROXY_MESSAGE =
  "The Storefront API proxy is disabled on this demo because queries cannot be limited to one brand.";

type GateClient = Pick<StorefrontClient, "graphql">;

export async function enforceBrandHandoff(
  request: Request,
  storefront: GateClient,
): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (isUnscopedCartProxy(pathname) || isUnscopedStorefrontProxy(pathname)) {
    return Response.json(
      {
        error: isUnscopedStorefrontProxy(pathname)
          ? DISABLED_STOREFRONT_PROXY_MESSAGE
          : DISABLED_PROXY_MESSAGE,
      },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  if (isBuyPermalink(pathname)) {
    return noticeRedirect(request, [DISABLED_BUY_MESSAGE]);
  }

  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const permalinkIds = variantGidsFromCartPermalink(pathname);
  if (permalinkIds) {
    const rejected = await findRejectedMerchandise(storefront, permalinkIds);
    if (rejected === "unverified") {
      return noticeRedirect(request, [
        "This cart link could not be verified for this brand, so it was not opened.",
      ]);
    }
    if (rejected.length > 0) {
      return noticeRedirect(
        request,
        rejected.map((item) => rejectedMerchandiseMessage(item.title)),
      );
    }
    return null;
  }

  if (pathname !== "/checkout") return null;

  const cartId = getCartId(request);
  if (!cartId) return null;

  try {
    const loaded = await getCart(cartId, storefront);
    const cart = loaded.cart as StoredBrandCart | null;
    if (!cart) return null;
    if (!cartHasConfirmedForeignVendor(cart.lines.nodes)) return null;
    return noticeRedirect(request, [
      "This cart contains a product from outside the shared catalog, so checkout was not opened.",
    ]);
  } catch {
    return noticeRedirect(request, [
      "This cart could not be verified for this brand, so checkout was not opened.",
    ]);
  }
}

export function clearBrandNoticeOnDocument(request: Request, response: Response): Response {
  if (!request.headers.get("cookie")?.includes("brand_cart_notice=")) return response;
  response.headers.append("set-cookie", clearBrandNoticesCookie(new URL(request.url).protocol === "https:"));
  return response;
}

function noticeRedirect(request: Request, notices: string[]): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  headers.set("location", "/cart");
  headers.append(
    "set-cookie",
    serializeBrandNotices(notices, new URL(request.url).protocol === "https:"),
  );
  return new Response(null, { status: 303, headers });
}
