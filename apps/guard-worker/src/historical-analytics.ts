import {
  METRIC_CATALOG,
  productMetricContract,
  type AssetRef,
  type BoundedRunContext,
  type CollectorCoverage,
  type CoverageResult,
  type LedgerRunBudget,
  type MetricSample,
} from "@standardagents/brolly-core";
import type { Env } from "./env.js";
import { operationalToken } from "./credentials.js";
import {
  PRODUCT_USAGE_DEFINITIONS,
  accountZoneProductDatasetVariables,
  buildAccountZoneProductDatasetQuery,
  buildProductDatasetQuery,
  normalizeProductDataset,
  projectProductDataset,
  productDatasetVariables,
  type ProductDatasetDefinition,
  type ProductUsageDefinition,
} from "./product-usage.js";

const API = "https://api.cloudflare.com/client/v4";
const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ZONE_BATCH = 10;
const SETTINGS_BATCH = 12;

export type HistoricalRateScope = { kind: "account" } | { kind: "zone"; zoneId: string };

export interface HistoricalRateObservation {
  cost: number;
  remaining: number;
  requestedAt: number;
  observedAt: number;
  budgetKey: string;
  pageSize: number | null;
}

export interface HistoricalRateBudget {
  admit(
    scope: HistoricalRateScope,
    logicalQueries: number,
    budgetKey: string,
    pageSize?: number,
    zoneIds?: readonly string[],
    rangeDays?: number,
  ): Promise<void>;
  observe?(scope: HistoricalRateScope, logicalQueries: number, observation: HistoricalRateObservation): void;
  pauseUntil(retryAt: number, scope: HistoricalRateScope | null): void;
}

export interface HistoricalAnalyticsOptions {
  accountBasedRateLimit?: boolean;
  rateBudget?: HistoricalRateBudget;
}

export interface HistoricalCapabilityDiscoveryOptions {
  seed?: readonly HistoricalDatasetCapability[];
  onProgress?: (capabilities: readonly HistoricalDatasetCapability[]) => Promise<void> | void;
}

export interface HistoricalRateLimitTelemetry {
  occurredAt: number;
  status: number;
  scopeKind: HistoricalRateScope["kind"];
  logicalQueries: number;
  accountBasedRequested: boolean;
  retryAfter: string | null;
  rateLimit: string | null;
  rateLimitPolicy: string | null;
  limiterScope: HistoricalRateScope["kind"] | "shared";
  rayId: string | null;
}

type HistoricalDatasetKind = "workers" | "durable_invocations" | "durable_periodic" | "durable_sql_storage" | "durable_kv_storage" | "product";

export interface HistoricalDatasetSpec {
  collector: string;
  label: string;
  dataset: string;
  family: string;
  root: "account" | "zone";
  scope: AssetRef["scope"];
  retentionDays: number;
  kind: HistoricalDatasetKind;
  product?: ProductUsageDefinition;
  source?: ProductDatasetDefinition;
  fallbackFor?: string;
}

export interface HistoricalDatasetCapability {
  collector: string;
  label: string;
  dataset: string;
  family: string;
  root: "account" | "zone";
  zoneId: string | null;
  applicable: boolean;
  enabled: boolean;
  maxDurationSeconds: number;
  notOlderThanSeconds: number;
  maxPageSize: number;
  availableFields?: string[];
  state: CoverageResult["state"];
  detail: string;
}

export interface HistoricalUsageRequest {
  dataset: string;
  /** Keep quota observations isolated when the same dataset uses a different query shape. */
  budgetKey?: string;
  startsAt: number;
  endsAt: number;
  maxPageSize: number;
  availableFields?: string[];
  zoneIds?: string[];
  /** Use a one-row, dimension-free aggregate to determine whether detailed history exists. */
  activityProbe?: boolean;
}

export interface HistoricalUsageResult {
  collector: string;
  dataset: string;
  samples: MetricSample[];
  coverage: CoverageResult[];
  complete: boolean;
  rows: number;
  zoneGaps?: Array<{ zoneId: string; state: CoverageResult["state"]; detail: string; retryAt?: number }>;
}

function requestRangeDays(request: Pick<HistoricalUsageRequest, "startsAt" | "endsAt">): number {
  return Math.max(1, Math.ceil((request.endsAt - request.startsAt) / DAY_MS));
}

interface DatasetSetting {
  enabled?: boolean;
  maxDuration?: number;
  maxPageSize?: number;
  notOlderThan?: number;
  availableFields?: string[];
}

interface GraphqlPayload<T> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

const SPECIAL_DATASETS: HistoricalDatasetSpec[] = [
  special("graphql:durable-objects", "Durable Objects", "durableObjectsInvocationsAdaptiveGroups", "durable_objects", "object", "durable_invocations"),
  special("graphql:durable-objects", "Durable Objects", "durableObjectsPeriodicGroups", "durable_objects", "object", "durable_periodic"),
  special("graphql:durable-objects", "Durable Objects", "durableObjectsSqlStorageGroups", "durable_objects", "namespace", "durable_sql_storage"),
  special("graphql:durable-objects", "Durable Objects", "durableObjectsStorageGroups", "durable_objects", "account", "durable_kv_storage"),
  special("graphql:workers", "Workers", "workersInvocationsAdaptive", "workers", "resource", "workers"),
];

const PRODUCT_DATASETS = PRODUCT_USAGE_DEFINITIONS.flatMap(product => product.datasets
  .filter(source => source.metrics.some(metric => productMetricContract(`${product.family}:${metric.metric}`)?.productLimit === true))
  .map(source => ({
  collector: product.collector,
  label: product.label,
  dataset: source.dataset,
  family: product.family,
  root: source.root ?? "account",
  scope: source.root === "zone" ? "zone" as const : source.resourceDimension ? product.scope : "account" as const,
  retentionDays: product.retentionDays,
  kind: "product" as const,
  product,
  source: {
    ...source,
    metrics: source.metrics.filter(metric => productMetricContract(`${product.family}:${metric.metric}`)?.productLimit === true),
  },
  fallbackFor: source.fallbackFor,
})));

export const HISTORICAL_DATASETS: readonly HistoricalDatasetSpec[] = [...SPECIAL_DATASETS, ...PRODUCT_DATASETS];
const DATASET_BY_NAME = new Map(HISTORICAL_DATASETS.map(item => [item.dataset, item]));

/** Cloudflare Analytics discovery and daily-bucket historical reads. */
export class HistoricalAnalyticsClient {
  private tokenPromise: Promise<string> | null = null;

