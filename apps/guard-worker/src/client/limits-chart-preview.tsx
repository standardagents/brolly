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
  return (
    <main className="mx-auto max-w-[1180px] p-8 text-ink">
      <h2 className="mb-4 text-[22px]">Daily limits · Workers</h2>
      <LimitsChartPair token="session" scope="family:workers" window="day" levels={LEVELS} cost={cost} onCostChange={setCost} usage={usage} onUsageChange={setUsage} />
      <h2 className="mt-10 mb-4 text-[22px]">Billing cycle limits · Workers</h2>
      <LimitsChartPair token="session" scope="family:workers" window="cycle" levels={LEVELS} cost={cycleCost} onCostChange={setCycleCost} usage={cycleUsage} onUsageChange={setCycleUsage}
        costFloor={cost} usageFloor={usage} />
    </main>
  );
}
