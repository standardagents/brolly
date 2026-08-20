import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { METRIC_CATALOG } from "@standardagents/brolly-core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductIcon } from "../src/client/components/ui";
import { PRODUCT_ICON } from "../src/client/lib/meta";

const iconDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../public/cloudflare-icons");
const families = METRIC_CATALOG.map(item => item.family).filter(family => family !== "unknown");

describe("Cloudflare product icons", () => {
  it("renders a local compact glyph for every catalog family", () => {
    const html = renderToStaticMarkup(
      <>{families.map(family => <span key={family} data-family={family}><ProductIcon family={family} size="sm" />{family}</span>)}</>,
    );

    expect((html.match(/product-glyph/g) ?? []).length).toBe(families.length);
    for (const family of families) {
      const icon = PRODUCT_ICON[family];
      expect(icon, family).toBeTruthy();
      expect(existsSync(resolve(iconDirectory, `${icon}.svg`)), family).toBe(true);
      expect(html).toContain(`url(/cloudflare-icons/${icon}.svg)`);
    }
  });
});
