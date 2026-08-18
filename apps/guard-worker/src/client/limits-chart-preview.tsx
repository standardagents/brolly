// TEMPORARY visual preview for the limits chart. Delete after review.
import { useState } from "react";
import { LimitsChartPair, levelColor, type UsageLimitValues } from "./components/limits-chart";
import type { LevelValues } from "./components/limits-chart";

const LEVELS = ["Warn", "Critical", "Emergency", "Shutdown"].map((label, index, all) => ({ id: label.toLowerCase(), label, color: levelColor(index, all.length) }));

export function LimitsChartPreview() {
  const [cost, setCost] = useState<LevelValues>({});
  const [usage, setUsage] = useState<UsageLimitValues>({});
  const [cycleCost, setCycleCost] = useState<LevelValues>({});
  const [cycleUsage, setCycleUsage] = useState<UsageLimitValues>({});
  const [doCost, setDoCost] = useState<LevelValues>({});
  const [doUsage, setDoUsage] = useState<UsageLimitValues>({});
  const [doEnabled, setDoEnabled] = useState<Record<string, boolean>>({});
  const [doCostOn, setDoCostOn] = useState(true);
  const [doCostLevels, setDoCostLevels] = useState<Record<string, boolean>>({});
  const [doUsageLevels, setDoUsageLevels] = useState<Record<string, Record<string, boolean>>>({});
  return (
    <main className="mx-auto max-w-[1180px] p-8 text-ink">
      <h2 className="mb-1 text-[22px]">Daily limits · Durable Objects (6 dimensions)</h2>
      <p className="mb-4 text-[13px] text-muted">Every dimension is a sparkline row with its level values and an on/off switch; the selected row expands into its chart.</p>
      <LimitsChartPair token="session" scope="family:durable_objects" window="day" levels={LEVELS} cost={doCost} onCostChange={setDoCost} usage={doUsage} onUsageChange={setDoUsage}
        usageEnabled={doEnabled} onUsageEnabledChange={setDoEnabled} costEnabled={doCostOn} onCostEnabledChange={setDoCostOn}
        costLevelEnabled={doCostLevels} onCostLevelEnabledChange={setDoCostLevels} usageLevelEnabled={doUsageLevels} onUsageLevelEnabledChange={setDoUsageLevels} />
      <hr className="my-12 border-line" />
      <h2 className="mb-4 text-[22px]">Daily limits · Workers</h2>
      <LimitsChartPair token="session" scope="family:workers" family="workers" window="day" levels={LEVELS} cost={cost} onCostChange={setCost} usage={usage} onUsageChange={setUsage} />
      <h2 className="mt-10 mb-4 text-[22px]">Billing cycle limits · Workers</h2>
      <LimitsChartPair token="session" scope="family:workers" family="workers" window="cycle" levels={LEVELS} cost={cycleCost} onCostChange={setCycleCost} usage={cycleUsage} onUsageChange={setCycleUsage}
        costFloor={cost} usageFloor={usage} />
    </main>
  );
}
