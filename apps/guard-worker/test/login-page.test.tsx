import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginPage } from "../src/client/pages/LoginPage";

describe("Brolly login", () => {
  it("renders exactly one OAuth login action when OAuth is configured", () => {
    const html = renderToStaticMarkup(<LoginPage error="" oauthConfigured credentialStorageReady />);
    expect(html.match(/href="\/api\/auth\/login"/g)).toHaveLength(1);
  });
});
