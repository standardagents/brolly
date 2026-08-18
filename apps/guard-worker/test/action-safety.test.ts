import { describe, expect, it } from "vitest";
import { executableAlertInstanceError, executableIncidentError } from "../src/index.js";

describe("action execution safety", () => {
  it("requires a fresh, unresolved emergency incident", () => {
    const fresh = { severity: "emergency", status: "open", last_seen: Date.now() };
    expect(executableIncidentError(fresh)).toBeNull();
    expect(executableIncidentError({ ...fresh, severity: "critical" })).toContain("Only an active emergency");
    expect(executableIncidentError({ ...fresh, status: "resolved" })).toContain("resolved");
    expect(executableIncidentError({ ...fresh, last_seen: Date.now() - 31 * 60_000 })).toContain("stale");
    expect(executableIncidentError(null)).toContain("no longer exists");
  });

  it("requires a current, fresh alert instance", () => {
    const now = Date.now();
    const fresh = {
      status: "open", historical: 0, period_end_at: now + 60_000,
      last_breached_at: now, data_quality: "complete",
    };
    expect(executableAlertInstanceError(fresh, now)).toBeNull();
    expect(executableAlertInstanceError({ ...fresh, status: "acknowledged" }, now)).toBeNull();
    expect(executableAlertInstanceError({ ...fresh, status: "expired" }, now)).toContain("inactive");
    expect(executableAlertInstanceError({ ...fresh, historical: 1 }, now)).toContain("inactive");
    expect(executableAlertInstanceError({ ...fresh, data_quality: "stale" }, now)).toContain("unavailable or stale");
    expect(executableAlertInstanceError({ ...fresh, last_breached_at: now - 31 * 60_000 }, now)).toContain("evidence is stale");
    expect(executableAlertInstanceError(null, now)).toContain("no longer exists");
  });
});