  constructor(
    private readonly env: Env,
    private readonly budget: BoundedRunContext,
    private readonly ledgerBudget?: LedgerRunBudget,
    private readonly tokenProvider: () => Promise<string> = () => operationalToken(env),
    private readonly zoneProvider?: () => Promise<string[]>,
    private readonly options: HistoricalAnalyticsOptions = {},
  ) {}

  async discoverCapabilities(options: HistoricalCapabilityDiscoveryOptions = {}): Promise<HistoricalDatasetCapability[]> {
    const account = HISTORICAL_DATASETS.filter(item => item.root === "account" && !item.fallbackFor);
    const zones = HISTORICAL_DATASETS.filter(item => item.root === "zone" && !item.fallbackFor);
    const fallbacks = HISTORICAL_DATASETS.filter(item => item.root === "zone" && item.fallbackFor);
    const capabilities: HistoricalDatasetCapability[] = [];
    const publish = async (values: readonly HistoricalDatasetCapability[]): Promise<void> => {
      for (const value of values) {
        const index = capabilities.findIndex(item => item.dataset === value.dataset && item.zoneId === value.zoneId);
        if (index >= 0) capabilities[index] = value;
        else capabilities.push(value);
      }
      await options.onProgress?.([...capabilities]);
    };
    await publish(options.seed ?? []);
    for (let offset = 0; offset < account.length; offset += SETTINGS_BATCH) {
      const batch = account.slice(offset, offset + SETTINGS_BATCH).filter(spec => !hasCapability(capabilities, spec.dataset, null));
      if (!batch.length) continue;
      await this.accountSettingsIsolated(batch, publish);
    }

    let zoneIds: string[];
    try {
      zoneIds = this.zoneProvider ? await this.zoneProvider() : await this.listZoneIds();
    } catch (error) {
      if (isBudgetError(error)) throw error;
      await publish(zones.map(spec => unavailableCapability(spec, null, errorMessage(error))));
      return capabilities;
    }
    if (!zoneIds.length) {
      await publish(zones.map(spec => ({
        ...unavailableCapability(spec, null, "The connected account has no zones."),
        applicable: false,
        state: "healthy" as const,
      })));
      return capabilities;
    }
    const activeZones = new Set(zoneIds);
    for (let index = capabilities.length - 1; index >= 0; index -= 1) {
      const zoneId = capabilities[index]?.zoneId;
      if (zoneId && !activeZones.has(zoneId)) capabilities.splice(index, 1);
    }
    const settingsBatchSize = MAX_ZONE_BATCH;
    const zoneBatches = Array.from(
      { length: Math.ceil(zoneIds.length / settingsBatchSize) },
      (_, index) => zoneIds.slice(index * settingsBatchSize, (index + 1) * settingsBatchSize),
    );
    for (const batch of zoneBatches) {
      const missing = zones.filter(spec => batch.some(zoneId => !hasCapability(capabilities, spec.dataset, zoneId)));
      if (missing.length) await this.zoneSettings(missing, batch, publish);
    }

    for (const fallback of fallbacks) {
      const missingZones = zoneIds.filter(zoneId => {
        const preferred = capabilities.find(item => item.dataset === fallback.fallbackFor && item.zoneId === zoneId);
        return preferred && !preferred.enabled && !hasCapability(capabilities, fallback.dataset, zoneId);
      });
      for (let offset = 0; offset < missingZones.length; offset += MAX_ZONE_BATCH) {
        await this.zoneSettings([fallback], missingZones.slice(offset, offset + MAX_ZONE_BATCH), publish);
      }
    }
    return capabilities;
  }

  async collectorCapabilities(): Promise<CollectorCoverage[]> {
    const discovered = await this.discoverCapabilities();
    return collectorCoverageFromCapabilities(this.env.BROLLY_ACCOUNT_ID, discovered, Date.now());
  }

  async zoneIds(): Promise<string[]> {
    return this.zoneProvider ? this.zoneProvider() : this.listZoneIds();
  }

  async collect(request: HistoricalUsageRequest): Promise<HistoricalUsageResult> {
    const spec = DATASET_BY_NAME.get(request.dataset);
    if (!spec) throw new Error(`Unknown historical Analytics dataset ${request.dataset}`);
    const limit = historicalQueryPageSize(request);
    if (spec.kind === "product") return this.collectProduct(spec, request, limit);
    const query = specialQuery(spec, limit);
    const variables = {
      account: this.env.BROLLY_ACCOUNT_ID,
      since: new Date(request.startsAt).toISOString(),
      until: new Date(request.endsAt).toISOString(),
    };
    const payload = await this.graphql<{ viewer?: { accounts?: Array<Record<string, unknown>> } }>(query, variables, 1, { kind: "account" }, request.budgetKey ?? request.dataset, limit, requestRangeDays(request));
    const account = payload.viewer?.accounts?.[0];
    const rows = arrayValue(account?.[spec.dataset]);
    const samples = normalizeSpecial(spec, rows, this.env, request.startsAt, request.endsAt);
    return {
      collector: spec.collector,
      dataset: spec.dataset,
      samples,
      coverage: specialCoverage(spec, rows, rows.length >= limit, account !== undefined),
      complete: rows.length < limit,
      rows: rows.length,
    };
  }

