import { useState } from "react";
import { LimitsChartDual, levelColor, type WindowLimits } from "./components/limits-chart";
import { RiskToleranceStep } from "./onboarding/RiskToleranceStep";
import { AlertLevelsStep, useAlertLevels } from "./onboarding/levels";
import { AccountLimitStep } from "./onboarding/LimitSteps";
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
  const [workerDay, setWorkerDay] = useState<WindowLimits>({ cost: {}, usage: {} });
  const [workerCycle, setWorkerCycle] = useState<WindowLimits>({ cost: {}, usage: {} });
  const [workerOpen, setWorkerOpen] = useState<string | null>("cost");
  const [doDay, setDoDay] = useState<WindowLimits>({ cost: {}, usage: {} });
  const [doCycle, setDoCycle] = useState<WindowLimits>({ cost: {}, usage: {} });
  const [doOpen, setDoOpen] = useState<string | null>("cost");

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
            { family: "kv", label: "Workers KV", metrics: [], protection: "active" },
            { family: "d1", label: "D1", metrics: [], protection: "active" },
            { family: "r2", label: "R2", metrics: [], protection: "active" },
            { family: "queues", label: "Queues", metrics: [], protection: "active" },
            { family: "workers_ai", label: "Workers AI", metrics: [], protection: "active" },
            { family: "vectorize", label: "Vectorize", metrics: [], protection: "active" },
          ], scopedAssets: [] }} />
      </section>
      <section className="mb-12 max-w-[900px] rounded-panel border border-line bg-panel p-8">
        <RiskToleranceStep token="session" policy={policy} levels={ALERT_LEVELS} setPolicy={setPolicy} />
      </section>
      <section className="mb-12 rounded-panel border border-line bg-panel p-8">
        <AccountLimitStep token="session" policy={policy} levels={ALERT_LEVELS} setPolicy={setPolicy} />
      </section>
      <h2 className="mb-1 text-[22px]">Limits · Durable Objects</h2>
      <p className="mb-4 text-[13px] text-muted">Every dimension shows daily and billing-cycle values in one row. The selected row expands both charts.</p>
      <LimitsChartDual token="session" scope="family:durable_objects" levels={LEVELS} day={doDay} cycle={doCycle}
        onChange={(window, change) => window === "day" ? setDoDay(change) : setDoCycle(change)} open={doOpen} onOpenChange={setDoOpen} />
      <hr className="my-12 border-line" />
      <h2 className="mb-4 text-[22px]">Limits · Workers</h2>
      <LimitsChartDual token="session" scope="family:workers" levels={LEVELS} day={workerDay} cycle={workerCycle}
        onChange={(window, change) => window === "day" ? setWorkerDay(change) : setWorkerCycle(change)} open={workerOpen} onOpenChange={setWorkerOpen} />
    </main>
  );
}
