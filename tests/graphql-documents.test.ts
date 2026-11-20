import { readFileSync } from "node:fs";

import { buildClientSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";

import { VARIANT_VENDOR_QUERY } from "~/lib/brand-cart";
import { COLLECTION_QUERY } from "~/lib/collection";
import { COLLECTIONS_QUERY } from "~/lib/collections";
import { BRAND_SUGGESTION_QUERY } from "~/lib/predictive-search-handlers";
import { ROOT_LAYOUT_QUERY } from "~/lib/root-layout";
import { SEARCH_QUERY } from "~/lib/search";
import { HOME_QUERY } from "~/routes/home";
import { PRODUCT_QUERY } from "~/routes/product";

const schema = buildClientSchema(
  JSON.parse(readFileSync("node_modules/@shopify/hydrogen/dist/storefront.schema.json", "utf8")),
);

const documents = {
  SEARCH_QUERY,
  COLLECTION_QUERY,
  COLLECTIONS_QUERY,
  ROOT_LAYOUT_QUERY,
  HOME_QUERY,
  PRODUCT_QUERY,
  VARIANT_VENDOR_QUERY,
  BRAND_SUGGESTION_QUERY,
};

describe("storefront documents", () => {
  it("validates brand catalog and cart documents against the installed schema", () => {
    const failures = Object.entries(documents).flatMap(([name, document]) => {
      const errors = validate(schema, parse(String(document)));
      return errors.map((error) => `${name}: ${error.message}`);
    });
    expect(failures).toEqual([]);
  });
});
