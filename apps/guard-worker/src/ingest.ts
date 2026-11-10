import type { AccumulatorChange } from "./ledger-accumulator.js";
import { reconcileBilling } from "./billing-ledger.js";
import type { CloudflareClient, DurableObjectUsageCursor, DurableObjectUsageResult, ProductUsageResult, WorkerUsageCursor, WorkerUsageResult } from "./cloudflare.js";
import type { Env } from "./env.js";
import { expandUsageObservations, LedgerStore } from "./ledger-store.js";
import { productUsageDefinition, type ProductUsageCollector } from "./product-usage.js";
import type { CoverageResult, LedgerRunBudget, MetricSample, UsageObservation } from "@standardagents/brolly-core";
import { coverageStateFromResults, metricCoverageDataset, saveCoverageIntervals, type CoverageIntervalInput } from "./coverage-intervals.js";

export type UsageCollector = "graphql:durable-objects" | "graphql:workers" | ProductUsageCollector | "billing";

export interface IngestWindowOptions {
  env: Env;
  client: CloudflareClient;
  ledger: LedgerStore;
  collector: UsageCollector;
  startsAt: number;
  endsAt: number;
  cursor?: DurableObjectUsageCursor | WorkerUsageCursor;
  budget: LedgerRunBudget;
  timeZone: string;
  historical?: boolean;
  maxPages?: number;
  persist?: boolean;
}

export interface IngestWindowResult {
  observations: number;
  complete: boolean;
  continuation: DurableObjectUsageCursor | WorkerUsageCursor | null;
  samples: MetricSample[];
  coverage: CoverageResult[];
  changes: AccumulatorChange[];
  watermarkAt: number;
  normalizedObservations?: UsageObservation[];
  coverageIntervals: CoverageIntervalInput[];
}

/** Collects, normalizes, and persists one bounded usage or billing window. */
export async function ingestWindow(options: IngestWindowOptions): Promise<IngestWindowResult> {
  if (options.collector === "billing") {
    const result = await reconcileBilling(
      options.env,
      options.client,
      options.budget,
      options.endsAt,
      { startsAt: options.startsAt, endsAt: options.endsAt, recordGaps: options.historical === true },
    );
    const state = !result.available
      ? "permission_denied"
      : result.error && options.historical ? "delayed"
        : result.complete ? "healthy" : "delayed";
    const coverage = [{
      family: "billing", metric: options.historical ? "initial_import_gaps" : "authoritative_usage", finestScope: "account", state,
      checkedAt: options.endsAt,
      detail: result.error ?? (result.available ? undefined : "Add Billing Read access to reconcile authoritative usage and billing-cycle boundaries"),
    }] satisfies CoverageResult[];
    const coverageIntervals = [interval(options, "billable-usage", coverage)];
    if (options.persist !== false && (!options.historical || result.complete)) {
      await saveCoverageIntervals(options.env.DB, coverageIntervals, options.budget);
    }
    return {
      observations: result.records,
      complete: result.complete,
      continuation: null,
      samples: [],
      coverage,
      coverageIntervals,
      changes: result.alertChanges,
      watermarkAt: options.endsAt,
    };
  }

  const definition = productUsageDefinition(options.collector);
  const result = options.collector === "graphql:durable-objects"
    ? await boundedDurableObjectUsage(options.client, options.startsAt, options.endsAt)
    : options.collector === "graphql:workers"
      ? await options.client.workerUsage(options.startsAt, options.endsAt, {
        cursor: options.cursor as WorkerUsageCursor | undefined,
        maxPages: options.maxPages,
      })
      : definition
        ? await options.client.productUsage(definition, options.startsAt, options.endsAt)
        : unreachableCollector(options.collector);
  const observations = expandUsageObservations(
    result.samples,
    options.collector,
    options.collector === "graphql:durable-objects"
      ? "durable-object-usage"
      : options.collector === "graphql:workers"
        ? "workersInvocationsAdaptive"
        : definition!.datasets.map(item => item.dataset).join("+"),
    result.complete ? "complete" : "partial",
    {
      watermarkAt: result.watermarkAt,
      historical: options.historical ?? false,
    },
  );
  const changes = options.persist === false ? [] : await options.ledger.applyObservations(observations, options.timeZone);
  const coverageIntervals = collectorCoverageIntervals(options, result, definition);
  if (options.persist !== false) await saveCoverageIntervals(options.env.DB, coverageIntervals, options.budget);
  return {
    observations: observations.length,
    complete: result.complete,
    continuation: result.continuation,
    samples: result.samples,
    coverage: result.coverage,
    changes,
    watermarkAt: result.watermarkAt,
    normalizedObservations: observations,
    coverageIntervals,
  };
}

