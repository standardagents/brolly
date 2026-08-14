import { describe, expect, it } from "vitest";
import { alertBillingCycleBounds, alertInstanceCanNotify, alertRepeatInterval } from "../src/alert-engine.js";

describe("ledger alert delivery policy", () => {
  it("delivers Warning once and repeats Emergency every six hours by default", () => {
    expect(alertRepeatInterval("Warning", null)).toBeNull();
    expect(alertRepeatInterval("Emergency", null)).toBe(6 * 60 * 60_000);
    expect(alertRepeatInterval("Emergency", 90_000)).toBe(90_000);
  });

  it("excludes historical, inactive, and future-scheduled instances", () => {
    const now = 10_000;
    expect(alertInstanceCanNotify("open", false, now, now)).toBe(true);
    expect(alertInstanceCanNotify("open", true, now, now)).toBe(false);
    expect(alertInstanceCanNotify("silenced", false, now, now)).toBe(false);
    expect(alertInstanceCanNotify("open", false, now + 1, now)).toBe(false);
    expect(alertInstanceCanNotify("open", false, null, now)).toBe(false);
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
