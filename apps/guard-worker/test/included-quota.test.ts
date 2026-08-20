import { describe, expect, it } from "vitest";
import { includedUsagePercent } from "../src/client/components/limits-chart/included-quota";

describe("included usage readout math", () => {
  it("computes empty and partial cycle percentages", () => {
    expect(includedUsagePercent(0, 100)).toBe(0);
    expect(includedUsagePercent(25, 100)).toBe(25);
  });

  it("keeps the exact boundary distinct from billable usage", () => {
    expect(includedUsagePercent(100, 100)).toBe(100);
    expect(includedUsagePercent(101, 100)).toBe(101);
  });

  it("returns no readout when the allotment is unavailable", () => {
    expect(includedUsagePercent(25)).toBeNull();
    expect(includedUsagePercent(25, 0)).toBeNull();
    expect(includedUsagePercent(25, Number.NaN)).toBeNull();
  });
});
