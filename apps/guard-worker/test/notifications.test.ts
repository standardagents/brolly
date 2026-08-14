import { describe, expect, it } from "vitest";
import { validateNotificationConfig } from "../src/index";

describe("notification configuration", () => {
  it("requires webhook URLs for Discord and Slack", () => {
    expect(validateNotificationConfig("discord", {})).toContain("webhook URL");
    expect(validateNotificationConfig("slack", { url: "https://hooks.slack.com/services/example" })).toBeNull();
    expect(validateNotificationConfig("slack", { url: "https://attacker.example/services/example" })).toContain("hooks.slack.com");
    expect(validateNotificationConfig("discord", { url: "http://discord.com/api/webhooks/1/2" })).toContain("HTTPS");
    expect(validateNotificationConfig("discord", { url: "https://discord.com.evil.example/api/webhooks/1/2" })).toContain("discord.com");
  });

  it("requires every Twilio SMS credential", () => {
    expect(validateNotificationConfig("twilio", { accountSid: "AC1", token: "secret", from: "+15550000000" })).toContain("destination");
    expect(validateNotificationConfig("twilio", { accountSid: "AC1", token: "secret", from: "+15550000000", to: "+15551111111" })).toBeNull();
  });

  it("refuses private generic webhook destinations", () => {
    expect(validateNotificationConfig("webhook", { url: "https://192.168.1.2/hook" })).toContain("private network");
    expect(validateNotificationConfig("webhook", { url: "https://alerts.example.com/hook" })).toBeNull();
  });

  it("never accepts an absent configuration", () => {
    expect(validateNotificationConfig("discord", undefined)).toBe("Notification configuration is required");
  });
});
