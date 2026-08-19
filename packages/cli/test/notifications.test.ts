import { describe, expect, it } from "vitest";
import { createTargetPayload } from "../src/notifications.js";

describe("notification channel payloads", () => {
  it.each(["twilio", "cloudflare_email", "resend", "postmark"] as const)("accepts a trimmed string destination for %s", kind => {
    expect(createTargetPayload(kind, {
      label: "Primary channel",
      destination: { to: "  destination@example.com  " },
    })).toMatchObject({ kind, destination: { to: "destination@example.com" } });
  });

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

  it.each(["cloudflare_email", "resend", "postmark"] as const)("normalizes multiple email recipients for %s", kind => {
    expect(createTargetPayload(kind, {
      label: "Operations inboxes",
      destination: { to: [" first@example.com ", "SECOND@example.com", "FIRST@example.com", " "] },
    })).toEqual({
      kind,
      label: "Operations inboxes",
      destination: { to: ["first@example.com", "SECOND@example.com"] },
    });
  });

  it("keeps separate channel instances when an account is reused", () => {
    const primary = createTargetPayload("resend", {
      label: "Primary email",
      destination: { to: "primary@example.com" },
    });
    const backup = createTargetPayload("resend", {
      label: "Backup email",
      destination: { to: ["backup@example.com", "finance@example.com"] },
    });

    expect(primary).toEqual({ kind: "resend", label: "Primary email", destination: { to: "primary@example.com" } });
    expect(backup).toEqual({ kind: "resend", label: "Backup email", destination: { to: ["backup@example.com", "finance@example.com"] } });
  });

  it("requires labels and destination values for account-backed channels", () => {
    expect(() => createTargetPayload("resend", { destination: { to: "ops@example.com" } }))
      .toThrow("label is required");
    expect(() => createTargetPayload("postmark", { label: "Ops", destination: {} }))
      .toThrow("destination.to");
    expect(() => createTargetPayload("resend", { label: "Ops", destination: { to: [] } }))
      .toThrow("destination.to");
    expect(createTargetPayload("postmark", { label: "Ops", destination: { to: ["ops@example.com", " "] } }))
      .toEqual({ kind: "postmark", label: "Ops", destination: { to: ["ops@example.com"] } });
    expect(() => createTargetPayload("resend", { label: "Ops", destination: { to: ["ops@example.com", 42] } }))
      .toThrow("destination.to");
    expect(() => createTargetPayload("twilio", { label: "Ops", destination: { to: ["+15551111111"] } }))
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
