import { describe, expect, it } from "vitest";
import { resolveEffectiveEntries, type AlertLevel } from "../src/alert-levels.js";
import { alertBillingCycleBounds, alertInstanceCanNotify, alertSeverity, notificationDueAt, selectHighestFiringInstances } from "../src/alert-engine.js";
import { materializedSpendLines } from "../src/policy-migration.js";

function levels(): AlertLevel[] {
  return [
    { id: "warning", label: "Warning", position: 0, entries: [
      { id: "warn-a", levelId: "warning", kind: "channel", targetId: "a", repeatIntervalMs: null, position: 0 },
      { id: "prepare-stop", levelId: "warning", kind: "prepare_stop", targetId: null, repeatIntervalMs: null, position: 1 },
      { id: "prepare-quarantine", levelId: "warning", kind: "prepare_quarantine", targetId: null, repeatIntervalMs: null, position: 2 },
    ] },
    { id: "critical", label: "Critical", position: 1, entries: [
      { id: "critical-a", levelId: "critical", kind: "channel", targetId: "a", repeatIntervalMs: 15 * 60_000, position: 0 },
      { id: "critical-b", levelId: "critical", kind: "channel", targetId: "b", repeatIntervalMs: 5 * 60_000, position: 1 },
      { id: "auto-pause", levelId: "critical", kind: "auto_pause", targetId: null, repeatIntervalMs: null, position: 2 },
      { id: "auto-quarantine", levelId: "critical", kind: "auto_quarantine", targetId: null, repeatIntervalMs: null, position: 3 },
    ] },
    { id: "emergency", label: "Emergency", position: 2, entries: [] },
  ];
}

describe("ledger alert delivery policy", () => {
  it("combines entries from lower positions and keeps the highest channel interval", () => {
    expect(resolveEffectiveEntries(levels(), 1)).toEqual({
      channels: [
        { targetId: "a", repeatIntervalMs: 15 * 60_000 },
        { targetId: "b", repeatIntervalMs: 5 * 60_000 },
      ],
      stopOrPause: "auto",
      quarantine: "auto",
    });
    expect(resolveEffectiveEntries(levels(), 0)).toMatchObject({
      channels: [{ targetId: "a", repeatIntervalMs: null }],
      stopOrPause: "prepare",
      quarantine: "prepare",
    });
  });

  it("schedules repeating channels and leaves a successful Once delivery complete", () => {
    const now = 1_000_000;
    expect(notificationDueAt(null, null, now)).toBe(now);
    expect(notificationDueAt({ ok: true, createdAt: now }, null, now)).toBeNull();
    expect(notificationDueAt({ ok: true, createdAt: now }, 5 * 60_000, now)).toBe(now + 5 * 60_000);
    expect(notificationDueAt({ ok: false, createdAt: now }, null, now)).toBe(now + 15 * 60_000);
  });

  it("stops acknowledged and resolved instances while allowing an unscheduled open instance", () => {
    const now = 10_000;
    expect(alertInstanceCanNotify("open", false, now, now)).toBe(true);
    expect(alertInstanceCanNotify("open", false, null, now)).toBe(true);
    expect(alertInstanceCanNotify("open", true, now, now)).toBe(false);
    expect(alertInstanceCanNotify("acknowledged", false, now, now)).toBe(false);
    expect(alertInstanceCanNotify("resolved", false, now, now)).toBe(false);
    expect(alertInstanceCanNotify("open", false, now + 1, now)).toBe(false);
  });

  it("maps display severity from board position", () => {
    expect(alertSeverity(0, 3)).toBe("warning");
    expect(alertSeverity(1, 3)).toBe("critical");
    expect(alertSeverity(2, 3)).toBe("emergency");
    expect(alertSeverity(0, 2)).toBe("warning");
    expect(alertSeverity(1, 2)).toBe("emergency");
  });

  it("fires only the highest crossed level for one rule, resource, and period", () => {
    const shared = { rule_id: "rule", target_resource_id: "resource", id: "resource", period_start_at: 1, period_end_at: 2 };
    expect(selectHighestFiringInstances([
      { ...shared, priority: 0, label: "Warning" },
      { ...shared, priority: 20, label: "Emergency" },
      { ...shared, priority: 10, label: "Critical" },
      { ...shared, target_resource_id: "other", id: "other", priority: 0, label: "Other warning" },
    ]).map(instance => instance.label)).toEqual(["Emergency", "Other warning"]);
  });

  it("does not materialize a line for a level without a threshold", () => {
    expect(materializedSpendLines({ warning: 5, emergency: 25 }, levels()).map(line => line.levelId))
      .toEqual(["warning", "emergency"]);
  });

  it("uses the billing cycle containing each completed usage interval", () => {
    const cycles = [
      { startsAt: 0, endsAt: 100 },
      { startsAt: 100, endsAt: 200 },
    ];
    const fallback = { startsAt: 100, endsAt: 200 };
    expect(alertBillingCycleBounds(cycles, 99, fallback)).toEqual(cycles[0]);
    expect(alertBillingCycleBounds(cycles, 100, fallback)).toEqual(cycles[1]);
    expect(alertBillingCycleBounds(cycles, 300, fallback)).toEqual(fallback);
  });
});
