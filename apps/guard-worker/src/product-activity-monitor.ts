import {
  LedgerBudgetExceededError,
  MonitoringBudgetExceededError,
  type LedgerRunBudget,
} from "@standardagents/brolly-core";
import type { CloudflareClient } from "./cloudflare.js";
import { metricCoverageDataset, saveCoverageIntervals } from "./coverage-intervals.js";
import type { Env } from "./env.js";
import { HISTORICAL_DATASETS, isHistoricalRateLimitError } from "./historical-analytics.js";
import { expandUsageObservations, type LedgerStore } from "./ledger-store.js";

const STATE_KEY = "product_activity_monitor_v1";
const PROBES_PER_RUN = 10;
const ACTIVE_DATASETS_PER_RUN = 4;
const MIN_QUERY_INTERVAL_MS = 1_200;
const FAILURE_BACKOFF_MS = [10 * 60_000, 30 * 60_000] as const;

interface ProductActivityFailure {
  count: number;
  nextEligibleAt: number;
  detail: string;
}

interface ProductActivityState {
  version: 1;
  probeCursor: number;
  activeCursor: number;
  activeDatasets: string[];
  failures: Record<string, ProductActivityFailure>;
  pauseUntil: number | null;
}

interface ProductActivityResult {
  changes: Awaited<ReturnType<LedgerStore["applyObservations"]>>;
  samples: number;
}

/**
 * Rotate cheap aggregate probes across inactive product datasets. A positive
 * probe promotes that dataset to bounded detailed collection on later monitor
 * runs. This keeps newly used products discoverable without repeatedly
 * backfilling inactive products.
 */
