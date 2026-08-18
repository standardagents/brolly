import { describe, expect, it } from "vitest";
import { createTargetPayload } from "../src/notifications.js";

describe("notification channel payloads", () => {
  it("keeps first Twilio account credentials separate from its destination", () => {
    expect(createTargetPayload("twilio", {
      label: "Primary SMS",
      provider: { config: { accountSid: "AC123", token: "secret", from: "+15550000000" } },
      destination: { to: "+15551111111" },
    })).toEqual({
      kind: "twilio",
      label: "Primary SMS",
      provider: { config: { accountSid: "AC123", token: "secret", from: "+15550000000" } },
      destination: { to: "+15551111111" },
    });
  });

  it("creates a destination-only payload for a later email channel", () => {
    expect(createTargetPayload("cloudflare_email", {
      label: "Finance inbox",
      destination: { to: "finance@example.com" },
    })).toEqual({
      kind: "cloudflare_email",
      label: "Finance inbox",
      destination: { to: "finance@example.com" },
    });
  });

  it("requires labels and destination values for account-backed channels", () => {
    expect(() => createTargetPayload("resend", { destination: { to: "ops@example.com" } }))
      .toThrow("label is required");
    expect(() => createTargetPayload("postmark", { label: "Ops", destination: {} }))
      .toThrow("destination.to");
  });

  it("keeps generic webhook configuration in the target config", () => {
    expect(createTargetPayload("webhook", { label: "Pager", config: { url: "https://example.com/hook" } }))
      .toEqual({ kind: "webhook", label: "Pager", config: { url: "https://example.com/hook" } });
  });

  it("rejects unknown channel input", () => {
    expect(() => createTargetPayload("email", { label: "Ops", config: {} }))
      .toThrow("Unknown notification channel kind");
  });
});
