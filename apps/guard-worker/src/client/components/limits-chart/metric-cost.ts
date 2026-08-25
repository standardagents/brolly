import { ESTIMATED_BILLABLE_GROSS_RATES } from "../../../estimated-billable-cost";
import type { PlanTier } from "../../types";

/**
 * List-rate price per unit for a directly billed meter, or undefined when no
 * estimate is supported: free and Enterprise plans have no list-rate model,
 * and billed-via meters are priced at their pool, not per own unit.
 */
export function unitRateUsd(metricId: string, planTier: PlanTier | undefined, billedVia?: unknown): number | undefined {
  if (planTier === "free" || planTier === "enterprise") return undefined;
  if (billedVia) return undefined;
  return ESTIMATED_BILLABLE_GROSS_RATES[metricId];
}