  private async collectProduct(spec: HistoricalDatasetSpec, request: HistoricalUsageRequest, limit: number): Promise<HistoricalUsageResult> {
    const product = spec.product!;
    const configuredSource = spec.source!;
    const source = projectProductDataset(configuredSource, request.availableFields);
    const unavailableMetrics = configuredSource.metrics.filter(metric => !source.metrics.some(candidate => candidate.metric === metric.metric));
    if (!source.metrics.length) throw new Error(`${source.dataset} exposes none of the fields required by Brolly's metric contract`);
    const zoneIds = source.root === "zone" ? request.zoneIds ?? [] : [];
    if (source.root === "zone" && !zoneIds.length) throw new Error(`${source.dataset} requires at least one authorized zone`);
    const failedZones: Array<{ zoneId: string; state: CoverageResult["state"]; detail: string; retryAt?: number }> = [];
    let roots: Array<Record<string, unknown>>;
    if (source.root === "zone") {
      const isolated = await this.collectProductZones(spec, source, request, limit, zoneIds);
      roots = isolated.roots;
      failedZones.push(...isolated.failed);
    } else {
      const payload = await this.graphql<{ viewer?: { accounts?: Array<Record<string, unknown>> } }>(
        buildProductDatasetQuery(product, source, limit, request.activityProbe === true),
        productDatasetVariables(source, this.env.BROLLY_ACCOUNT_ID, request.startsAt, request.endsAt, []),
        1,
        { kind: "account" },
        request.budgetKey ?? source.dataset,
        limit,
        requestRangeDays(request),
      );
      roots = payload.viewer?.accounts ?? [];
    }
    if (source.root === "zone") {
      const returned = new Set(roots.flatMap(root => stringValue(root.zoneTag) ? [stringValue(root.zoneTag)!] : []));
      for (const zoneId of zoneIds) if (!returned.has(zoneId) && !failedZones.some(item => item.zoneId === zoneId)) {
        failedZones.push({ zoneId, state: "unavailable", detail: "Cloudflare did not return this zone in the Analytics response." });
      }
    }
    const rows = roots.reduce((count, root) => count + arrayValue(root[source.alias]).length, 0);
    const truncated = roots.some(root => arrayValue(root[source.alias]).length >= limit);
    // A successful query with no rows is measured zero for the requested
    // interval. Field-level evidence is required only when Cloudflare returns
    // rows, because rows that omit a requested aggregate indicate a schema or
    // response-shape mismatch rather than zero usage.
    const missingAccountRoot = source.root !== "zone" && roots.length === 0;
    const responseMissingMetrics = rows > 0
      ? source.metrics.filter(metric => !productMetricHasResponseEvidence(source, metric, roots))
      : [];
    const responseMissingMetricIds = new Set(responseMissingMetrics.map(metric => metric.metric));
    const failedDetail = failedZones.length
      ? failedZones.map(item => `${item.zoneId}: ${item.detail}`).join("; ")
      : undefined;
    return {
      collector: spec.collector,
      dataset: spec.dataset,
      samples: normalizeProductDataset(product, source, roots, this.env.BROLLY_ACCOUNT_ID, request.startsAt, request.endsAt),
      coverage: [
        ...source.metrics.map((item): CoverageResult => ({
        family: product.family,
        metric: item.metric,
        finestScope: source.root === "zone" ? "zone" : source.resourceDimension ? product.scope : "account",
        state: missingAccountRoot
          ? "unavailable"
          : responseMissingMetricIds.has(item.metric)
          ? "unavailable"
          : failedZones.length
          ? failedZones.some(item => item.state === "permission_denied")
            ? "permission_denied"
            : failedZones.some(item => item.state === "delayed") ? "delayed" : "unavailable"
          : truncated ? "delayed" : "healthy",
        checkedAt: Date.now(),
        detail: missingAccountRoot
          ? `Cloudflare did not return the connected account for ${source.dataset}.`
          : responseMissingMetricIds.has(item.metric)
          ? `${source.dataset} returned rows without the aggregate field required for ${product.family}:${item.metric}.`
          : failedDetail ?? (truncated ? `${source.dataset} reached its bounded ${limit}-row range limit` : undefined),
        })),
        ...unavailableMetrics.map(item => ({
          family: product.family,
          metric: item.metric,
          finestScope: source.root === "zone" ? "zone" as const : source.resourceDimension ? product.scope : "account" as const,
          state: "unavailable" as const,
          checkedAt: Date.now(),
          detail: `${source.dataset} does not expose the required aggregate field in this account's live GraphQL schema.`,
        })),
      ],
      complete: !truncated && failedZones.length === 0,
      rows,
      zoneGaps: failedZones.length ? failedZones : undefined,
    };
  }

  private async collectProductZones(
    spec: HistoricalDatasetSpec,
    source: ProductDatasetDefinition,
    request: HistoricalUsageRequest,
    limit: number,
    zoneIds: string[],
  ): Promise<{ roots: Array<Record<string, unknown>>; failed: Array<{ zoneId: string; state: CoverageResult["state"]; detail: string; retryAt?: number }> }> {
    if (zoneIds.length > MAX_ZONE_BATCH) {
      const roots: Array<Record<string, unknown>> = [];
      const failed: Array<{ zoneId: string; state: CoverageResult["state"]; detail: string; retryAt?: number }> = [];
      const batchSize = MAX_ZONE_BATCH;
      for (let offset = 0; offset < zoneIds.length; offset += batchSize) {
        const result = await this.collectProductZones(spec, source, request, limit, zoneIds.slice(offset, offset + batchSize));
        roots.push(...result.roots);
        failed.push(...result.failed);
      }
      return { roots, failed };
    }
    try {
      const zoneId = zoneIds[0];
      const payload = await this.graphql<{
        viewer?: {
          accounts?: Array<{ zones?: Array<Record<string, unknown>> }>;
          zones?: Array<Record<string, unknown>>;
        };
      }>(
        this.options.accountBasedRateLimit
          ? buildAccountZoneProductDatasetQuery(spec.product!, source, limit, request.activityProbe === true)
          : buildProductDatasetQuery(spec.product!, source, limit, request.activityProbe === true),
        this.options.accountBasedRateLimit
          ? accountZoneProductDatasetVariables(source, this.env.BROLLY_ACCOUNT_ID, request.startsAt, request.endsAt, zoneIds)
          : productDatasetVariables(source, this.env.BROLLY_ACCOUNT_ID, request.startsAt, request.endsAt, zoneIds),
        zoneIds.length,
        { kind: "account" },
        request.budgetKey ?? source.dataset,
        limit,
        requestRangeDays(request),
      );
      return {
        roots: this.options.accountBasedRateLimit
          ? payload.viewer?.accounts?.[0]?.zones ?? []
          : payload.viewer?.zones ?? [],
        failed: [],
      };
    } catch (error) {
      if (isHistoricalRateLimitError(error) && error.telemetry?.limiterScope === "zone") {
        const namedZone = zoneIds.find(candidate => error.message.toLowerCase().includes(candidate.toLowerCase()));
        if (namedZone && zoneIds.length > 1) {
          const remaining = zoneIds.filter(candidate => candidate !== namedZone);
          const collected = await this.collectProductZones(spec, source, request, limit, remaining);
          return {
            roots: collected.roots,
            failed: [...collected.failed, { zoneId: namedZone, state: "delayed", detail: error.message, retryAt: error.retryAt }],
          };
        }
      }
      if (isBudgetError(error)) throw error;
      if (!isIsolatableAnalyticsError(error)) throw error;
      const unauthorized = unauthorizedZoneIds(errorMessage(error), zoneIds);
      if (unauthorized.length) {
        const failed = unauthorized.map(deniedZone => ({
          zoneId: deniedZone,
          state: "permission_denied" as const,
          detail: "Cloudflare denied Analytics access to this zone.",
        }));
        const remaining = zoneIds.filter(currentZone => !unauthorized.includes(currentZone));
        if (!remaining.length) return { roots: [], failed };
        const collected = await this.collectProductZones(spec, source, request, limit, remaining);
        return { roots: collected.roots, failed: [...failed, ...collected.failed] };
      }
      if (zoneIds.length > 1) {
        const middle = Math.ceil(zoneIds.length / 2);
        const left = await this.collectProductZones(spec, source, request, limit, zoneIds.slice(0, middle));
        const right = await this.collectProductZones(spec, source, request, limit, zoneIds.slice(middle));
        return { roots: [...left.roots, ...right.roots], failed: [...left.failed, ...right.failed] };
      }
      const zoneId = zoneIds[0];
      return zoneId ? { roots: [], failed: [{ zoneId, state: unavailableState(error), detail: errorMessage(error) }] } : { roots: [], failed: [] };
    }
  }

