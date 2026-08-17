import { describe, expect, it } from "vitest";
import { INITIAL_USAGE_COLLECTORS, initialIngestionSlicePlan } from "../src/initial-ingestion.js";

describe("initial ingestion slice plan", () => {
  const now = Date.UTC(2026, 7, 17, 12);

  it("creates daily newest-first usage slices within each dataset's available retention", () => {
    const slices = initialIngestionSlicePlan(now, false);
    for (const collector of INITIAL_USAGE_COLLECTORS) {
      const own = slices.filter(slice => slice.collector === collector.collector);
      expect(own).toHaveLength(collector.retentionDays);
      expect(own[0]?.endsAt).toBe(now);
      expect(own.every(slice => slice.endsAt - slice.startsAt <= 86_400_000)).toBe(true);
      expect(own.every((slice, index) => index === 0 || slice.endsAt === own[index - 1]!.startsAt)).toBe(true);
      expect(own.at(-1)?.startsAt).toBe(now - collector.retentionDays * 86_400_000);
    }
  });

  it("adds deterministic, non-overlapping billing slices within the 31-day API limit", () => {
    expect(initialIngestionSlicePlan(now, false).some(slice => slice.collector === "billing")).toBe(false);
    const slices = initialIngestionSlicePlan(now, true);
    const billing = slices.filter(slice => slice.collector === "billing");
    expect(billing).toHaveLength(3);
    expect(billing[0]).toMatchObject({ startsAt: now - 31 * 86_400_000, endsAt: now });
    expect(billing.at(-1)).toMatchObject({ startsAt: now - 90 * 86_400_000 });
    expect(billing.every(slice => slice.endsAt - slice.startsAt <= 31 * 86_400_000)).toBe(true);
    expect(billing.every(slice => slice.startsAt >= now - 90 * 86_400_000 && slice.endsAt <= now)).toBe(true);
    expect(billing.every((slice, index) => index === 0 || slice.endsAt === billing[index - 1]!.startsAt)).toBe(true);
    expect(billing.reduce((duration, slice) => duration + slice.endsAt - slice.startsAt, 0)).toBe(90 * 86_400_000);
    expect(new Set(billing.flatMap(slice => [slice.startsAt, slice.endsAt])).size).toBe(4);
    expect(slices).toHaveLength(initialIngestionSlicePlan(now, false).length + 3);
  });
});
