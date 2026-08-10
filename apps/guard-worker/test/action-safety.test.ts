import { describe, expect, it } from "vitest";
import { executableIncidentError } from "../src/index.js";

describe("action execution safety", () => {
  it("requires a fresh, unresolved emergency incident", () => {
    const fresh = { severity: "emergency", status: "open", last_seen: Date.now() };
    expect(executableIncidentError(fresh)).toBeNull();
    expect(executableIncidentError({ ...fresh, severity: "critical" })).toContain("Only an active emergency");
    expect(executableIncidentError({ ...fresh, status: "resolved" })).toContain("resolved");
    expect(executableIncidentError({ ...fresh, last_seen: Date.now() - 31 * 60_000 })).toContain("stale");
    expect(executableIncidentError(null)).toContain("no longer exists");
  });
});