  private async accountSettings(specs: readonly HistoricalDatasetSpec[]): Promise<Record<string, DatasetSetting | undefined>> {
    const fields = "enabled availableFields maxDuration maxPageSize notOlderThan";
    const query = `query BrollyAccountAnalyticsSettings($account: String!) { viewer { accounts(filter: { accountTag: $account }) { settings { ${specs.map(item => `${item.dataset} { ${fields} }`).join("\n")} } } } }`;
    const payload = await this.graphql<{ viewer?: { accounts?: Array<{ settings?: Record<string, DatasetSetting> }> } }>(query, { account: this.env.BROLLY_ACCOUNT_ID }, specs.length, { kind: "account" }, `settings:account:${specs.map(item => item.dataset).join(",")}`);
    return payload.viewer?.accounts?.[0]?.settings ?? {};
  }

  private async accountSettingsIsolated(
    specs: readonly HistoricalDatasetSpec[],
    publish: (values: readonly HistoricalDatasetCapability[]) => Promise<void> = async () => undefined,
  ): Promise<HistoricalDatasetCapability[]> {
    try {
      const settings = await this.accountSettings(specs);
      const values = specs.map(spec => capability(spec, settings[spec.dataset], null));
      await publish(values);
      return values;
    } catch (error) {
      if (isBudgetError(error)) throw error;
      if (!isIsolatableAnalyticsError(error)) throw error;
      if (specs.length > 1) {
        const middle = Math.ceil(specs.length / 2);
        return [
          ...await this.accountSettingsIsolated(specs.slice(0, middle), publish),
          ...await this.accountSettingsIsolated(specs.slice(middle), publish),
        ];
      }
      const spec = specs[0];
      const values = spec ? [unavailableCapability(spec, null, errorMessage(error), unavailableState(error))] : [];
      await publish(values);
      return values;
    }
  }

  private async zoneSettings(
    specs: readonly HistoricalDatasetSpec[],
    zoneIds: string[],
    publish: (values: readonly HistoricalDatasetCapability[]) => Promise<void> = async () => undefined,
  ): Promise<HistoricalDatasetCapability[]> {
    const fields = "enabled availableFields maxDuration maxPageSize notOlderThan";
    const nested = this.options.accountBasedRateLimit;
    const query = nested
      ? `query BrollyAccountZoneAnalyticsSettings($account: String!, $zones: [string!]!) { viewer { accounts(filter: { accountTag: $account }) { zones(filter: { zoneTag_in: $zones }) { zoneTag settings { ${specs.map(item => `${item.dataset} { ${fields} }`).join("\n")} } } } } }`
      : `query BrollyZoneAnalyticsSettings($zones: [string!]!) { viewer { zones(filter: { zoneTag_in: $zones }) { zoneTag settings { ${specs.map(item => `${item.dataset} { ${fields} }`).join("\n")} } } } }`;
    const zoneId = zoneIds[0]!;
    try {
      const payload = await this.graphql<{ viewer?: {
        accounts?: Array<{ zones?: Array<{ zoneTag?: string; settings?: Record<string, DatasetSetting> }> }>;
        zones?: Array<{ zoneTag?: string; settings?: Record<string, DatasetSetting> }>;
      } }>(
        query,
        nested ? { account: this.env.BROLLY_ACCOUNT_ID, zones: zoneIds } : { zones: zoneIds },
        specs.length * zoneIds.length,
        { kind: "account" },
        `settings:zones:${specs.map(item => item.dataset).join(",")}`,
      );
      const roots = nested ? payload.viewer?.accounts?.[0]?.zones ?? [] : payload.viewer?.zones ?? [];
      const returned = new Map(roots.flatMap(zone => zone.zoneTag ? [[zone.zoneTag, zone.settings ?? {}] as const] : []));
      const values = zoneIds.flatMap(currentZone => specs.map(spec => returned.has(currentZone)
        ? capability(spec, returned.get(currentZone)?.[spec.dataset], currentZone)
        : unavailableCapability(spec, currentZone, "Cloudflare did not return Analytics settings for this zone.")));
      await publish(values);
      return values;
    } catch (error) {
      if (isBudgetError(error)) throw error;
      const unauthorized = unauthorizedZoneIds(errorMessage(error), zoneIds);
      if (unauthorized.length) {
        const denied = unauthorized.flatMap(deniedZone => specs.map(spec => unavailableCapability(spec, deniedZone, "Cloudflare denied Analytics access to this zone.", "permission_denied")));
        await publish(denied);
        const remaining = zoneIds.filter(currentZone => !unauthorized.includes(currentZone));
        return remaining.length ? [...denied, ...await this.zoneSettings(specs, remaining, publish)] : denied;
      }
      if (!isIsolatableAnalyticsError(error)) throw error;
      if (specs.length > 1) {
        const middle = Math.ceil(specs.length / 2);
        return [
          ...await this.zoneSettings(specs.slice(0, middle), zoneIds, publish),
          ...await this.zoneSettings(specs.slice(middle), zoneIds, publish),
        ];
      }
      if (zoneIds.length > 1) {
        const middle = Math.ceil(zoneIds.length / 2);
        return [
          ...await this.zoneSettings(specs, zoneIds.slice(0, middle), publish),
          ...await this.zoneSettings(specs, zoneIds.slice(middle), publish),
        ];
      }
      const values = specs.map(spec => unavailableCapability(spec, zoneId, errorMessage(error), unavailableState(error)));
      await publish(values);
      return values;
    }
  }

