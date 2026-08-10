import { describe, expect, it } from "vitest";
import type { Incident } from "@standardagents/brolly-core";
import { confirmedAutomaticEmergency } from "../src/monitor.js";

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "incident-1",
    key: `account:durable_objects:${"a".repeat(64)}:rows_read:300000`,
    asset: {
      accountId: "account",
      family: "durable_objects",
      id: "a".repeat(64),
      parentId: "namespace",
      scope: "object",
      tier: "standard",
      tags: { brollyFuse: "true", cloudflareWorkerScript: "chat-worker" },
    },
    metric: "rows_read",
    severity: "emergency",
    observed: 5_000_000,
    reason: "threshold",
    action: "stop",
    status: "open",
    firstSeen: 1_000,
    lastSeen: 301_000,
    occurrences: 2,
    ...overrides,
  };
}

describe("automatic quarantine confirmation", () => {
  it("requires a second nearby emergency observation", () => {
    const current = incident();
    expect(confirmedAutomaticEmergency(undefined, current)).toBe(false);
    expect(confirmedAutomaticEmergency(incident({ lastSeen: 1_000, occurrences: 1 }), current)).toBe(true);
    expect(confirmedAutomaticEmergency(incident({ lastSeen: current.lastSeen - 8 * 60_000, occurrences: 1 }), current)).toBe(false);
  });

  it("refuses projected spend and namespace-wide automatic actions", () => {
    const current = incident();
    const previous = incident({ lastSeen: 1_000, occurrences: 1 });
    expect(confirmedAutomaticEmergency(previous, { ...current, metric: "projected_daily_cost_usd" })).toBe(false);
    expect(confirmedAutomaticEmergency(previous, { ...current, asset: { ...current.asset, id: "namespace", scope: "namespace" } })).toBe(false);
  });
});
