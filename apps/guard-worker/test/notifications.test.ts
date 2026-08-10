import { describe, expect, it } from "vitest";
import { validateNotificationConfig } from "../src/index";

describe("notification configuration", () => {
  it("requires webhook URLs for Discord and Slack", () => {
    expect(validateNotificationConfig("discord", {})).toContain("webhook URL");
    expect(validateNotificationConfig("slack", { url: "https://hooks.slack.com/services/example" })).toBeNull();
  });

  it("requires every Twilio SMS credential", () => {
    expect(validateNotificationConfig("twilio", { accountSid: "AC1", token: "secret", from: "+15550000000" })).toContain("destination");
    expect(validateNotificationConfig("twilio", { accountSid: "AC1", token: "secret", from: "+15550000000", to: "+15551111111" })).toBeNull();
  });

  it("never accepts an absent configuration", () => {
    expect(validateNotificationConfig("discord", undefined)).toBe("Notification configuration is required");
  });
});
