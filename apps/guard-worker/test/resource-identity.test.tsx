import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceIdentity, identityCollisions, identityLabel } from "../src/client/components/ResourceIdentity";
import { middleCompact } from "../src/client/format";

describe("ResourceIdentity", () => {
  it("renders Cloudflare-supplied names as names and keeps the canonical ID visible", () => {
    const html = renderToStaticMarkup(<ResourceIdentity identity={{
      cloudflareId: "76af8b34-5c68-4df8-93f2-3925060e0408",
      cloudflareName: "production-primary-database-with-a-very-long-regional-suffix",
      nameKind: "named",
      resourceType: "d1:resource",
      productFamily: "d1",
    }} />);

    expect(html).toContain('data-identity-kind="named"');
    expect(html).toContain("production-primary-database");
    expect(html).toContain("D1 database");
    expect(html).toContain("76af8b34…0e0408");
    expect(html).not.toContain("<code");
  });

  it("renders ID-only resources in code with their resource type and parent namespace", () => {
    const html = renderToStaticMarkup(<ResourceIdentity identity={{
      cloudflareId: "a2b4c6d8e0f11223344556677889900aa2b4c6d8e0f11223344556677889900a",
      cloudflareName: null,
      nameKind: "id_only",
      resourceType: "durable_objects:object",
      productFamily: "durable_objects",
      parentIdentity: {
        cloudflareId: "f0e1d2c3b4a5968778695a4b3c2d1e0f",
        cloudflareName: "AgentThread",
        nameKind: "named",
        resourceType: "durable_objects:namespace",
        productFamily: "durable_objects",
      },
    }} />);

    expect(html).toContain('data-identity-kind="id_only"');
    expect(html).toContain("Durable Object");
    expect(html).toContain("<code");
    expect(html).toContain("a2b4c6d8…89900a");
    expect(html).toContain("AgentThread");
  });

  it("expands only IDs whose compact forms collide", () => {
    const first = "12345678aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa999999";
    const second = "12345678bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb999999";
    const unique = "87654321cccccccccccccccccccccccccccccc111111";
    const collisions = identityCollisions([
      { cloudflareId: first },
      { cloudflareId: second },
      { cloudflareId: unique },
    ]);

    expect(collisions).toEqual(new Set([first, second]));
    expect(identityLabel({ cloudflareId: first, cloudflareName: null, nameKind: "id_only", resourceType: "containers:resource" }, collisions.has(first))).toContain(first);
    expect(identityLabel({ cloudflareId: unique, cloudflareName: null, nameKind: "id_only", resourceType: "containers:resource" }, collisions.has(unique))).toContain("87654321…111111");
  });

  it("preserves the distinguishing suffix of long Cloudflare names", () => {
    const east = middleCompact("sa-production-worker-with-a-very-long-generated-deployment-prefix-region-east");
    const west = middleCompact("sa-production-worker-with-a-very-long-generated-deployment-prefix-region-west");
    expect(east).not.toBe(west);
    expect(east).toMatch(/region-east$/);
    expect(west).toMatch(/region-west$/);
  });
});
