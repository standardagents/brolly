/** Pure calculations shared by the included-quota chart readouts. */

/**
 * Percentage of a cycle allotment consumed so far. The result stays numeric
 * so callers can distinguish an exact 100% from a value that has crossed the
 * billable boundary before choosing display copy.
 */
export function includedUsagePercent(cycleToDate: number, includedPerCycle?: number): number | null {
  const included = includedPerCycle;
  if (!(Number.isFinite(cycleToDate) && typeof included === "number" && Number.isFinite(included) && included > 0)) return null;
  return Math.max(0, cycleToDate) / included * 100;
}

/** Alias used by callers that describe the value as a cycle percentage. */
export const cycleIncludedPercent = includedUsagePercent;
