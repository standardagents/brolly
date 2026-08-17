import type { AccumulatorChange } from "./ledger-accumulator.js";
import { reconcileBilling } from "./billing-ledger.js";
import type { CloudflareClient, DurableObjectUsageCursor, DurableObjectUsageResult, WorkerUsageCursor, WorkerUsageResult } from "./cloudflare.js";
import type { Env } from "./env.js";
import { expandUsageObservations, LedgerStore } from "./ledger-store.js";
import type { CoverageResult, LedgerRunBudget, MetricSample, UsageObservation } from "@standardagents/brolly-core";

export type UsageCollector = "graphql:durable-objects" | "graphql:workers" | "billing";

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
    return {
      observations: result.records,
      complete: result.complete,
      continuation: null,
      samples: [],
      coverage: [{
        family: "billing", metric: options.historical ? "initial_import_gaps" : "authoritative_usage", finestScope: "account", state,
        checkedAt: options.endsAt,
        detail: result.error ?? (result.available ? undefined : "Add Billing Read access to reconcile authoritative usage and billing-cycle boundaries"),
      }],
      changes: result.alertChanges,
      watermarkAt: options.endsAt,
    };
  }

  const result = options.collector === "graphql:durable-objects"
    ? await options.client.durableObjectUsagePaged(options.startsAt, options.endsAt, {
      cursor: options.cursor as DurableObjectUsageCursor | undefined,
      maxPages: options.maxPages,
    })
    : await options.client.workerUsage(options.startsAt, options.endsAt, {
      cursor: options.cursor as WorkerUsageCursor | undefined,
      maxPages: options.maxPages,
    });
  const observations = expandUsageObservations(
    result.samples,
    options.collector,
    options.collector === "graphql:durable-objects" ? "durable-object-usage" : "workersInvocationsAdaptive",
    result.complete ? "complete" : "partial",
    {
      watermarkAt: result.watermarkAt,
      historical: options.historical ?? false,
    },
  );
  const changes = options.persist === false ? [] : await options.ledger.applyObservations(observations, options.timeZone);
  return {
    observations: observations.length,
    complete: result.complete,
    continuation: result.continuation,
    samples: result.samples,
    coverage: result.coverage,
    changes,
    watermarkAt: result.watermarkAt,
    normalizedObservations: observations,
  };
}

export type UsageIngestResult = DurableObjectUsageResult | WorkerUsageResult;
