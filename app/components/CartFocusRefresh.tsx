import { useCartActions } from "~/lib/cart";
import { useEffect } from "react";

export function CartFocusRefresh() {
  const { refresh } = useCartActions();

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => document.removeEventListener("visibilitychange", refreshIfVisible);
  }, [refresh]);

  return null;
}
