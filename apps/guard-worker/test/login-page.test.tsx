import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginPage } from "../src/client/pages/LoginPage";

describe("Brolly login", () => {
  it("uses a taller Cloudflare-branded login action", () => {
    const html = renderToStaticMarkup(<LoginPage error="" oauthConfigured credentialStorageReady />);
    expect(html).toContain("Login with Cloudflare");
    expect(html).toContain('href="/api/auth/login"');
    expect(html).toContain("min-h-[46px]");
    expect(html).toContain("mb-2.5");
    expect(html).toContain('viewBox="12 13.5 25 12"');
    expect(html).not.toContain("Continue with Cloudflare");
    expect(html).not.toContain("The first successful sign-in binds");
    expect(html).not.toContain("Read the installation guide");
  });
});