function collectorCoverageIntervals(
  options: IngestWindowOptions,
  result: UsageIngestResult,
  definition: ReturnType<typeof productUsageDefinition>,
): CoverageIntervalInput[] {
  const coverage = result.coverage;
  if (options.collector === "graphql:workers") {
    return coverage.filter(item => item.metric !== "cache_requests")
      .map(item => interval(options, metricCoverageDataset("workersInvocationsAdaptive", item.metric), [item]));
  }
  if (options.collector === "graphql:durable-objects") {
    const sources: Array<[string, string[]]> = [
      ["durableObjectsInvocationsAdaptiveGroups", ["requests", "incoming_websocket_messages"]],
      ["durableObjectsPeriodicGroups", ["duration_gb_seconds", "incoming_websocket_messages", "rows_read", "rows_written", "kv_read_units", "kv_write_units", "kv_delete_requests"]],
      ["durableObjectsSqlStorageGroups", ["sql_storage_bytes"]],
      ["durableObjectsStorageGroups", ["kv_storage_bytes"]],
    ];
    return sources.flatMap(([dataset, metrics]) => coverage.filter(item => metrics.includes(item.metric))
      .map(item => interval(options, metricCoverageDataset(dataset, item.metric), [item])));
  }
  if (!definition) return [];
  if ("datasetCoverage" in result) return result.datasetCoverage.flatMap(item => {
    const source = definition.datasets.find(candidate => candidate.dataset === item.dataset);
    if (!source) return [];
    return source.metrics.flatMap(metric => item.scopeKeys.map(scopeKey => ({
      accountId: options.env.BROLLY_ACCOUNT_ID,
      dataset: metricCoverageDataset(item.dataset, metric.metric),
      scopeKey,
      startsAt: options.startsAt,
      endsAt: options.endsAt,
      state: item.state,
      reason: item.reason,
    })));
  });
  return definition.datasets.flatMap(source => coverage
    .filter(item => source.metrics.some(metric => metric.metric === item.metric))
    .map(item => interval(options, metricCoverageDataset(source.dataset, item.metric), [item])));
}

function interval(options: IngestWindowOptions, dataset: string, coverage: CoverageResult[]): CoverageIntervalInput {
  return {
    accountId: options.env.BROLLY_ACCOUNT_ID,
    dataset,
    startsAt: options.startsAt,
    endsAt: options.endsAt,
    state: coverageStateFromResults(coverage),
    reason: coverage.find(item => item.state !== "healthy")?.detail,
  };
}

async function boundedDurableObjectUsage(client: CloudflareClient, startsAt: number, endsAt: number) {
  const result = await client.durableObjectUsage(startsAt, endsAt, { limit: 10_000 });
  const complete = result.coverage.every(item => item.state === "healthy");
  return {
    ...result,
    continuation: complete ? null : {} as DurableObjectUsageCursor,
    complete,
    pages: 1,
    watermarkAt: endsAt,
  };
}

export type UsageIngestResult = DurableObjectUsageResult | WorkerUsageResult | ProductUsageResult;

function unreachableCollector(collector: string): never {
  throw new Error(`Unsupported usage collector: ${String(collector)}`);
}