export async function monitorProductActivity(
  env: Env,
  client: CloudflareClient,
  ledger: LedgerStore,
  budget: LedgerRunBudget,
  timeZone: string,
  startsAt: number,
  endsAt: number,
): Promise<ProductActivityResult> {
  const specs = HISTORICAL_DATASETS
    .filter(spec => spec.kind === "product" && spec.root === "account" && !spec.fallbackFor)
    .sort((left, right) => left.dataset.localeCompare(right.dataset));
  const state = await loadState(env.DB, budget);
  const validDatasets = new Set(specs.map(spec => spec.dataset));
  const active = new Set(state.activeDatasets.filter(dataset => validDatasets.has(dataset)));
  const now = Date.now();
  if ((state.pauseUntil ?? 0) > now) return { changes: [], samples: 0 };
  const eligible = (dataset: string) => (state.failures[dataset]?.nextEligibleAt ?? 0) <= now;
  const inactiveSpecs = specs.filter(spec => !active.has(spec.dataset) && eligible(spec.dataset));
  const activeSpecs = specs.filter(spec => active.has(spec.dataset) && eligible(spec.dataset));
  const probes = rotatingSlice(inactiveSpecs, state.probeCursor, PROBES_PER_RUN);
  const detailed = rotatingSlice(activeSpecs, state.activeCursor, ACTIVE_DATASETS_PER_RUN);
  const changes: ProductActivityResult["changes"] = [];
  let samples = 0;
  let queried = 0;

  for (const target of [
    ...probes.map(spec => ({ spec, probe: true })),
    ...detailed.map(spec => ({ spec, probe: false })),
  ]) {
    if (budget.remaining("graphqlQueries") < 1 || budget.remaining("wallMs") < 8_000) break;
    if (queried > 0) await new Promise(resolve => setTimeout(resolve, MIN_QUERY_INTERVAL_MS));
    try {
      const result = await client.historicalUsage({
        dataset: target.spec.dataset,
        startsAt,
        endsAt,
        maxPageSize: target.probe ? 1 : 10_000,
        activityProbe: target.probe,
      });
      queried += 1;
      await saveProductCoverage(env, budget, result, startsAt, endsAt);
      const coverageAvailable = result.coverage.some(item => item.state === "healthy" || item.state === "delayed");
      if (!coverageAvailable) {
        recordFailure(state, target.spec.dataset, result.coverage[0]?.detail ?? "Cloudflare returned no usable metric coverage.");
        continue;
      }
      delete state.failures[target.spec.dataset];
      if (target.probe) {
        if (!result.complete || result.samples.some(sample => Math.abs(sample.value) > 0)) {
          active.add(target.spec.dataset);
          console.info("brolly.product_activity_detected", JSON.stringify({ dataset: target.spec.dataset }));
        }
        continue;
      }
      const observations = expandUsageObservations(
        result.samples,
        result.collector,
        result.dataset,
        result.complete ? "complete" : "partial",
        { watermarkAt: endsAt },
      );
      changes.push(...await ledger.applyObservations(observations, timeZone));
      samples += result.samples.length;
    } catch (error) {
      queried += 1;
      if (error instanceof LedgerBudgetExceededError || error instanceof MonitoringBudgetExceededError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      recordFailure(state, target.spec.dataset, detail);
      if (isHistoricalRateLimitError(error)) {
        state.pauseUntil = Math.max(state.pauseUntil ?? 0, error.retryAt);
        await saveState(env.DB, budget, { ...state, activeDatasets: [...active].sort() });
        throw error;
      }
      console.warn("brolly.product_activity_probe_failed", JSON.stringify({
        dataset: target.spec.dataset,
        detail,
      }));
    }
  }

  await saveState(env.DB, budget, {
    version: 1,
    probeCursor: advanceCursor(state.probeCursor, probes.length, inactiveSpecs.length),
    activeCursor: advanceCursor(state.activeCursor, detailed.length, activeSpecs.length),
    activeDatasets: [...active].sort(),
    failures: state.failures,
    pauseUntil: null,
  });
  return { changes, samples };
}

async function saveProductCoverage(
  env: Env,
  budget: LedgerRunBudget,
  result: Awaited<ReturnType<CloudflareClient["historicalUsage"]>>,
  startsAt: number,
  endsAt: number,
): Promise<void> {
  await saveCoverageIntervals(env.DB, result.coverage.map(item => ({
    accountId: env.BROLLY_ACCOUNT_ID,
    dataset: metricCoverageDataset(result.dataset, item.metric),
    startsAt,
    endsAt,
    state: item.state === "healthy" ? "measured" as const
      : item.state === "delayed" ? "partial" as const : "unavailable" as const,
    reason: item.detail,
  })), budget);
}

function rotatingSlice<T>(values: T[], cursor: number, limit: number): T[] {
  if (!values.length) return [];
  return Array.from({ length: Math.min(limit, values.length) }, (_, index) => values[(cursor + index) % values.length]!);
}

function advanceCursor(cursor: number, amount: number, length: number): number {
  return length > 0 ? (cursor + amount) % length : 0;
}

async function loadState(db: D1Database, budget: LedgerRunBudget): Promise<ProductActivityState> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`).bind(STATE_KEY).first<{ value: string }>();
  budget.charge("d1RowsRead", row ? 1 : 0);
  if (!row) return emptyState();
  try {
    const parsed = JSON.parse(row.value) as Partial<ProductActivityState>;
    return {
      version: 1,
      probeCursor: Number.isFinite(parsed.probeCursor) ? Math.max(0, Math.floor(parsed.probeCursor!)) : 0,
      activeCursor: Number.isFinite(parsed.activeCursor) ? Math.max(0, Math.floor(parsed.activeCursor!)) : 0,
      activeDatasets: Array.isArray(parsed.activeDatasets)
        ? parsed.activeDatasets.filter(value => typeof value === "string")
        : [],
      failures: parseFailures(parsed.failures),
      pauseUntil: Number.isFinite(parsed.pauseUntil) ? Math.max(0, Number(parsed.pauseUntil)) : null,
    };
  } catch {
    return emptyState();
  }
}

function emptyState(): ProductActivityState {
  return { version: 1, probeCursor: 0, activeCursor: 0, activeDatasets: [], failures: {}, pauseUntil: null };
}

function parseFailures(value: unknown): Record<string, ProductActivityFailure> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([dataset, candidate]) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const parsed = candidate as Partial<ProductActivityFailure>;
    if (!Number.isFinite(parsed.count) || !Number.isFinite(parsed.nextEligibleAt)) return [];
    return [[dataset, {
      count: Math.max(1, Math.floor(Number(parsed.count))),
      nextEligibleAt: Math.max(0, Number(parsed.nextEligibleAt)),
      detail: typeof parsed.detail === "string" ? parsed.detail : "Cloudflare dataset query failed.",
    }]];
  }));
}

function recordFailure(state: ProductActivityState, dataset: string, detail: string): void {
  const count = Math.min(FAILURE_BACKOFF_MS.length, (state.failures[dataset]?.count ?? 0) + 1);
  state.failures[dataset] = {
    count,
    nextEligibleAt: Date.now() + FAILURE_BACKOFF_MS[count - 1]!,
    detail: detail.slice(0, 1_000),
  };
}

async function saveState(db: D1Database, budget: LedgerRunBudget, state: ProductActivityState): Promise<void> {
  const result = await db.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).bind(STATE_KEY, JSON.stringify(state), Date.now()).run();
  budget.charge("d1RowsWritten", Number(result.meta.rows_written ?? result.meta.changes ?? 0));
}
