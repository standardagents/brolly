import { useState } from "react";
import { LimitsChartPair, levelColor, type LevelValues, type UsageLimitValues } from "./components/limits-chart";
import { RiskToleranceStep } from "./onboarding/RiskToleranceStep";
import { AlertLevelsStep, useAlertLevels } from "./onboarding/levels";
import { ProductLimitsStep } from "./onboarding/ProductLimitsStep";
import { useNotificationTargets } from "./components/notifications";
import type { AlertLevel, Policy } from "./types";

const LEVELS_SPEC = ["Warn", "Critical", "Emergency", "Shutdown"];
const LEVELS = LEVELS_SPEC.map((label, index, all) => ({
  id: label.toLowerCase(),
  label,
  color: levelColor(index, all.length),
}));

const ALERT_LEVELS: AlertLevel[] = LEVELS_SPEC.map((label, index) => ({ id: label.toLowerCase(), position: index, label, entries: [] }));

/** Internal visual QA surface for the editable daily and billing-cycle charts. */
export function LimitsChartPreview() {
  const board = useAlertLevels("session");
  const targets = useNotificationTargets("session");
  const [policy, setPolicy] = useState<Policy>({ version: "preview", accountDailySpend: {}, familyDailySpend: {}, assetDailySpend: {}, thresholds: [] });
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
      <section className="mb-12 max-w-[900px] rounded-panel border border-line bg-panel p-8">
        <AlertLevelsStep token="session" targets={targets} board={board} />
      </section>
      <section className="mb-12 rounded-panel border border-line bg-panel p-8">
        <ProductLimitsStep token="session" policy={policy} levels={ALERT_LEVELS} setPolicy={setPolicy}
          data={{ accountId: "demo", complete: false, policy, families: [
            { family: "workers", label: "Workers", metrics: [], protection: "active" },
            { family: "durable_objects", label: "Durable Objects", metrics: [], protection: "active" },
            { family: "kv", label: "KV", metrics: [], protection: "active" },
            { family: "email", label: "Email", metrics: [], protection: "active" },
          ], scopedAssets: [] }} />
      </section>
      <section className="mb-12 max-w-[900px] rounded-panel border border-line bg-panel p-8">
        <RiskToleranceStep token="session" policy={policy} levels={ALERT_LEVELS} setPolicy={setPolicy} />
      </section>
      <h2 className="mb-1 text-[22px]">Daily limits · Durable Objects (6 dimensions)</h2>
      <p className="mb-4 text-[13px] text-muted">Every dimension is a sparkline row with its level values and an on/off switch. The selected row expands into its chart.</p>
      <LimitsChartPair token="session" scope="family:durable_objects" family="durable_objects" window="day" levels={LEVELS}
        cost={doCost} onCostChange={setDoCost} usage={doUsage} onUsageChange={setDoUsage}
        usageEnabled={doEnabled} onUsageEnabledChange={setDoEnabled} costEnabled={doCostOn} onCostEnabledChange={setDoCostOn}
        costLevelEnabled={doCostLevels} onCostLevelEnabledChange={setDoCostLevels} usageLevelEnabled={doUsageLevels} onUsageLevelEnabledChange={setDoUsageLevels} />
      <hr className="my-12 border-line" />
      <h2 className="mb-4 text-[22px]">Daily limits · Workers</h2>
      <LimitsChartPair token="session" scope="family:workers" family="workers" window="day" levels={LEVELS}
        cost={cost} onCostChange={setCost} usage={usage} onUsageChange={setUsage} />
      <h2 className="mt-10 mb-4 text-[22px]">Billing cycle limits · Workers</h2>
      <LimitsChartPair token="session" scope="family:workers" family="workers" window="cycle" levels={LEVELS}
        cost={cycleCost} onCostChange={setCycleCost} usage={cycleUsage} onUsageChange={setCycleUsage}
        costFloor={cost} usageFloor={usage} />
    </main>
  );
}
