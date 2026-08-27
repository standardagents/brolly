import {
  METRIC_CATALOG,
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
  buildExactZoneProductDatasetQuery,
  buildProductDatasetQuery,
  exactZoneProductDatasetVariables,
  normalizeProductDataset,
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

export interface HistoricalRateBudget {
  admit(scope: HistoricalRateScope): Promise<void>;
  charge(scope: HistoricalRateScope, logicalQueries: number): void;
}

export interface HistoricalAnalyticsOptions {
  accountBasedRateLimit?: boolean;
  rateBudget?: HistoricalRateBudget;
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
  state: CoverageResult["state"];
  detail: string;
}

export interface HistoricalUsageRequest {
  dataset: string;
  startsAt: number;
  endsAt: number;
  maxPageSize: number;
  zoneIds?: string[];
}

export interface HistoricalUsageResult {
  collector: string;
  dataset: string;
  samples: MetricSample[];
  coverage: CoverageResult[];
  complete: boolean;
  rows: number;
  zoneGaps?: Array<{ zoneId: string; state: CoverageResult["state"]; detail: string }>;
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
  special("graphql:workers", "Workers", "workersInvocationsAdaptive", "workers", "resource", "workers"),
  special("graphql:durable-objects", "Durable Objects", "durableObjectsInvocationsAdaptiveGroups", "durable_objects", "object", "durable_invocations"),
  special("graphql:durable-objects", "Durable Objects", "durableObjectsPeriodicGroups", "durable_objects", "object", "durable_periodic"),
  special("graphql:durable-objects", "Durable Objects", "durableObjectsSqlStorageGroups", "durable_objects", "namespace", "durable_sql_storage"),
  special("graphql:durable-objects", "Durable Objects", "durableObjectsStorageGroups", "durable_objects", "account", "durable_kv_storage"),
];

const PRODUCT_DATASETS = PRODUCT_USAGE_DEFINITIONS.flatMap(product => product.datasets.map(source => ({
  collector: product.collector,
  label: product.label,
  dataset: source.dataset,
  family: product.family,
  root: source.root ?? "account",
  scope: source.root === "zone" ? "zone" as const : source.resourceDimension ? product.scope : "account" as const,
  retentionDays: product.retentionDays,
  kind: "product" as const,
  product,
  source,
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

  async discoverCapabilities(): Promise<HistoricalDatasetCapability[]> {
    const account = HISTORICAL_DATASETS.filter(item => item.root === "account");
    const zones = HISTORICAL_DATASETS.filter(item => item.root === "zone");
    const capabilities: HistoricalDatasetCapability[] = [];
    for (let offset = 0; offset < account.length; offset += SETTINGS_BATCH) {
      const batch = account.slice(offset, offset + SETTINGS_BATCH);
      capabilities.push(...await this.accountSettingsIsolated(batch));
    }

    let zoneIds: string[];
    try {
      zoneIds = this.zoneProvider ? await this.zoneProvider() : await this.listZoneIds();
    } catch (error) {
      if (isBudgetError(error)) throw error;
      return [...capabilities, ...zones.map(spec => unavailableCapability(spec, null, errorMessage(error)))];
    }
    if (!zoneIds.length) {
      return [...capabilities, ...zones.map(spec => ({
        ...unavailableCapability(spec, null, "The connected account has no zones."),
        applicable: false,
        state: "healthy" as const,
      }))];
    }
    const settingsBatchSize = this.options.accountBasedRateLimit ? 1 : MAX_ZONE_BATCH;
    const zoneBatches = Array.from(
      { length: Math.ceil(zoneIds.length / settingsBatchSize) },
      (_, index) => zoneIds.slice(index * settingsBatchSize, (index + 1) * settingsBatchSize),
    );
    for (let offset = 0; offset < zoneBatches.length; offset += 6) {
      const discovered = await Promise.all(
        zoneBatches.slice(offset, offset + 6).map(batch => this.zoneSettings(zones, batch)),
      );
      capabilities.push(...discovered.flat());
    }
    return capabilities;
  }

  async collectorCapabilities(): Promise<CollectorCoverage[]> {
    const checkedAt = Date.now();
    const discovered = await this.discoverCapabilities();
    const rows = HISTORICAL_DATASETS.map(spec => {
      const values = discovered.filter(item => item.dataset === spec.dataset);
      const applicable = values.filter(item => item.applicable);
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
        accountId: this.env.BROLLY_ACCOUNT_ID,
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
    return [...rows, ...catalogCapabilityGaps(this.env.BROLLY_ACCOUNT_ID, checkedAt, new Set(HISTORICAL_DATASETS.map(item => item.family)))];
  }

  async collect(request: HistoricalUsageRequest): Promise<HistoricalUsageResult> {
    const spec = DATASET_BY_NAME.get(request.dataset);
    if (!spec) throw new Error(`Unknown historical Analytics dataset ${request.dataset}`);
    const limit = boundedPageSize(request.maxPageSize);
    if (spec.kind === "product") return this.collectProduct(spec, request, limit);
    const query = specialQuery(spec, limit);
    const variables = {
      account: this.env.BROLLY_ACCOUNT_ID,
      since: new Date(request.startsAt).toISOString(),
      until: new Date(request.endsAt).toISOString(),
    };
    const payload = await this.graphql<{ viewer?: { accounts?: Array<Record<string, unknown>> } }>(query, variables, 1, { kind: "account" });
    const rows = arrayValue(payload.viewer?.accounts?.[0]?.[spec.dataset]);
    const samples = normalizeSpecial(spec, rows, this.env, request.startsAt, request.endsAt);
    return {
      collector: spec.collector,
      dataset: spec.dataset,
      samples,
      coverage: specialCoverage(spec, rows.length >= limit),
      complete: rows.length < limit,
      rows: rows.length,
    };
  }

  private async collectProduct(spec: HistoricalDatasetSpec, request: HistoricalUsageRequest, limit: number): Promise<HistoricalUsageResult> {
    const product = spec.product!;
    const source = spec.source!;
    const zoneIds = source.root === "zone" ? request.zoneIds ?? [] : [];
    if (source.root === "zone" && !zoneIds.length) throw new Error(`${source.dataset} requires at least one authorized zone`);
    const failedZones: Array<{ zoneId: string; state: CoverageResult["state"]; detail: string }> = [];
    let roots: Array<Record<string, unknown>>;
    if (source.root === "zone") {
      const isolated = await this.collectProductZones(spec, request, limit, zoneIds);
      roots = isolated.roots;
      failedZones.push(...isolated.failed);
    } else {
      const payload = await this.graphql<{ viewer?: { accounts?: Array<Record<string, unknown>> } }>(
        buildProductDatasetQuery(product, source, limit),
        productDatasetVariables(source, this.env.BROLLY_ACCOUNT_ID, request.startsAt, request.endsAt, []),
        1,
        { kind: "account" },
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
    const failedDetail = failedZones.length
      ? failedZones.map(item => `${item.zoneId}: ${item.detail}`).join("; ")
      : undefined;
    return {
      collector: spec.collector,
      dataset: spec.dataset,
      samples: normalizeProductDataset(product, source, roots, this.env.BROLLY_ACCOUNT_ID, request.startsAt, request.endsAt),
      coverage: source.metrics.map(item => ({
        family: product.family,
        metric: item.metric,
        finestScope: source.root === "zone" ? "zone" : source.resourceDimension ? product.scope : "account",
        state: failedZones.length ? failedZones.some(item => item.state === "permission_denied") ? "permission_denied" : "unavailable" : truncated ? "delayed" : "healthy",
        checkedAt: Date.now(),
        detail: failedDetail ?? (truncated ? `${source.dataset} reached its bounded ${limit}-row range limit` : undefined),
      })),
      complete: !truncated && failedZones.length === 0,
      rows,
      zoneGaps: failedZones.length ? failedZones : undefined,
    };
  }

  private async collectProductZones(
    spec: HistoricalDatasetSpec,
    request: HistoricalUsageRequest,
    limit: number,
    zoneIds: string[],
  ): Promise<{ roots: Array<Record<string, unknown>>; failed: Array<{ zoneId: string; state: CoverageResult["state"]; detail: string }> }> {
    const source = spec.source!;
    if (zoneIds.length > (this.options.accountBasedRateLimit ? 1 : MAX_ZONE_BATCH)) {
      const roots: Array<Record<string, unknown>> = [];
      const failed: Array<{ zoneId: string; state: CoverageResult["state"]; detail: string }> = [];
      const batchSize = this.options.accountBasedRateLimit ? 1 : MAX_ZONE_BATCH;
      for (let offset = 0; offset < zoneIds.length; offset += batchSize) {
        const result = await this.collectProductZones(spec, request, limit, zoneIds.slice(offset, offset + batchSize));
        roots.push(...result.roots);
        failed.push(...result.failed);
      }
      return { roots, failed };
    }
    try {
      const zoneId = zoneIds[0];
      const payload = await this.graphql<{ viewer?: { zones?: Array<Record<string, unknown>> } }>(
        this.options.accountBasedRateLimit
          ? buildExactZoneProductDatasetQuery(spec.product!, source, limit)
          : buildProductDatasetQuery(spec.product!, source, limit),
        this.options.accountBasedRateLimit && zoneId
          ? exactZoneProductDatasetVariables(source, request.startsAt, request.endsAt, zoneId)
          : productDatasetVariables(source, this.env.BROLLY_ACCOUNT_ID, request.startsAt, request.endsAt, zoneIds),
        this.options.accountBasedRateLimit ? 1 : zoneIds.length,
        zoneId ? { kind: "zone", zoneId } : { kind: "account" },
      );
      return { roots: payload.viewer?.zones ?? [], failed: [] };
    } catch (error) {
      if (isBudgetError(error)) throw error;
      if (!isIsolatableAnalyticsError(error)) throw error;
      if (zoneIds.length > 1) {
        const middle = Math.ceil(zoneIds.length / 2);
        const left = await this.collectProductZones(spec, request, limit, zoneIds.slice(0, middle));
        const right = await this.collectProductZones(spec, request, limit, zoneIds.slice(middle));
        return { roots: [...left.roots, ...right.roots], failed: [...left.failed, ...right.failed] };
      }
      const zoneId = zoneIds[0];
      return zoneId ? { roots: [], failed: [{ zoneId, state: unavailableState(error), detail: errorMessage(error) }] } : { roots: [], failed: [] };
    }
  }

  private async accountSettings(specs: readonly HistoricalDatasetSpec[]): Promise<Record<string, DatasetSetting | undefined>> {
    const fields = "enabled availableFields maxDuration maxPageSize notOlderThan";
    const query = `query BrollyAccountAnalyticsSettings($account: String!) { viewer { accounts(filter: { accountTag: $account }) { settings { ${specs.map(item => `${item.dataset} { ${fields} }`).join("\n")} } } } }`;
    const payload = await this.graphql<{ viewer?: { accounts?: Array<{ settings?: Record<string, DatasetSetting> }> } }>(query, { account: this.env.BROLLY_ACCOUNT_ID }, specs.length, { kind: "account" });
    return payload.viewer?.accounts?.[0]?.settings ?? {};
  }

  private async accountSettingsIsolated(specs: readonly HistoricalDatasetSpec[]): Promise<HistoricalDatasetCapability[]> {
    try {
      const settings = await this.accountSettings(specs);
      return specs.map(spec => capability(spec, settings[spec.dataset], null));
    } catch (error) {
      if (isBudgetError(error)) throw error;
      if (!isIsolatableAnalyticsError(error)) throw error;
      if (specs.length > 1) {
        const middle = Math.ceil(specs.length / 2);
        return [
          ...await this.accountSettingsIsolated(specs.slice(0, middle)),
          ...await this.accountSettingsIsolated(specs.slice(middle)),
        ];
      }
      const spec = specs[0];
      return spec ? [unavailableCapability(spec, null, errorMessage(error), unavailableState(error))] : [];
    }
  }

  private async zoneSettings(specs: readonly HistoricalDatasetSpec[], zoneIds: string[]): Promise<HistoricalDatasetCapability[]> {
    const fields = "enabled availableFields maxDuration maxPageSize notOlderThan";
    const exact = this.options.accountBasedRateLimit;
    const query = exact
      ? `query BrollyZoneAnalyticsSettings($zone: string!) { viewer { zones(filter: { zoneTag: $zone }) { zoneTag settings { ${specs.map(item => `${item.dataset} { ${fields} }`).join("\n")} } } } }`
      : `query BrollyZoneAnalyticsSettings($zones: [string!]!) { viewer { zones(filter: { zoneTag_in: $zones }) { zoneTag settings { ${specs.map(item => `${item.dataset} { ${fields} }`).join("\n")} } } } }`;
    const zoneId = zoneIds[0]!;
    try {
      const payload = await this.graphql<{ viewer?: { zones?: Array<{ zoneTag?: string; settings?: Record<string, DatasetSetting> }> } }>(
        query,
        exact ? { zone: zoneId } : { zones: zoneIds },
        specs.length * zoneIds.length,
        { kind: "zone", zoneId },
      );
      const returned = new Map((payload.viewer?.zones ?? []).flatMap(zone => zone.zoneTag ? [[zone.zoneTag, zone.settings ?? {}] as const] : []));
      return zoneIds.flatMap(currentZone => specs.map(spec => returned.has(currentZone)
        ? capability(spec, returned.get(currentZone)?.[spec.dataset], currentZone)
        : unavailableCapability(spec, currentZone, "Cloudflare did not return Analytics settings for this zone.")));
    } catch (error) {
      if (isBudgetError(error)) throw error;
      const unauthorized = unauthorizedZoneIds(errorMessage(error), zoneIds);
      if (unauthorized.length) {
        const denied = unauthorized.flatMap(deniedZone => specs.map(spec => unavailableCapability(spec, deniedZone, "Cloudflare denied Analytics access to this zone.", "permission_denied")));
        const remaining = zoneIds.filter(currentZone => !unauthorized.includes(currentZone));
        return remaining.length ? [...denied, ...await this.zoneSettings(specs, remaining)] : denied;
      }
      if (!isIsolatableAnalyticsError(error)) throw error;
      if (specs.length > 1) {
        const middle = Math.ceil(specs.length / 2);
        return [
          ...await this.zoneSettings(specs.slice(0, middle), zoneIds),
          ...await this.zoneSettings(specs.slice(middle), zoneIds),
        ];
      }
      if (zoneIds.length > 1) {
        const middle = Math.ceil(zoneIds.length / 2);
        return [
          ...await this.zoneSettings(specs, zoneIds.slice(0, middle)),
          ...await this.zoneSettings(specs, zoneIds.slice(middle)),
        ];
      }
      return specs.map(spec => unavailableCapability(spec, zoneId, errorMessage(error), unavailableState(error)));
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
  ): Promise<T> {
    await this.options.rateBudget?.admit(scope);
    this.options.rateBudget?.charge(scope, logicalQueries);
    this.budget.charge("apiCalls");
    this.ledgerBudget?.charge("graphqlQueries", logicalQueries);
    const response = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.token()}`,
        "content-type": "application/json",
        ...(this.options.accountBasedRateLimit ? { "x-rate-limit-type": "account-based" } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.any([this.budget.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const payload = await response.json().catch(() => ({})) as GraphqlPayload<T>;
    if (response.status === 429 || isGraphqlRateLimit(payload.errors)) {
      throw new HistoricalRateLimitError(response.status, rateLimitResetAt(response.headers), payload.errors?.map(item => item.message).filter(Boolean).join("; ") || "Cloudflare Analytics rate limit reached");
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

export class HistoricalAnalyticsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HistoricalAnalyticsError";
  }
}

export class HistoricalRateLimitError extends HistoricalAnalyticsError {
  constructor(status: number, readonly retryAt: number, message: string) {
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
  const enabled = setting?.enabled === true;
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
    state: enabled ? "healthy" : "unavailable",
    detail: enabled ? "Available" : "Cloudflare reports this Analytics dataset as unavailable for the current token or plan.",
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
        scope: "resource",
        tier: isBrollyScript(scriptName, env.BROLLY_SELF_WORKER_NAME) ? "control_plane" : "unclassified",
      };
      addSample(samples, asset, "requests", "requests", numberValue(sum.requests), bounds, "sum");
      addSample(samples, asset, "cpu_ms", "milliseconds", numberValue(sum.cpuTimeUs) / 1_000, bounds, "sum");
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
      addSample(samples, asset, "kv_storage_bytes", "bytes", numberValue(recordValue(row.max).storedBytes), bounds, "max");
      continue;
    }
    const namespaceId = stringValue(dimensions.namespaceId);
    if (!namespaceId) continue;
    if (spec.kind === "durable_sql_storage") {
      const asset: AssetRef = { accountId: env.BROLLY_ACCOUNT_ID, family: "durable_objects", id: namespaceId, scope: "namespace", tier: "unclassified" };
      addSample(samples, asset, "sql_storage_bytes", "bytes", numberValue(recordValue(row.max).storedBytes), bounds, "max");
      continue;
    }
    const objectId = stringValue(dimensions.objectId);
    if (!objectId) continue;
    const asset: AssetRef = { accountId: env.BROLLY_ACCOUNT_ID, family: "durable_objects", id: objectId, parentId: namespaceId, scope: "object", tier: "unclassified" };
    const sum = recordValue(row.sum);
    if (spec.kind === "durable_invocations") {
      const hibernation = stringValue(dimensions.type) === "hibernation";
      addSample(samples, asset, hibernation ? "incoming_websocket_messages" : "requests", hibernation ? "count" : "requests", numberValue(sum.requests), bounds, "sum");
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
    for (const [metric, unit, value] of metrics) if (value !== undefined && value !== null) addSample(samples, asset, metric, unit, numberValue(value), bounds, "sum");
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

function specialCoverage(spec: HistoricalDatasetSpec, truncated: boolean): CoverageResult[] {
  const metrics = spec.kind === "workers" ? ["requests", "cpu_ms"]
    : spec.kind === "durable_invocations" ? ["requests", "incoming_websocket_messages"]
      : spec.kind === "durable_periodic" ? ["duration_gb_seconds", "incoming_websocket_messages", "rows_read", "rows_written", "kv_read_units", "kv_write_units", "kv_delete_requests"]
        : spec.kind === "durable_sql_storage" ? ["sql_storage_bytes"] : ["kv_storage_bytes"];
  return metrics.map(metric => ({
    family: spec.family,
    metric,
    finestScope: spec.scope,
    state: truncated ? "delayed" : "healthy",
    checkedAt: Date.now(),
    detail: truncated ? `${spec.dataset} reached its bounded row limit` : undefined,
  }));
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
function rateLimitResetAt(headers: Headers, now = Date.now()): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1_000;
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(now, timestamp);
  }
  const resetSeconds = headers.get("ratelimit")?.match(/(?:^|;)\s*t=(\d+)/i)?.[1];
  return now + (resetSeconds ? Number(resetSeconds) * 1_000 : 5 * 60_000);
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
function numberValue(value: unknown): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function dailyBounds(day: string | undefined, startsAt: number, endsAt: number): { start: number; end: number } {
  if (!day) return { start: startsAt, end: endsAt };
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(start) ? { start, end: start + DAY_MS } : { start: startsAt, end: endsAt };
}
function isBrollyScript(value: string, configured?: string): boolean {
  return value === (configured ?? "brolly-guard") || value === "brolly-guard" || value.startsWith("brolly-guard-");
}
