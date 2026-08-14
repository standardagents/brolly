import { describe, expect, it } from "vitest";
import { collectorWindow, windowContinuation } from "../src/monitor.js";

describe("fixed collector windows", () => {
  it("keeps a persisted continuation bound to its original interval", () => {
    const stored = { startAt: 1_000, endAt: 301_000, cursor: { after: "object-10000" } };
    expect(collectorWindow(stored, 601_000, 901_000)).toEqual(stored);
    expect(windowContinuation(stored, { after: "object-20000" }, 901_000)).toEqual({
      startAt: 1_000, endAt: 301_000, cursor: { after: "object-20000" },
    });
  });

  it("advances a completed catch-up window by one fixed interval", () => {
    const window = { startAt: 1_000, endAt: 301_000 };
    expect(windowContinuation(window, null, 901_000)).toEqual({ startAt: 301_000, endAt: 601_000 });
    expect(windowContinuation({ startAt: 601_000, endAt: 901_000 }, null, 901_000)).toBeNull();
  });

  it("replaces corrupt persisted bounds with the aligned fallback", () => {
    expect(collectorWindow({ startAt: 10, endAt: 10, cursor: "bad" }, 1_000, 301_000))
      .toEqual({ startAt: 1_000, endAt: 301_000 });
  });
});
