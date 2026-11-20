# Shared cart

One cart design. La Roche-Posay, Kérastase, and the home storefront each run it on Oxygen. The cart id is stored on the Shopify customer. There is no second cart host.

Do not deploy Oxygen, publish the Horizon theme, create the metafield, or change an environment from private to public without approval.

## 1. Metafield ownership and access

Owner type is `CUSTOMER`. Both keys are `single_line_text_field` in the app-owned namespace `$app`.

| Key | Value |
| --- | --- |
| `cart_id` | Full Storefront cart id, including `?key=` |
| `merges` | JSON list of guest-cart hashes already merged |

Access:

- `access.admin`: `merchant_read`
- `access.storefront`: `none`
- `access.customer_account`: `read_write`

The signed-in Hydrogen server writes this field with that customer's own Customer Account session. It does not use `customer_write_customers`. Storefront access stays `none`. Merchants can read the value in admin. The browser, the cart cookie, and Liquid do not receive the cart id. API responses use `gid://shopify/Cart/shared`.

## 2. First-cart creation with compareDigest

Admin `metafieldsSet` writes the cart id. The first create sends `compareDigest: null`, which succeeds only when the metafield does not exist yet. A conflict means another request stored a cart id. The loser discards its new cart, re-reads the winner, and adds its lines to that cart. A later update sends the digest from the preceding read. A mismatch re-reads and retries once.

## 3. Guest merge and concurrent operations

The `merges` metafield uses the same compare-and-set. A retry of an open merge adds a line only when the shared cart does not already contain that variant, selling plan, and attributes at the source quantity. Concurrent adds of different variants use `cartLinesAdd`. Quantity updates send the absolute quantity. The digest protects the stored cart id, not every line.

## 4. Storefronts

The home site is the Hydrogen storefront in `nagarro-salon-home`. Horizon and the app proxy are not part of the cart. Each storefront signs the customer in on its own origin and writes the customer metafield with that customer's Customer Account token. Oxygen environments stay private until a visibility change is approved separately. Do not change that visibility here.

## 5. Identity and CSRF

Hydrogen takes the Customer Account access token from that origin's session and resolves `customer { id }`. The body cannot name the customer. Mutations require a same-origin `Origin` or `Referer`. Direct calls and cross-origin browser calls are rejected. CORS stays closed.

Each site starts its own login. The session cookie is not shared. The same Shopify customer id is what makes the cart match.

## 6. Least-privilege credentials

Browsing keeps each storefront's own token and vendor filter. The shared cart uses `SHARED_CART_STOREFRONT_TOKEN`, a token whose channel can see both `La Roche-Posay` and `Kérastase`. The Kérastase token cannot. When that name is empty, the server uses `PRIVATE_STOREFRONT_API_TOKEN`. `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are exchanged on the server for a short-lived Admin API token. The exchange is kept only when `write_customers` is granted, and the token is refreshed before it expires. None of these are committed, logged, or sent to the browser.

## 7. Home catalog

The home storefront lists products and collections for La Roche-Posay and Kérastase. Other vendors are omitted from product, collection, and search results. The cart service still rejects any other vendor. La Roche-Posay and Kérastase keep their own collection for browsing, and their carts can hold both brands.

## 8. Cart lifetime

A missing or completed Shopify cart is replaced, and the new id is stored with compare-and-set. Logout expires the local Hydrogen `cart` cookie and does not delete the metafield. The next account on that browser has no cart id in the cookie and cannot read the previous customer's metafield. Checkout follows the `checkoutUrl` returned for that request.
