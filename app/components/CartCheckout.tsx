import { ShopPayButton } from "@shopify/hydrogen/react";

import { isSharedCartId } from "@loreal/shared-cart";

const buttonClass =
  "rounded-button button-primary focus-visible:outline-accent inline-flex h-11 w-full items-center justify-center gap-2 px-4 text-sm font-medium no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 motion-safe:transition-[color,background-color,border-color,transform] motion-safe:active:scale-[0.97]";

export function CartCheckout({
  cartId,
  checkoutUrl,
}: {
  cartId?: string | null;
  checkoutUrl?: string | null;
}) {
  if (isSharedCartId(cartId)) {
    return (
      <form method="post" action="/api/shared-checkout" className="grid gap-3">
        <p className="text-on-surface-secondary text-xs">
          Shop Pay express checkout is not available on the combined cart. Checkout opens the
          Shopify checkout for this cart.
        </p>
        <button type="submit" className={`${buttonClass} cursor-pointer`}>
          Checkout
        </button>
      </form>
    );
  }

  if (!checkoutUrl) return null;

  return (
    <div className="grid gap-3">
      <ShopPayButton width="100%" borderRadius="8px" />
      <a href={checkoutUrl} className={buttonClass}>
        Checkout
      </a>
    </div>
  );
}
