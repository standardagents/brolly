import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuntimeAgentHandoff, runtimeAgentPrompt } from "../src/client/components/protection";
import type { OnboardingData } from "../src/client/types";

const assets: OnboardingData["scopedAssets"] = [
  {
    key: "workers/chat-worker",
    family: "workers",
    id: "chat-worker",
    name: "chat-worker",
    scope: "resource",
    protection: "active",
    tags: { cloudflareWorkerScript: "chat-worker" },
  },
  {
    key: "durable_objects/rooms",
    family: "durable_objects",
    id: "rooms",
    name: "ROOMS",
    scope: "namespace",
    protection: "active",
    tags: { cloudflareWorkerScript: "chat-worker" },
  },
];

describe("runtime coding-agent handoff", () => {
  it("generates a resource-aware, local-only implementation prompt", () => {
    const prompt = runtimeAgentPrompt(assets);

    expect(prompt).toContain("Discovered Worker scripts: chat-worker");
    expect(prompt).toContain("ROOMS (owning Worker: chat-worker)");
    expect(prompt).toContain("brollyDurableObject(ctx, env)");
    expect(prompt).toContain("brollyWorker(env, { durableObjectId: id.toString() })");
    expect(prompt).toContain("Do not deploy, set secrets, change routes, or mutate anything in Cloudflare");
    expect(prompt).toContain("Do not claim quarantine is configured until that verification passes");
  });

  it("shows one copy action and recognizable agent choices", () => {
    const html = renderToStaticMarkup(<RuntimeAgentHandoff assets={assets} />);

    expect(html).toContain("Hand this to your coding agent");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(html).toContain("Cursor");
    expect(html.match(/Copy agent prompt/g)).toHaveLength(1);
    expect(html).toContain("Show full prompt");
  });
});