  private async listZoneIds(): Promise<string[]> {
    const zoneIds: string[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      this.budget.charge("apiCalls");
      this.ledgerBudget?.charge("restRequests");
      const response = await fetch(`${API}/zones?account.id=${encodeURIComponent(this.env.BROLLY_ACCOUNT_ID)}&per_page=50&page=${page}`, {
        headers: { authorization: `Bearer ${await this.token()}` },
        signal: AbortSignal.any([this.budget.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const payload = await response.json() as { success?: boolean; result?: Array<{ id?: string }>; errors?: Array<{ message?: string }>; result_info?: { total_pages?: number } };
      if (!response.ok || payload.success === false) throw new HistoricalAnalyticsError(response.status, payload.errors?.map(item => item.message).filter(Boolean).join("; ") || `Cloudflare zone inventory failed (${response.status})`);
      zoneIds.push(...(payload.result ?? []).flatMap(zone => zone.id ? [zone.id] : []));
      totalPages = Math.min(10, Math.max(1, payload.result_info?.total_pages ?? 1));
      page += 1;
    } while (page <= totalPages);
    return zoneIds;
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    logicalQueries: number,
    scope: HistoricalRateScope,
    budgetKey: string,
    pageSize?: number,
    rangeDays?: number,
  ): Promise<T> {
    const zoneIds = Array.isArray(variables.zones)
      ? variables.zones.filter((value): value is string => typeof value === "string")
      : [];
    await this.options.rateBudget?.admit(scope, logicalQueries, budgetKey, pageSize, zoneIds, rangeDays);
    const requestedAt = Date.now();
    this.budget.charge("apiCalls");
    this.ledgerBudget?.charge("graphqlQueries", logicalQueries);
    const response = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.token()}`,
        "content-type": "application/json",
        ...(this.options.accountBasedRateLimit ? { "x-rate-limit-type": "account-based" } : {}),
      },
      body: JSON.stringify({ query: withBudgetTelemetry(query), variables }),
      signal: AbortSignal.any([this.budget.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const payload = await response.json().catch(() => ({})) as GraphqlPayload<T>;
    const metering = graphqlBudgetTelemetry(payload.data, requestedAt, Date.now());
    if (metering) this.options.rateBudget?.observe?.(scope, logicalQueries, { ...metering, budgetKey, pageSize: pageSize ?? null });
    if (response.status === 429 || isGraphqlRateLimit(payload.errors)) {
      const message = payload.errors?.map(item => item.message).filter(Boolean).join("; ") || "Cloudflare Analytics rate limit reached";
      const namedScope = namedRateLimitScope(message);
      const telemetry: HistoricalRateLimitTelemetry = {
        occurredAt: Date.now(),
        status: response.status,
        scopeKind: scope.kind,
        logicalQueries,
        accountBasedRequested: this.options.accountBasedRateLimit === true,
        retryAfter: response.headers.get("retry-after"),
        rateLimit: response.headers.get("ratelimit"),
        rateLimitPolicy: response.headers.get("ratelimit-policy"),
        limiterScope: namedScope?.kind ?? (scopedRateLimit(message, scope) ? scope.kind : "shared"),
        rayId: response.headers.get("cf-ray"),
      };
      const retryAt = rateLimitResetAt(response.headers, message, telemetry.occurredAt);
      const sharedQueryBudgetRejection = response.ok && telemetry.limiterScope === "shared";
      if (!sharedQueryBudgetRejection) {
        this.options.rateBudget?.pauseUntil(retryAt, telemetry.limiterScope === "shared" ? null : namedScope ?? scope);
      }
      throw new HistoricalRateLimitError(response.status, retryAt, `${message}; ${rateLimitTelemetryDetail(telemetry)}`, telemetry, true);
    }
    if (!response.ok || payload.errors?.length) {
      throw new HistoricalAnalyticsError(response.status, payload.errors?.map(item => item.message).filter(Boolean).join("; ") || `Cloudflare Analytics request failed (${response.status})`);
    }
    if (!payload.data) throw new HistoricalAnalyticsError(response.status, "Cloudflare Analytics returned no data");
    return payload.data;
  }

  private token(): Promise<string> {
    this.tokenPromise ??= this.tokenProvider();
    return this.tokenPromise;
  }
}

/**
 * A successful empty aggregate response is measured zero. Once Cloudflare
 * returns matching rows, the requested aggregate must occur in the payload;
 * otherwise that metric has unavailable evidence rather than a zero value.
 */
function productMetricHasResponseEvidence(
  source: ProductDatasetDefinition,
  metric: ProductDatasetDefinition["metrics"][number],
  roots: Array<Record<string, unknown>>,
): boolean {
  const rows = roots.flatMap(root => arrayValue(root[source.alias]));
  if (!rows.length) return true;
  const actions = metric.actions?.map(value => value.toLowerCase());
  if (actions?.length) {
    const knownActions = new Set(source.metrics.flatMap(item => item.actions ?? []).map(value => value.toLowerCase()));
    const hasUnknownAction = rows.some(row => {
      const action = stringValue(recordValue(row.dimensions).actionType)?.toLowerCase();
      return action === undefined || !knownActions.has(action);
    });
    if (hasUnknownAction) return false;
  }
  const relevant = actions?.length
    ? rows.filter(row => {
      const action = stringValue(recordValue(row.dimensions).actionType)?.toLowerCase();
      return action !== undefined && actions.includes(action);
    })
    : rows;
  if (!relevant.length) return true;
  if (metric.aggregate === "count") return relevant.some(row => numericValue(row.count) !== undefined);
  const fields = metric.fields ?? [];
  return relevant.some(row => {
    const aggregate = recordValue(row[metric.aggregate]);
    return fields.some(field => numericValue(aggregate[field]) !== undefined);
  });
}

function withBudgetTelemetry(query: string): string {
  return query.replace(/(\{\s*)viewer\s*\{/, "$1cost viewer { budget ");
}

function graphqlBudgetTelemetry(
  value: unknown,
  requestedAt: number,
  observedAt: number,
): Omit<HistoricalRateObservation, "budgetKey" | "pageSize"> | null {
  if (!value || typeof value !== "object") return null;
  const data = value as { cost?: unknown; viewer?: { budget?: unknown } };
  const cost = Number(data.cost);
  const remaining = Number(data.viewer?.budget);
  return Number.isFinite(cost) && cost >= 0 && Number.isFinite(remaining) && remaining >= 0
    ? { cost, remaining, requestedAt, observedAt }
    : null;
}

/** Convert raw settings discovery into the monitor-owned coverage records. */
export function collectorCoverageFromCapabilities(
  accountId: string,
  discovered: HistoricalDatasetCapability[],
  checkedAt = Date.now(),
): CollectorCoverage[] {
  const rows = HISTORICAL_DATASETS.filter(spec => !spec.fallbackFor).map(spec => {
    const values = discovered.filter(item => item.dataset === spec.dataset);
    const fallback = HISTORICAL_DATASETS.find(item => item.fallbackFor === spec.dataset);
    const fallbackValues = fallback ? discovered.filter(item => item.dataset === fallback.dataset) : [];
    const applicable = values.filter(item => item.applicable).map(value => value.enabled ? value
      : fallbackValues.find(candidate => candidate.zoneId === value.zoneId && candidate.enabled) ?? value);
    const enabled = applicable.filter(item => item.enabled);
    const unavailable = applicable.filter(item => !item.enabled);
    const noZones = spec.root === "zone" && applicable.length === 0;
    const maxDuration = minimum(enabled.map(item => item.maxDurationSeconds));
    const retention = minimum(enabled.map(item => item.notOlderThanSeconds));
    const pageSize = minimum(enabled.map(item => item.maxPageSize));
    const state: CollectorCoverage["state"] = noZones
      ? "healthy"
      : unavailable.some(item => item.state === "permission_denied")
        ? "permission_denied"
        : unavailable.length || enabled.length === 0 ? "unavailable" : "healthy";
    const detail = noZones
      ? "The connected account has no zones."
      : unavailable.length
        ? spec.root === "zone"
          ? `${enabled.length} of ${applicable.length} zone partitions are available. ${unavailable[0]?.detail ?? ""}`.trim()
          : unavailable[0]?.detail ?? "Cloudflare did not expose this Analytics dataset."
        : `Available with page size ${pageSize ?? "unknown"} and duration limit ${maxDuration ?? "unknown"} seconds`;
    return {
      accountId,
      collectorKey: spec.collector,
      dataset: spec.dataset,
      available: noZones || enabled.length > 0,
      retentionDays: retention === null ? null : Math.floor(retention / 86_400),
      samplingBehavior: "Dataset sampling follows Cloudflare Analytics settings",
      finestScope: spec.scope,
      lastVerifiedAt: checkedAt,
      errorCode: state === "healthy" ? null : state,
      humanExplanation: detail,
      state,
      watermarkAt: null,
    } satisfies CollectorCoverage;
  });
  return [...rows, ...catalogCapabilityGaps(accountId, checkedAt, new Set(HISTORICAL_DATASETS.map(item => item.family)))];
}

export class HistoricalAnalyticsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HistoricalAnalyticsError";
  }
}

export class HistoricalRateLimitError extends HistoricalAnalyticsError {
  constructor(
    status: number,
    readonly retryAt: number,
    message: string,
    readonly telemetry?: HistoricalRateLimitTelemetry,
    readonly remote = false,
  ) {
    super(status, message);
    this.name = "HistoricalRateLimitError";
  }
}

export function isHistoricalRateLimitError(error: unknown): error is HistoricalRateLimitError {
  return error instanceof HistoricalRateLimitError;
}

function special(collector: string, label: string, dataset: string, family: string, scope: AssetRef["scope"], kind: HistoricalDatasetKind): HistoricalDatasetSpec {
  return { collector, label, dataset, family, root: "account", scope, retentionDays: 90, kind };
}

function capability(spec: HistoricalDatasetSpec, setting: DatasetSetting | undefined, zoneId: string | null): HistoricalDatasetCapability {
  const availableFields = Array.isArray(setting?.availableFields)
    ? setting.availableFields.filter(value => typeof value === "string")
    : undefined;
  const projected = spec.kind === "product" ? projectProductDataset(spec.source!, availableFields) : null;
  const enabled = setting?.enabled === true && (projected === null || projected.metrics.length > 0);
  return {
    collector: spec.collector,
    label: spec.label,
    dataset: spec.dataset,
    family: spec.family,
    root: spec.root,
    zoneId,
    applicable: true,
    enabled,
    maxDurationSeconds: positive(setting?.maxDuration) ?? spec.retentionDays * 86_400,
    notOlderThanSeconds: positive(setting?.notOlderThan) ?? spec.retentionDays * 86_400,
    maxPageSize: boundedPageSize(setting?.maxPageSize ?? 10_000),
    ...(availableFields === undefined ? {} : { availableFields }),
    state: enabled ? "healthy" : "unavailable",
    detail: enabled
      ? "Available"
      : setting?.enabled === true
        ? "Cloudflare exposes none of the aggregate fields required by Brolly's metric contract."
        : "Cloudflare reports this Analytics dataset as unavailable for the current token or plan.",
  };
}

function unavailableCapability(spec: HistoricalDatasetSpec, zoneId: string | null, detail: string, state: CoverageResult["state"] = "unavailable"): HistoricalDatasetCapability {
  return {
    collector: spec.collector,
    label: spec.label,
    dataset: spec.dataset,
    family: spec.family,
    root: spec.root,
    zoneId,
    applicable: true,
    enabled: false,
    maxDurationSeconds: spec.retentionDays * 86_400,
    notOlderThanSeconds: spec.retentionDays * 86_400,
    maxPageSize: 10_000,
    state,
    detail,
  };
}

function specialQuery(spec: HistoricalDatasetSpec, limit: number): string {
  const selection = spec.kind === "workers"
    ? "dimensions { date scriptName } sum { requests cpuTimeUs }"
    : spec.kind === "durable_invocations"
      ? "dimensions { date namespaceId objectId type } sum { requests }"
      : spec.kind === "durable_periodic"
        ? "dimensions { date namespaceId objectId } sum { duration inboundWebsocketMsgCount rowsRead rowsWritten storageReadUnits storageWriteUnits storageDeletes }"
        : spec.kind === "durable_sql_storage"
          ? "dimensions { date namespaceId } max { storedBytes }"
          : "dimensions { date } max { storedBytes }";
  return `query BrollyHistoricalUsage($account: String!, $since: Time!, $until: Time!) { viewer { accounts(filter: { accountTag: $account }) { ${spec.dataset}(limit: ${limit}, filter: { datetime_geq: $since, datetime_lt: $until }) { ${selection} } } } }`;
}

function normalizeSpecial(spec: HistoricalDatasetSpec, rows: Array<Record<string, unknown>>, env: Env, startsAt: number, endsAt: number): MetricSample[] {
  const samples = new Map<string, MetricSample>();
  for (const row of rows) {
    const dimensions = recordValue(row.dimensions);
    const bounds = dailyBounds(stringValue(dimensions.date), startsAt, endsAt);
    if (spec.kind === "workers") {
      const scriptName = stringValue(dimensions.scriptName);
      if (!scriptName) continue;
      const sum = recordValue(row.sum);
      const asset: AssetRef = {
        accountId: env.BROLLY_ACCOUNT_ID,
        family: "workers",
        id: scriptName,
        name: scriptName,
        nameKind: "named",
        scope: "resource",
        tier: isBrollyScript(scriptName, env.BROLLY_SELF_WORKER_NAME) ? "control_plane" : "unclassified",
      };
      const requests = numericValue(sum.requests);
      const cpuTimeUs = numericValue(sum.cpuTimeUs);
      if (requests !== undefined) addSample(samples, asset, "requests", "requests", requests, bounds, "sum");
      if (cpuTimeUs !== undefined) addSample(samples, asset, "cpu_ms", "milliseconds", cpuTimeUs / 1_000, bounds, "sum");
      continue;
    }
    if (spec.kind === "durable_kv_storage") {
      const asset: AssetRef = {
        accountId: env.BROLLY_ACCOUNT_ID,
        family: "durable_objects",
        id: "legacy-kv-storage",
        name: "Legacy key-value Durable Object storage",
        scope: "account",
        tier: "control_plane",
      };
      const storedBytes = numericValue(recordValue(row.max).storedBytes);
      if (storedBytes !== undefined) addSample(samples, asset, "kv_storage_bytes", "bytes", storedBytes, bounds, "max");
      continue;
    }
    const namespaceId = stringValue(dimensions.namespaceId);
    if (!namespaceId) continue;
    if (spec.kind === "durable_sql_storage") {
      const asset: AssetRef = { accountId: env.BROLLY_ACCOUNT_ID, family: "durable_objects", id: namespaceId, scope: "namespace", tier: "unclassified" };
      const storedBytes = numericValue(recordValue(row.max).storedBytes);
      if (storedBytes !== undefined) addSample(samples, asset, "sql_storage_bytes", "bytes", storedBytes, bounds, "max");
      continue;
    }
    const objectId = stringValue(dimensions.objectId);
    if (!objectId) continue;
    const asset: AssetRef = { accountId: env.BROLLY_ACCOUNT_ID, family: "durable_objects", id: objectId, parentId: namespaceId, scope: "object", tier: "unclassified" };
    const sum = recordValue(row.sum);
    if (spec.kind === "durable_invocations") {
      const hibernation = stringValue(dimensions.type) === "hibernation";
      const requests = numericValue(sum.requests);
      if (requests !== undefined) addSample(samples, asset, hibernation ? "incoming_websocket_messages" : "requests", hibernation ? "count" : "requests", requests, bounds, "sum");
      continue;
    }
    const metrics: Array<[string, MetricSample["unit"], unknown]> = [
      ["duration_gb_seconds", "gb_seconds", sum.duration],
      ["incoming_websocket_messages", "count", sum.inboundWebsocketMsgCount],
      ["rows_read", "rows", sum.rowsRead],
      ["rows_written", "rows", sum.rowsWritten],
      ["kv_read_units", "count", sum.storageReadUnits],
      ["kv_write_units", "count", sum.storageWriteUnits],
      ["kv_delete_requests", "requests", sum.storageDeletes],
    ];
    for (const [metric, unit, value] of metrics) {
      const numeric = numericValue(value);
      if (numeric !== undefined) addSample(samples, asset, metric, unit, numeric, bounds, "sum");
    }
  }
  return [...samples.values()];
}

function addSample(samples: Map<string, MetricSample>, asset: AssetRef, name: string, unit: MetricSample["unit"], value: number, bounds: { start: number; end: number }, aggregation: "sum" | "max") {
  const key = `${bounds.start}:${asset.parentId ?? ""}:${asset.id}:${name}`;
  const estimatedCostUsd = estimatedCost(name, value, bounds.end - bounds.start);
  const existing = samples.get(key);
  if (existing) {
    existing.value = aggregation === "max" ? Math.max(existing.value, value) : existing.value + value;
    existing.estimatedCostUsd = aggregation === "max" ? Math.max(existing.estimatedCostUsd ?? 0, estimatedCostUsd) : (existing.estimatedCostUsd ?? 0) + estimatedCostUsd;
    return;
  }
  samples.set(key, { asset, metric: name, unit, value, start: bounds.start, end: bounds.end, source: "graphql", estimatedCostUsd, sampled: false });
}

function estimatedCost(name: string, value: number, durationMs: number): number {
  const unitPrice = name === "rows_read" ? 0.001 / 1_000_000
    : name === "rows_written" ? 1 / 1_000_000
      : name === "requests" ? 0.15 / 1_000_000
        : name === "cpu_ms" ? 0.02 / 1_000_000
          : name === "duration_gb_seconds" ? 12.50 / 1_000_000
            : name === "incoming_websocket_messages" ? (0.15 / 1_000_000) / 20
              : name === "kv_read_units" ? 0.20 / 1_000_000
                : name === "kv_write_units" || name === "kv_delete_requests" ? 1 / 1_000_000 : 0;
  const storage = name === "sql_storage_bytes" || name === "kv_storage_bytes"
    ? (value / 1_000_000_000) * 0.20 * (durationMs / (30 * DAY_MS))
    : 0;
  return value * unitPrice + storage;
}

function specialCoverage(
  spec: HistoricalDatasetSpec,
  rows: Array<Record<string, unknown>>,
  truncated: boolean,
  accountPresent: boolean,
): CoverageResult[] {
  const metrics = spec.kind === "workers" ? ["requests", "cpu_ms"]
    : spec.kind === "durable_invocations" ? ["requests", "incoming_websocket_messages"]
      : spec.kind === "durable_periodic" ? ["duration_gb_seconds", "incoming_websocket_messages", "rows_read", "rows_written", "kv_read_units", "kv_write_units", "kv_delete_requests"]
        : spec.kind === "durable_sql_storage" ? ["sql_storage_bytes"] : ["kv_storage_bytes"];
  return metrics.map(metric => ({
    family: spec.family,
    metric,
    finestScope: spec.scope,
    state: !accountPresent || !specialMetricHasResponseEvidence(spec, metric, rows)
      ? "unavailable"
      : truncated ? "delayed" : "healthy",
    checkedAt: Date.now(),
    detail: !accountPresent
      ? `Cloudflare did not return the connected account for ${spec.dataset}.`
      : !specialMetricHasResponseEvidence(spec, metric, rows)
        ? `${spec.dataset} returned rows without the aggregate field required for ${spec.family}:${metric}.`
        : truncated ? `${spec.dataset} reached its bounded row limit` : undefined,
  }));
}

function specialMetricHasResponseEvidence(
  spec: HistoricalDatasetSpec,
  metric: string,
  rows: Array<Record<string, unknown>>,
): boolean {
  if (!rows.length) return true;
  let relevant = rows;
  if (spec.kind === "durable_invocations") {
    relevant = rows.filter(row => {
      const hibernation = stringValue(recordValue(row.dimensions).type) === "hibernation";
      return metric === "incoming_websocket_messages" ? hibernation : !hibernation;
    });
    if (!relevant.length) return true;
  }
  const field = spec.kind === "workers"
    ? metric === "cpu_ms" ? "cpuTimeUs" : "requests"
    : spec.kind === "durable_kv_storage" || spec.kind === "durable_sql_storage"
      ? "storedBytes"
      : metric === "duration_gb_seconds" ? "duration"
        : metric === "incoming_websocket_messages" && spec.kind === "durable_periodic" ? "inboundWebsocketMsgCount"
          : metric === "rows_read" ? "rowsRead"
            : metric === "rows_written" ? "rowsWritten"
              : metric === "kv_read_units" ? "storageReadUnits"
                : metric === "kv_write_units" ? "storageWriteUnits"
                  : metric === "kv_delete_requests" ? "storageDeletes"
                    : "requests";
  const aggregate = spec.kind === "durable_kv_storage" || spec.kind === "durable_sql_storage" ? "max" : "sum";
  return relevant.some(row => numericValue(recordValue(row[aggregate])[field]) !== undefined);
}

function catalogCapabilityGaps(accountId: string, checkedAt: number, coveredFamilies: Set<string>): CollectorCoverage[] {
  return METRIC_CATALOG
    .filter(product => !coveredFamilies.has(product.family))
    .map(product => ({
      accountId,
      collectorKey: product.fastSource ? `${product.fastSource}:${product.family}` : "billing:catchall",
      dataset: product.family,
      available: false,
      retentionDays: null,
      samplingBehavior: null,
      finestScope: product.preferredScope,
      lastVerifiedAt: checkedAt,
      errorCode: "detailed_collector_unavailable",
      humanExplanation: product.billingSource
        ? "Authoritative billing lines remain visible. Detailed resource attribution is unavailable for this product."
        : "Cloudflare does not expose a supported account collector for this product.",
      state: "unavailable",
      watermarkAt: null,
    }));
}

function unauthorizedZoneIds(message: string, candidates: string[]): string[] {
  const candidateSet = new Set(candidates);
  return [...new Set(message.match(/[a-f0-9]{32}/gi) ?? [])].filter(id => candidateSet.has(id));
}

function boundedPageSize(value: number): number { return Math.max(1, Math.min(10_000, Math.floor(value))); }

export function historicalQueryPageSize(request: HistoricalUsageRequest): number {
  const spec = DATASET_BY_NAME.get(request.dataset);
  const maximum = boundedPageSize(request.maxPageSize);
  if (!spec) return maximum;
  const dailyOnly = spec.kind === "durable_kv_storage"
    || spec.kind === "product"
      && !spec.source?.resourceDimension
      && !spec.source?.parentDimension
      && (spec.source?.dimensions?.length ?? 0) === 0;
  if (!dailyOnly) return maximum;
  const requestedDays = Math.max(1, Math.ceil((request.endsAt - request.startsAt) / 86_400_000));
  // One extra row distinguishes a complete daily result from truncation.
  return Math.min(maximum, requestedDays + 1);
}
function positive(value: number | undefined): number | null { return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null; }
function minimum(values: number[]): number | null { return values.length ? Math.min(...values) : null; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isBudgetError(error: unknown): boolean {
  return isHistoricalRateLimitError(error) || error instanceof Error && /BudgetExceededError$/.test(error.name);
}
function isGraphqlRateLimit(errors: GraphqlPayload<unknown>["errors"]): boolean {
  return Boolean(errors?.some(error => error.extensions?.code?.toLowerCase() === "budget"
    || /rate.?limit|query budget|quota exceeded|too many requests/i.test(error.message ?? "")));
}
function rateLimitTelemetryDetail(value: HistoricalRateLimitTelemetry): string {
  return [
    `scope=${value.scopeKind}`,
    `logicalQueries=${value.logicalQueries}`,
    `status=${value.status}`,
    `accountBased=${value.accountBasedRequested}`,
    value.retryAfter ? `retry-after=${value.retryAfter}` : "",
    value.rateLimit ? `ratelimit=${value.rateLimit}` : "",
    value.rateLimitPolicy ? `ratelimit-policy=${value.rateLimitPolicy}` : "",
    `limiter=${value.limiterScope}`,
    value.rayId ? `cf-ray=${value.rayId}` : "",
  ].filter(Boolean).join(", ");
}
function scopedRateLimit(message: string, scope: HistoricalRateScope): boolean {
  return scope.kind === "account"
    ? /\bAccount\s+[a-f0-9]{32}\s+has exceeded its rate limit/i.test(message)
    : /\bZone\s+[a-f0-9]{32}\s+has exceeded its rate limit/i.test(message);
}
function namedRateLimitScope(message: string): HistoricalRateScope | null {
  const zoneId = message.match(/\bZone\s+([a-f0-9]{32})\s+has exceeded its rate limit/i)?.[1];
  if (zoneId) return { kind: "zone", zoneId };
  return /\bAccount\s+[a-f0-9]{32}\s+has exceeded its rate limit/i.test(message) ? { kind: "account" } : null;
}
function rateLimitResetAt(headers: Headers, message: string, now = Date.now()): number {
  const floor = /after\s+5\s+minutes|five\s+minutes/i.test(message) ? now + 5 * 60_000 : now;
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(floor, now + seconds * 1_000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(floor, timestamp);
  }
  const resetSeconds = headers.get("ratelimit")?.match(/(?:^|;)\s*t=(\d+)/i)?.[1];
  return Math.max(floor, now + (resetSeconds ? Number(resetSeconds) * 1_000 : 5 * 60_000));
}

function hasCapability(capabilities: HistoricalDatasetCapability[], dataset: string, zoneId: string | null): boolean {
  return capabilities.some(item => item.dataset === dataset && item.zoneId === zoneId);
}
function unavailableState(error: unknown): CoverageResult["state"] {
  return /permission|unauthoriz|forbidden|access denied|not authorized/i.test(errorMessage(error)) ? "permission_denied" : "unavailable";
}
function isIsolatableAnalyticsError(error: unknown): boolean {
  if (error instanceof HistoricalAnalyticsError && [400, 403].includes(error.status)) return true;
  return /permission|unauthoriz|forbidden|access denied|not authorized|cannot query field|unknown field|not available|unavailable/i.test(errorMessage(error));
}
function arrayValue(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter(item => item && typeof item === "object") as Array<Record<string, unknown>> : []; }
function recordValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function numericValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function dailyBounds(day: string | undefined, startsAt: number, endsAt: number): { start: number; end: number } {
  if (!day) return { start: startsAt, end: endsAt };
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(start) ? { start, end: start + DAY_MS } : { start: startsAt, end: endsAt };
}
function isBrollyScript(value: string, configured?: string): boolean {
  return value === (configured ?? "brolly-guard") || value === "brolly-guard" || value.startsWith("brolly-guard-");
}
