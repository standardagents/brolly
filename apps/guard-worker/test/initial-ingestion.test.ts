import { describe, expect, it } from "vitest";
import { initialIngestionSlicePlan } from "../src/initial-ingestion.js";

describe("initial ingestion slice plan", () => {
  const now = Date.UTC(2026, 7, 17, 12);

  it("keeps each usage collector within three newest-first 32-day slices", () => {
    const slices = initialIngestionSlicePlan(now, false);
    for (const collector of ["graphql:durable-objects", "graphql:workers"]) {
      const own = slices.filter(slice => slice.collector === collector);
      expect(own).toHaveLength(3);
      expect(own[0]?.endsAt).toBe(now);
      expect(own.every(slice => slice.endsAt - slice.startsAt <= 32 * 86_400_000)).toBe(true);
      expect(own[0]!.startsAt).toBe(own[1]!.endsAt);
      expect(own[1]!.startsAt).toBe(own[2]!.endsAt);
    }
  });

  it("adds one billing slice only when Billing Read is configured", () => {
    expect(initialIngestionSlicePlan(now, false).some(slice => slice.collector === "billing")).toBe(false);
    const slices = initialIngestionSlicePlan(now, true);
    const billing = slices.find(slice => slice.collector === "billing");
    expect(billing).toMatchObject({ startsAt: now - 90 * 86_400_000, endsAt: now });
    expect(slices).toHaveLength(7);
  });
});
