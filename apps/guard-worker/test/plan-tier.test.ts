import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestD1, type TestD1 } from "./d1";
import { materializePlanState, readPlanState, saveDetectedPlan, savePlanOverride } from "../src/plan-tier.js";

describe("plan tier state", () => {
  let d1: TestD1;

  beforeEach(() => { d1 = createTestD1(); });
  afterEach(() => d1.close());

  it("starts unknown and exposes API detection as the source", async () => {
    await expect(readPlanState(d1.db)).resolves.toMatchObject({
      planTier: "unknown", planTierSource: "api", detectedTier: "unknown", overrideTier: null,
    });
  });

  it("keeps a manual override ahead of subsequent API detections", async () => {
    await saveDetectedPlan(d1.db, "free", 100);
    await savePlanOverride(d1.db, "paid", 200);
    await saveDetectedPlan(d1.db, "enterprise", 300);
    await expect(readPlanState(d1.db)).resolves.toMatchObject({
      planTier: "paid", planTierSource: "override", detectedTier: "enterprise", overrideTier: "paid", checkedAt: 300,
    });
    await savePlanOverride(d1.db, null, 400);
    await expect(readPlanState(d1.db)).resolves.toMatchObject({ planTier: "enterprise", planTierSource: "api", overrideTier: null });
  });

  it("materializes an explicit unknown override without losing the detected tier", () => {
    expect(materializePlanState({ detectedTier: "paid", overrideTier: "unknown", checkedAt: 1, error: null })).toMatchObject({
      planTier: "unknown", planTierSource: "override", detectedTier: "paid",
    });
  });
});
