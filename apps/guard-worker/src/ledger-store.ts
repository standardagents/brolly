import {
  METRIC_CATALOG_VERSION,
  METRIC_DEFINITIONS,
  localDayAt,
  localDayBounds,
  resourceHashBucket,
  resourceHashSegment,
  resourceId,
  worstQuality,
  type AggregationKind,
  type AssetRef,
  type CollectorCoverage,
  type DataQualityState,
  type LedgerRunBudget,
  type MetricSample,
  type Resource,
  type UsageObservation,
} from "@standardagents/brolly-core";
import { applyAccumulatorObservations, type AccumulatorChange, type AccumulatorPayload } from "./ledger-accumulator.js";

const MAX_BATCH = 100;
const MAX_SHARD_BYTES = 1_500_000;
const SPLIT_DEPTH = 4;
const AGGREGATION_BY_METRIC = new Map(METRIC_DEFINITIONS.map(definition => [definition.id, definition.aggregationKind]));

interface ShardGroup {
  key: string;
  accountId: string;
  productFamily: string;
  scopeType: string;
  localDay: string;
  billingCycleId: string;
  bucket: number;
  splitDepth: number;
  splitSegment: number;
  observations: UsageObservation[];
  resourceIds: Map<UsageObservation, string>;
  payload: AccumulatorPayload | null;
  version: number;
}

interface CycleRow {
  resource_id: string;
  metrics_json: string;
  estimated_cost_usd: number | null;
  completeness: DataQualityState;
  sampling_json: string;
}

export class LedgerStore {
  constructor(private readonly db: D1Database, private readonly budget?: LedgerRunBudget) {}

  async syncMetricCatalog(): Promise<void> {
    const statements = METRIC_DEFINITIONS.map(definition => this.db.prepare(
      `INSERT INTO metric_definitions(
         id,product_family,metric_key,display_name,unit,aggregation_kind,billing_mapping,
         collector_key,finest_scope,pricing_version_id,active,catalog_version
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
       ON CONFLICT(id) DO UPDATE SET
         display_name=excluded.display_name,unit=excluded.unit,aggregation_kind=excluded.aggregation_kind,
         billing_mapping=excluded.billing_mapping,collector_key=excluded.collector_key,
         finest_scope=excluded.finest_scope,pricing_version_id=excluded.pricing_version_id,
         active=excluded.active,catalog_version=excluded.catalog_version`,
    ).bind(
      definition.id, definition.productFamily, definition.metricKey, definition.displayName,
      definition.unit, definition.aggregationKind, definition.billingMapping, definition.collectorKey,
      definition.finestScope, definition.pricingVersionId ?? null, definition.active ? 1 : 0,
      METRIC_CATALOG_VERSION,
    ));
    await this.writeBatches(statements);
  }

  async claimDueCollector(accountId: string, collectorKey: string, cadenceMs: number, now: number, force = false): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT INTO collector_state(
         account_id,collector_key,partition_key,next_eligible_at,last_started_at,last_status
       ) VALUES(?1,?2,'',?3,?4,'running')
       ON CONFLICT(account_id,collector_key,partition_key) DO UPDATE SET
         next_eligible_at=excluded.next_eligible_at,last_started_at=excluded.last_started_at,last_status='running',last_error=NULL
       WHERE ?5=1 OR collector_state.next_eligible_at<=?4 OR collector_state.last_status='running' AND collector_state.last_started_at<?6`,
    ).bind(accountId, collectorKey, now + cadenceMs, now, force ? 1 : 0, now - 2 * cadenceMs).run();
    this.chargeMeta(result.meta);
    return Number(result.meta.changes ?? 0) === 1;
  }

  async collectorCursor<T>(accountId: string, collectorKey: string, partitionKey = ""): Promise<T | null> {
    const row = await this.db.prepare(
      `SELECT cursor_json FROM collector_state WHERE account_id=?1 AND collector_key=?2 AND partition_key=?3 LIMIT 1`,
    ).bind(accountId, collectorKey, partitionKey).first<{ cursor_json: string | null }>();
    this.chargeRead(row ? 1 : 0);
    if (!row?.cursor_json) return null;
    try { return JSON.parse(row.cursor_json) as T; } catch { return null; }
  }

  async startMonitorRun(accountId: string, kind: string, now = Date.now()): Promise<string> {
    const id = crypto.randomUUID();
    const result = await this.db.prepare(
      `INSERT INTO monitor_runs(id,account_id,kind,started_at,status,coverage_status)
       VALUES(?1,?2,?3,?4,'running','partial')`,
    ).bind(id, accountId, kind, now).run();
    this.chargeMeta(result.meta);
    return id;
  }

  async finishMonitorRun(runId: string, accountId: string, localDay: string, values: {
    startedAt: number; datasetsQueried: number; rowsReturned: number; samplesNormalized: number;
    continuation?: unknown; errors?: string[]; deferredCollectors?: string[]; complete: boolean;
  }): Promise<void> {
    const now = Date.now();
    const usage = this.budget?.usage;
    const errors = values.errors ?? [];
    const deferred = values.deferredCollectors ?? [];
    const estimatedCostUsd = estimateMonitoringCost({
      graphqlQueries: usage?.graphqlQueries ?? 0,
      restRequests: usage?.restRequests ?? 0,
      d1RowsRead: usage?.d1RowsRead ?? 0,
      d1RowsWritten: usage?.d1RowsWritten ?? 0,
      workerCpuMs: now - values.startedAt,
    });
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE monitor_runs SET
           completed_at=?2,duration_ms=?3,graphql_queries=?4,rest_requests=?5,datasets_queried=?6,
           rows_returned=?7,d1_rows_read=?8,d1_rows_written=?9,samples_normalized=?10,
           continuation_json=?11,errors_json=?12,deferred_collectors_json=?13,
           coverage_status=?14,status=?15 WHERE id=?1`,
      ).bind(
        runId, now, now - values.startedAt, usage?.graphqlQueries ?? 0, usage?.restRequests ?? 0,
        values.datasetsQueried, values.rowsReturned, usage?.d1RowsRead ?? 0, usage?.d1RowsWritten ?? 0,
        values.samplesNormalized, values.continuation === undefined ? null : JSON.stringify(values.continuation),
        JSON.stringify(errors), JSON.stringify(deferred), values.complete ? "complete" : "partial",
        errors.length ? "failed" : values.complete ? "complete" : "partial",
      ),
      this.db.prepare(
        `INSERT INTO monitor_usage_daily(
           account_id,local_day,graphql_queries,graphql_query_budget,rest_requests,rest_request_budget,
           d1_rows_read,d1_rows_written,worker_requests,worker_cpu_ms,estimated_cost_usd,
           deferred_collectors_json,updated_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,?10,?11,?12)
         ON CONFLICT(account_id,local_day) DO UPDATE SET
           graphql_queries=monitor_usage_daily.graphql_queries+excluded.graphql_queries,
           graphql_query_budget=monitor_usage_daily.graphql_query_budget+excluded.graphql_query_budget,
           rest_requests=monitor_usage_daily.rest_requests+excluded.rest_requests,
           rest_request_budget=monitor_usage_daily.rest_request_budget+excluded.rest_request_budget,
           d1_rows_read=monitor_usage_daily.d1_rows_read+excluded.d1_rows_read,
           d1_rows_written=monitor_usage_daily.d1_rows_written+excluded.d1_rows_written,
           worker_requests=monitor_usage_daily.worker_requests+1,
           worker_cpu_ms=monitor_usage_daily.worker_cpu_ms+excluded.worker_cpu_ms,
           estimated_cost_usd=monitor_usage_daily.estimated_cost_usd+excluded.estimated_cost_usd,
           deferred_collectors_json=excluded.deferred_collectors_json,updated_at=excluded.updated_at`,
      ).bind(
        accountId, localDay, usage?.graphqlQueries ?? 0, this.budget?.limits.graphqlQueries ?? 0,
        usage?.restRequests ?? 0, this.budget?.limits.restRequests ?? 0,
        usage?.d1RowsRead ?? 0, usage?.d1RowsWritten ?? 0, now - values.startedAt,
        estimatedCostUsd, JSON.stringify(deferred), now,
      ),
    ]);
    for (const result of results) this.chargeMeta(result.meta);
  }

  async saveResourceHierarchy(observations: UsageObservation[], recordActivity = true): Promise<Map<UsageObservation, string>> {
    const resources = new Map<string, Resource>();
    const observationIds = new Map<UsageObservation, string>();
    for (const observation of observations) {
      const exact = resourceFromAsset(
        observation.sample.asset,
        observation.quality,
        recordActivity && observation.sample.value > 0 ? observation.sample.end : null,
      );
      observationIds.set(observation, exact.id);
      resources.set(exact.id, exact);
      for (const parent of parentResources(observation.sample.asset, observation.quality, observation.sample.end)) resources.set(parent.id, parent);
    }
    const orderedResources = [...resources.values()].sort((left, right) => resourceDepth(left) - resourceDepth(right));
    this.budget?.observePeak("resourcesPerTransaction", Math.min(orderedResources.length, this.transactionLimit()));
    const statements = orderedResources.map(resource => this.db.prepare(
      `INSERT INTO resources(
         id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,
         first_seen_at,last_seen_at,last_active_at,coverage_status,control_capability,runtime_fuse_status,
         auto_quarantine_policy,tier,excluded,collector_key,dataset,metadata_json
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
       ON CONFLICT(id) DO UPDATE SET
         parent_resource_id=COALESCE(excluded.parent_resource_id,resources.parent_resource_id),
         display_name=excluded.display_name,last_seen_at=MAX(resources.last_seen_at,excluded.last_seen_at),
         last_active_at=CASE
           WHEN resources.last_active_at IS NULL THEN excluded.last_active_at
           WHEN excluded.last_active_at IS NULL THEN resources.last_active_at
           ELSE MAX(resources.last_active_at,excluded.last_active_at)
         END,
         coverage_status=excluded.coverage_status,
         control_capability=CASE WHEN resources.control_capability='none' THEN excluded.control_capability ELSE resources.control_capability END,
         runtime_fuse_status=CASE WHEN resources.runtime_fuse_status IN ('verified','unhealthy') THEN resources.runtime_fuse_status ELSE excluded.runtime_fuse_status END,
         tier=CASE
           WHEN resources.tier='control_plane' OR excluded.tier='control_plane' THEN 'control_plane'
           WHEN resources.tier!='unclassified' THEN resources.tier
           ELSE excluded.tier
         END,
         excluded=MAX(resources.excluded,excluded.excluded),
         collector_key=COALESCE(excluded.collector_key,resources.collector_key),
         dataset=COALESCE(excluded.dataset,resources.dataset),
         metadata_json=json_patch(resources.metadata_json,excluded.metadata_json)
       WHERE resources.last_seen_at<excluded.last_seen_at-3600000
          OR resources.last_active_at IS NULL AND excluded.last_active_at IS NOT NULL
          OR resources.last_active_at<excluded.last_active_at-3600000
          OR resources.control_capability='none' AND excluded.control_capability!='none'
          OR resources.runtime_fuse_status NOT IN ('verified','unhealthy')
             AND resources.runtime_fuse_status!=excluded.runtime_fuse_status
          OR excluded.tier='control_plane' AND resources.tier!='control_plane'
          OR resources.excluded<excluded.excluded
          OR json_patch(resources.metadata_json,excluded.metadata_json)!=resources.metadata_json`,
    ).bind(
      resource.id, resource.accountId, resource.parentResourceId, resource.productFamily, resource.resourceType,
      resource.cloudflareId, resource.displayName, resource.firstSeenAt, resource.lastSeenAt, resource.lastActiveAt,
      resource.coverageStatus, resource.controlCapability, resource.runtimeFuseStatus,
      resource.autoQuarantinePolicy, resource.tier, resource.excluded ? 1 : 0,
      observations.find(item => observationIds.get(item) === resource.id)?.collectorKey ?? null,
      observations.find(item => observationIds.get(item) === resource.id)?.dataset ?? null,
      JSON.stringify(resource.metadata),
    ));
    await this.writeBatches(statements);
    return observationIds;
  }

  async saveCapabilities(items: CollectorCoverage[]): Promise<void> {
    const statements = items.map(item => this.db.prepare(
      `INSERT INTO collector_capabilities(
         account_id,collector_key,dataset,available,retention_days,sampling_behavior,finest_scope,
         last_verified_at,error_code,human_explanation,state,watermark_at
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
       ON CONFLICT(account_id,collector_key,dataset) DO UPDATE SET
         available=excluded.available,retention_days=excluded.retention_days,
         sampling_behavior=excluded.sampling_behavior,finest_scope=excluded.finest_scope,
         last_verified_at=excluded.last_verified_at,error_code=excluded.error_code,
         human_explanation=excluded.human_explanation,state=excluded.state,watermark_at=excluded.watermark_at`,
    ).bind(
      item.accountId, item.collectorKey, item.dataset, item.available ? 1 : 0, item.retentionDays,
      item.samplingBehavior, item.finestScope, item.lastVerifiedAt, item.errorCode,
      item.humanExplanation, item.state, item.watermarkAt,
    ));
    await this.writeBatches(statements);
  }

  async saveInventory(assets: AssetRef[], collectorKey = "rest:inventory", dataset = "account-resources"): Promise<void> {
    if (!assets.length) return;
    const now = Date.now();
    const observations = assets.map(asset => ({
      collectorKey,
      dataset,
      sample: {
        asset,
        metric: "__inventory__",
        unit: "count" as const,
        value: 0,
        start: now,
        end: now,
        source: "rest" as const,
      },
      quality: "complete" as const,
      sampleInterval: 1,
      watermarkAt: now,
      historical: false,
    }));
    await this.saveResourceHierarchy(observations, false);
  }

  async currentBillingCycle(accountId: string, now: number): Promise<{ id: string; startsAt: number; endsAt: number; approximate: boolean }> {
    const row = await this.db.prepare(
      `SELECT id,starts_at,ends_at,approximate FROM billing_cycles
       WHERE account_id=?1 AND starts_at<=?2 AND ends_at>?2
       ORDER BY approximate ASC,reconciled_at DESC LIMIT 1`,
    ).bind(accountId, now).first<{ id: string; starts_at: number; ends_at: number; approximate: number }>();
    this.chargeRead(row ? 1 : 0);
    if (row) return { id: row.id, startsAt: row.starts_at, endsAt: row.ends_at, approximate: row.approximate === 1 };
    const date = new Date(now);
    const startsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const endsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const id = `${accountId}:${startsAt}:${endsAt}`;
    const result = await this.db.prepare(
      `INSERT OR IGNORE INTO billing_cycles(id,account_id,starts_at,ends_at,status,currency,approximate)
       VALUES(?1,?2,?3,?4,'open','USD',1)`,
    ).bind(id, accountId, startsAt, endsAt).run();
    this.chargeMeta(result.meta);
    return { id, startsAt, endsAt, approximate: true };
  }

  async applyObservations(observations: UsageObservation[], timeZone: string): Promise<AccumulatorChange[]> {
    if (!observations.length) return [];
    const resourceIds = await this.saveResourceHierarchy(observations, true);
    const cyclesByTimestamp = new Map<number, Awaited<ReturnType<LedgerStore["currentBillingCycle"]>>>();
    for (const observation of observations) {
      const timestamp = Math.max(observation.sample.start, observation.sample.end - 1);
      if (!cyclesByTimestamp.has(timestamp)) cyclesByTimestamp.set(
        timestamp,
        await this.currentBillingCycle(observation.sample.asset.accountId, timestamp),
      );
    }
    const observationsByCycle = new Map<string, UsageObservation[]>();
    for (const observation of observations) {
      const timestamp = Math.max(observation.sample.start, observation.sample.end - 1);
      const cycleId = cyclesByTimestamp.get(timestamp)!.id;
      observationsByCycle.set(cycleId, [...(observationsByCycle.get(cycleId) ?? []), observation]);
    }
    const groups = await this.loadShards([...observationsByCycle.entries()].flatMap(([cycleId, items]) =>
      groupObservations(items, resourceIds, cycleId, timeZone)));
    const seedsByCycle = new Map<string, Map<string, Record<string, {
      value: number;
      estimatedCostUsd: number;
      quality?: DataQualityState;
      sampleInterval?: number | null;
    }>>>();
    for (const cycleId of observationsByCycle.keys()) {
      seedsByCycle.set(cycleId, await this.loadCycleSeeds(groups.filter(group => group.billingCycleId === cycleId), cycleId));
    }
    const aggregationKinds = new Map(METRIC_DEFINITIONS.map(definition => [definition.id, definition.aggregationKind]));
    const changes: AccumulatorChange[] = [];
    const writes: D1PreparedStatement[] = [];
    const now = Date.now();
    for (const group of groups) {
      const applied = applyAccumulatorObservations(
        group.payload,
        group.observations,
        group.resourceIds,
        aggregationKinds,
        seedsByCycle.get(group.billingCycleId) ?? new Map(),
      );
      changes.push(...applied.changes.map(change => ({
        ...change,
        localDay: group.localDay,
        billingCycleId: group.billingCycleId,
      })));
      const parts = splitOversizedShard(group, applied.payload);
      if (parts.some(part => part.group.splitDepth !== group.splitDepth)) writes.push(this.db.prepare(
        `DELETE FROM usage_accumulator_shards
         WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND local_day=?4
           AND billing_cycle_id=?5 AND resource_hash_bucket=?6`,
      ).bind(group.accountId, group.productFamily, group.scopeType, group.localDay, group.billingCycleId, group.bucket));
      for (const part of parts) {
        const payloadJson = JSON.stringify(part.payload);
        if (new TextEncoder().encode(payloadJson).byteLength > MAX_SHARD_BYTES) throw new Error(`Usage accumulator shard ${part.group.key} exceeded its safe row size after splitting`);
        writes.push(this.db.prepare(
          `INSERT INTO usage_accumulator_shards(
             account_id,product_family,scope_type,local_day,billing_cycle_id,resource_hash_bucket,
             split_depth,split_segment,payload_json,source_watermarks_json,quality_flags_json,version,updated_at
           ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'{}','[]',?10,?11)
           ON CONFLICT(account_id,product_family,scope_type,local_day,billing_cycle_id,resource_hash_bucket,split_depth,split_segment)
           DO UPDATE SET payload_json=excluded.payload_json,version=excluded.version,updated_at=excluded.updated_at`,
        ).bind(
          part.group.accountId, part.group.productFamily, part.group.scopeType, part.group.localDay,
          part.group.billingCycleId, part.group.bucket, part.group.splitDepth, part.group.splitSegment,
          payloadJson, part.group.version + 1, now,
        ));
      }
    }
    await this.writeBatches(writes);
    const reconciled = await this.reconcilePeriodChanges(changes);
    return [...reconciled, ...costChanges(reconciled)];
  }

  async sealCompletedDays(accountId: string, timeZone: string, now = Date.now(), shardLimit = 16): Promise<number> {
    const today = localDayAt(now, timeZone);
    const rows = await this.db.prepare(
      `SELECT account_id,product_family,scope_type,local_day,billing_cycle_id,resource_hash_bucket,
         split_depth,split_segment,payload_json,version,updated_at
       FROM usage_accumulator_shards
       WHERE account_id=?1 AND local_day<?2
         AND (json_extract(payload_json,'$.sealedAt') IS NULL OR updated_at>json_extract(payload_json,'$.sealedAt'))
       ORDER BY local_day ASC,resource_hash_bucket ASC LIMIT ?3`,
    ).bind(accountId, today, shardLimit).all<Record<string, unknown>>();
    this.chargeMeta(rows.meta);
    let sealed = 0;
    const dailyPayloadCache = new Map<string, AccumulatorPayload[]>();
    const cyclePayloadCache = new Map<string, AccumulatorPayload[]>();
    for (const row of rows.results) {
      const payload = parsePayload(String(row.payload_json));
      const bounds = localDayBounds(String(row.local_day), timeZone);
      const dailyCacheKey = [row.account_id, row.product_family, row.scope_type, row.local_day, row.resource_hash_bucket].join("|");
      let dailyPayloads = dailyPayloadCache.get(dailyCacheKey);
      if (!dailyPayloads) {
        const related = await this.db.prepare(
          `SELECT payload_json FROM usage_accumulator_shards
           WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND local_day=?4
             AND resource_hash_bucket=?5`,
        ).bind(row.account_id, row.product_family, row.scope_type, row.local_day, row.resource_hash_bucket)
          .all<{ payload_json: string }>();
        this.chargeMeta(related.meta);
        dailyPayloads = related.results.map(item => parsePayload(item.payload_json));
        dailyPayloadCache.set(dailyCacheKey, dailyPayloads);
      }
      const cycleCacheKey = [row.account_id, row.product_family, row.scope_type, row.billing_cycle_id, row.resource_hash_bucket].join("|");
      let cyclePayloads = cyclePayloadCache.get(cycleCacheKey);
      if (!cyclePayloads) {
        const related = await this.db.prepare(
          `SELECT payload_json FROM usage_accumulator_shards
           WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND billing_cycle_id=?4
             AND resource_hash_bucket=?5`,
        ).bind(row.account_id, row.product_family, row.scope_type, row.billing_cycle_id, row.resource_hash_bucket)
          .all<{ payload_json: string }>();
        this.chargeMeta(related.meta);
        cyclePayloads = related.results.map(item => parsePayload(item.payload_json));
        cyclePayloadCache.set(cycleCacheKey, cyclePayloads);
      }
      const statements: D1PreparedStatement[] = [];
      for (const id of Object.keys(payload.resources)) {
        const daily = aggregateDailyResource(dailyPayloads, id);
        const cycle = aggregateDailyResource(cyclePayloads, id);
        const metrics = daily.metrics;
        const cycleMetrics = cycle.metrics;
        const estimatedDay = daily.estimatedCostUsd;
        const estimatedCycle = cycle.estimatedCostUsd;
        const cycleQuality = cycle.quality;
        const cycleSampling = cycle.sampling;
        statements.push(this.db.prepare(
          `INSERT INTO usage_daily(
             resource_id,local_day,period_start_at,period_end_at,metrics_json,estimated_cost_usd,
             authoritative_allocated_cost_usd,completeness,sampling_json,sealed,revision,revised_at
           ) VALUES(?1,?2,?3,?4,?5,?6,NULL,?7,?8,1,1,?9)
           ON CONFLICT(resource_id,local_day) DO UPDATE SET
             metrics_json=json_patch(usage_daily.metrics_json,excluded.metrics_json),estimated_cost_usd=excluded.estimated_cost_usd,
             completeness=excluded.completeness,sampling_json=excluded.sampling_json,sealed=1,
             revision=usage_daily.revision+1,revised_at=excluded.revised_at`,
        ).bind(id, row.local_day, bounds.start, bounds.end, JSON.stringify(metrics), estimatedDay, daily.quality, JSON.stringify(daily.sampling), now));
        statements.push(this.db.prepare(
          `INSERT INTO usage_cycle_totals(
             resource_id,billing_cycle_id,metrics_json,estimated_cost_usd,authoritative_allocated_cost_usd,
             completeness,sampling_json,sealed,revision,revised_at
           ) VALUES(?1,?2,?3,?4,NULL,?5,?6,0,1,?7)
           ON CONFLICT(resource_id,billing_cycle_id) DO UPDATE SET
             metrics_json=json_patch(usage_cycle_totals.metrics_json,excluded.metrics_json),estimated_cost_usd=excluded.estimated_cost_usd,
             completeness=excluded.completeness,sampling_json=excluded.sampling_json,
             revision=usage_cycle_totals.revision+1,revised_at=excluded.revised_at`,
        ).bind(id, row.billing_cycle_id, JSON.stringify(cycleMetrics), estimatedCycle, cycleQuality, JSON.stringify(cycleSampling), now));
      }
      payload.sealedAt = now;
      statements.push(this.db.prepare(
        `UPDATE usage_accumulator_shards SET payload_json=?9,version=version+1,updated_at=?10
         WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND local_day=?4
           AND billing_cycle_id=?5 AND resource_hash_bucket=?6 AND split_depth=?7 AND split_segment=?8`,
      ).bind(
        row.account_id, row.product_family, row.scope_type, row.local_day, row.billing_cycle_id,
        row.resource_hash_bucket, row.split_depth, row.split_segment, JSON.stringify(payload), now,
      ));
      await this.writeBatches(statements);
      sealed += 1;
    }
    return sealed;
  }

  private async reconcilePeriodChanges(changes: AccumulatorChange[]): Promise<AccumulatorChange[]> {
    const dailyCache = new Map<string, AccumulatorPayload[]>();
    const cycleCache = new Map<string, AccumulatorPayload[]>();
    const reconciled: AccumulatorChange[] = [];
    for (const change of changes) {
      if (!change.localDay || !change.billingCycleId) {
        reconciled.push(change);
        continue;
      }
      const [encodedAccount = "", encodedFamily = "", encodedScope = ""] = change.resourceId.split(":");
      const accountId = decodeURIComponent(encodedAccount);
      const productFamily = decodeURIComponent(encodedFamily);
      const scopeType = decodeURIComponent(encodedScope);
      const bucket = resourceHashBucket(change.resourceId);
      const dailyKey = [accountId, productFamily, scopeType, change.localDay, bucket].join("|");
      let dailyPayloads = dailyCache.get(dailyKey);
      if (!dailyPayloads) {
        const result = await this.db.prepare(
          `SELECT payload_json FROM usage_accumulator_shards
           WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND local_day=?4
             AND resource_hash_bucket=?5`,
        ).bind(accountId, productFamily, scopeType, change.localDay, bucket).all<{ payload_json: string }>();
        this.chargeMeta(result.meta);
        dailyPayloads = result.results.map(row => parsePayload(row.payload_json));
        dailyCache.set(dailyKey, dailyPayloads);
      }
      const cycleKey = [accountId, productFamily, scopeType, change.billingCycleId, bucket].join("|");
      let cyclePayloads = cycleCache.get(cycleKey);
      if (!cyclePayloads) {
        const result = await this.db.prepare(
          `SELECT payload_json FROM usage_accumulator_shards
           WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND billing_cycle_id=?4
             AND resource_hash_bucket=?5`,
        ).bind(accountId, productFamily, scopeType, change.billingCycleId, bucket).all<{ payload_json: string }>();
        this.chargeMeta(result.meta);
        cyclePayloads = result.results.map(row => parsePayload(row.payload_json));
        cycleCache.set(cycleKey, cyclePayloads);
      }
      const daily = aggregateDailyResource(dailyPayloads, change.resourceId);
      const cycle = aggregateDailyResource(cyclePayloads, change.resourceId);
      reconciled.push({
        ...change,
        dayValue: daily.metrics[change.metricDefinitionId] ?? change.dayValue,
        cycleValue: cycle.metrics[change.metricDefinitionId] ?? change.cycleValue,
        estimatedDayUsd: daily.estimatedByMetric[change.metricDefinitionId] ?? change.estimatedDayUsd,
        estimatedCycleUsd: cycle.estimatedByMetric[change.metricDefinitionId] ?? change.estimatedCycleUsd,
        quality: daily.qualityByMetric[change.metricDefinitionId] ?? change.quality,
        sampleInterval: Object.hasOwn(daily.sampling, change.metricDefinitionId)
          ? daily.sampling[change.metricDefinitionId]!
          : change.sampleInterval,
        cycleQuality: cycle.qualityByMetric[change.metricDefinitionId] ?? change.cycleQuality,
        cycleSampleInterval: Object.hasOwn(cycle.sampling, change.metricDefinitionId)
          ? cycle.sampling[change.metricDefinitionId]!
          : change.cycleSampleInterval,
      });
    }
    return reconciled;
  }

  async persistCollectorState(accountId: string, collectorKey: string, partitionKey: string, values: {
    cursor?: unknown; watermarkAt?: number | null; nextEligibleAt: number; status: string; error?: string;
  }): Promise<void> {
    const now = Date.now();
    const result = await this.db.prepare(
      `INSERT INTO collector_state(
         account_id,collector_key,partition_key,cursor_json,high_watermark_at,retry_count,next_eligible_at,
         last_started_at,last_completed_at,last_error,last_status
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
       ON CONFLICT(account_id,collector_key,partition_key) DO UPDATE SET
         cursor_json=excluded.cursor_json,high_watermark_at=excluded.high_watermark_at,
         retry_count=excluded.retry_count,next_eligible_at=excluded.next_eligible_at,
         last_completed_at=excluded.last_completed_at,last_error=excluded.last_error,last_status=excluded.last_status`,
    ).bind(
      accountId, collectorKey, partitionKey, values.cursor === undefined ? null : JSON.stringify(values.cursor),
      values.watermarkAt ?? null, values.error ? 1 : 0, values.nextEligibleAt, now,
      values.status === "complete" ? now : null, values.error?.slice(0, 2000) ?? null, values.status,
    ).run();
    this.chargeMeta(result.meta);
  }

  private async loadShards(groups: ShardGroup[]): Promise<ShardGroup[]> {
    const statements = groups.map(group => this.db.prepare(
      `SELECT payload_json,version,split_depth,split_segment FROM usage_accumulator_shards
       WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND local_day=?4
         AND billing_cycle_id=?5 AND resource_hash_bucket=?6`,
    ).bind(group.accountId, group.productFamily, group.scopeType, group.localDay, group.billingCycleId, group.bucket));
    const results = await this.readBatches(statements);
    const expanded: ShardGroup[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const base = groups[index]!;
      const rows = results[index]?.results as Array<{ payload_json: string; version: number; split_depth: number; split_segment: number }> | undefined;
      const depth = rows?.reduce((maximum, row) => Math.max(maximum, Number(row.split_depth)), 0) ?? 0;
      const bySegment = new Map((rows ?? []).filter(row => Number(row.split_depth) === depth).map(row => [Number(row.split_segment), row]));
      const partitions = new Map<number, ShardGroup>();
      for (const observation of base.observations) {
        const id = base.resourceIds.get(observation)!;
        const segment = depth === 0 ? 0 : resourceHashSegment(id, depth);
        const row = bySegment.get(segment);
        const group: ShardGroup = partitions.get(segment) ?? {
          ...base,
          key: `${base.key}|${depth}|${segment}`,
          splitDepth: depth,
          splitSegment: segment,
          observations: [],
          resourceIds: new Map(),
          payload: row ? parsePayload(row.payload_json) : null,
          version: Number(row?.version ?? 0),
        };
        group.observations.push(observation);
        group.resourceIds.set(observation, id);
        partitions.set(segment, group);
      }
      expanded.push(...partitions.values());
    }
    return expanded;
  }

  private async loadCycleSeeds(groups: ShardGroup[], cycleId: string): Promise<Map<string, Record<string, {
    value: number;
    estimatedCostUsd: number;
    quality?: DataQualityState;
    sampleInterval?: number | null;
  }>>> {
    const emptyGroups = groups.filter(group => !group.payload);
    const resourceIds = [...new Set(emptyGroups.flatMap(group => [...group.resourceIds.values()]))];
    const statements: D1PreparedStatement[] = [];
    for (let offset = 0; offset < resourceIds.length; offset += 90) {
      const ids = resourceIds.slice(offset, offset + 90);
      const placeholders = ids.map((_, index) => `?${index + 2}`).join(",");
      statements.push(this.db.prepare(
        `SELECT resource_id,metrics_json,estimated_cost_usd,completeness,sampling_json FROM usage_cycle_totals
         WHERE billing_cycle_id=?1 AND resource_id IN (${placeholders})`,
      ).bind(cycleId, ...ids));
    }
    const seeds = new Map<string, Record<string, {
      value: number;
      estimatedCostUsd: number;
      quality?: DataQualityState;
      sampleInterval?: number | null;
    }>>();
    for (const result of await this.readBatches(statements)) {
      for (const row of result.results as unknown as CycleRow[]) {
        const metrics = parseNumberMap(row.metrics_json);
        const sampling = parseNullableNumberMap(row.sampling_json);
        const estimated = Number(row.estimated_cost_usd ?? 0);
        const total = Object.values(metrics).reduce((sum, value) => sum + Math.abs(value), 0) || 1;
        seeds.set(row.resource_id, Object.fromEntries(Object.entries(metrics).map(([metricId, value]) => [metricId, {
          value, estimatedCostUsd: estimated * Math.abs(value) / total,
          quality: row.completeness,
          sampleInterval: sampling[metricId] ?? null,
        }])));
      }
    }
    const priorShardStatements = emptyGroups.map(group => this.db.prepare(
      `SELECT payload_json FROM usage_accumulator_shards
       WHERE account_id=?1 AND product_family=?2 AND scope_type=?3
         AND billing_cycle_id=?4 AND resource_hash_bucket=?5 AND local_day<?6
       ORDER BY local_day DESC,split_depth DESC,split_segment ASC LIMIT 16`,
    ).bind(
      group.accountId, group.productFamily, group.scopeType, group.billingCycleId,
      group.bucket, group.localDay,
    ));
    const priorShards = await this.readBatches(priorShardStatements);
    for (let index = 0; index < emptyGroups.length; index += 1) {
      const rows = priorShards[index]?.results as Array<{ payload_json?: string }> | undefined;
      const wanted = new Set(emptyGroups[index]!.resourceIds.values());
      for (const row of rows ?? []) {
        if (!row.payload_json) continue;
        const prior = parsePayload(row.payload_json);
        for (const resourceIdValue of wanted) {
          if (seeds.has(resourceIdValue) && prior.resources[resourceIdValue] === undefined) continue;
          const resource = prior.resources[resourceIdValue];
          if (!resource) continue;
          seeds.set(resourceIdValue, Object.fromEntries(Object.entries(resource.metrics).map(([metricId, metric]) => [metricId, {
            value: metric.cycle,
            estimatedCostUsd: metric.estimatedCycleUsd,
            quality: metric.cycleQuality ?? metric.quality,
            sampleInterval: metric.cycleSampleInterval ?? metric.sampleInterval,
          }])));
          wanted.delete(resourceIdValue);
        }
        if (!wanted.size) break;
      }
    }
    return seeds;
  }

  private async readBatches(statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    const output: D1Result<unknown>[] = [];
    const batchSize = this.transactionLimit();
    for (let offset = 0; offset < statements.length; offset += batchSize) {
      const results = await this.db.batch(statements.slice(offset, offset + batchSize));
      for (const result of results) {
        this.chargeMeta(result.meta);
        output.push(result as D1Result<unknown>);
      }
    }
    return output;
  }

  private async writeBatches(statements: D1PreparedStatement[]): Promise<void> {
    const batchSize = this.transactionLimit();
    for (let offset = 0; offset < statements.length; offset += batchSize) {
      const results = await this.db.batch(statements.slice(offset, offset + batchSize));
      for (const result of results) this.chargeMeta(result.meta);
    }
  }

  private chargeRead(amount: number): void {
    this.budget?.charge("d1RowsRead", amount);
  }

  private transactionLimit(): number {
    return Math.max(1, Math.min(MAX_BATCH, this.budget?.limits.resourcesPerTransaction ?? MAX_BATCH));
  }

  private chargeMeta(meta: { rows_read?: number; rows_written?: number; changes?: number }): void {
    this.budget?.charge("d1RowsRead", meta.rows_read ?? 0);
    this.budget?.charge("d1RowsWritten", meta.rows_written ?? meta.changes ?? 0);
  }
}

export function estimateMonitoringCost(values: {
  graphqlQueries: number; restRequests: number; d1RowsRead: number; d1RowsWritten: number; workerCpuMs: number;
}): number {
  const workerRequests = 0.30 / 1_000_000;
  const cpu = values.workerCpuMs * (0.02 / 1_000_000);
  const reads = values.d1RowsRead * (0.001 / 1_000_000);
  const writes = values.d1RowsWritten * (1 / 1_000_000);
  return workerRequests + cpu + reads + writes;
}

export function expandUsageObservations(
  samples: MetricSample[],
  collectorKey: string,
  dataset: string,
  quality: DataQualityState,
  options: { sampleInterval?: number | null; watermarkAt?: number | null; historical?: boolean } = {},
): UsageObservation[] {
  const observations = new Map<string, UsageObservation>();
  for (const sample of samples) {
    const scopes = hierarchySamples(sample);
    for (const scoped of scopes) {
      const key = [scoped.asset.family, scoped.asset.scope, scoped.asset.id, scoped.metric, scoped.start, scoped.end].join(":");
      const existing = observations.get(key);
      if (existing) {
        existing.sample.value += scoped.value;
        existing.sample.estimatedCostUsd = (existing.sample.estimatedCostUsd ?? 0) + (scoped.estimatedCostUsd ?? 0);
        continue;
      }
      observations.set(key, {
        collectorKey, dataset, sample: structuredClone(scoped),
        quality: scoped.sampled ? "sampled" : quality,
        sampleInterval: options.sampleInterval ?? (scoped.sampled ? null : 1),
        watermarkAt: options.watermarkAt ?? scoped.end,
        historical: options.historical ?? false,
      });
    }
  }
  return [...observations.values()];
}

function groupObservations(
  observations: UsageObservation[],
  ids: Map<UsageObservation, string>,
  cycleId: string,
  timeZone: string,
): ShardGroup[] {
  const groups = new Map<string, ShardGroup>();
  for (const observation of observations) {
    const id = ids.get(observation)!;
    const day = localDayAt(Math.max(observation.sample.start, observation.sample.end - 1), timeZone);
    const scopeType = resourceType(observation.sample.asset);
    const shardFamily = scopeType === "account" ? "account" : observation.sample.asset.family;
    const bucket = resourceHashBucket(id);
    const key = [observation.sample.asset.accountId, shardFamily, scopeType, day, cycleId, bucket].join("|");
    const group: ShardGroup = groups.get(key) ?? {
      key, accountId: observation.sample.asset.accountId, productFamily: shardFamily,
      scopeType, localDay: day, billingCycleId: cycleId, bucket, observations: [], resourceIds: new Map(),
      splitDepth: 0, splitSegment: 0, payload: null, version: 0,
    };
    group.observations.push(observation);
    group.resourceIds.set(observation, id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function resourceFromAsset(asset: AssetRef, quality: DataQualityState, activeAt: number | null): Resource {
  const type = resourceType(asset);
  const parentResourceId = parentId(asset);
  const canonicalFamily = type === "account" ? "account" : asset.family;
  const tags = asset.tags ?? {};
  const controlCapability = asset.family === "queues" ? "queue_pause"
    : tags.brollyFuse === "true" && (asset.family === "workers" || asset.family === "durable_objects") ? "runtime_fuse" : "none";
  const controlPlane = asset.tier === "control_plane" || tags.brollyControlPlane === "true";
  const now = activeAt ?? Date.now();
  return {
    id: resourceId(asset.accountId, canonicalFamily, type, asset.id), accountId: asset.accountId,
    parentResourceId, productFamily: canonicalFamily, resourceType: type, cloudflareId: asset.id,
    displayName: asset.name ?? asset.id, firstSeenAt: now, lastSeenAt: now, lastActiveAt: activeAt,
    coverageStatus: quality, controlCapability,
    runtimeFuseStatus: tags.brollyFuseVerified === "true" ? "verified" : tags.brollyFuse === "true" ? "declared" : "unknown",
    autoQuarantinePolicy: "inherit", tier: asset.tier, excluded: controlPlane, metadata: tags,
  };
}

function parentResources(asset: AssetRef, quality: DataQualityState, seenAt: number): Resource[] {
  const account: AssetRef = {
    accountId: asset.accountId, family: "account", id: asset.accountId, name: "Cloudflare account",
    scope: "account", tier: "unclassified", tags: { ledgerLevel: "account" },
  };
  const product: AssetRef = {
    accountId: asset.accountId, family: asset.family, id: asset.family, name: productName(asset.family),
    scope: "account", tier: "unclassified", tags: { ledgerLevel: "product" },
  };
  const parents = [resourceFromAsset(account, quality, seenAt), resourceFromAsset(product, quality, seenAt)];
  if (asset.scope === "object" && asset.parentId) {
    parents.push(resourceFromAsset({
      accountId: asset.accountId, family: asset.family, id: asset.parentId, name: asset.parentId,
      scope: "namespace", tier: asset.tier, tags: asset.tags,
    }, quality, seenAt));
  }
  return parents;
}

function hierarchySamples(sample: MetricSample): MetricSample[] {
  const values = [sample];
  if (sample.asset.scope === "object" && sample.asset.parentId) {
    values.push({ ...sample, asset: {
      accountId: sample.asset.accountId, family: sample.asset.family, id: sample.asset.parentId,
      name: sample.asset.parentId, scope: "namespace", tier: sample.asset.tier, tags: sample.asset.tags,
    } });
  }
  values.push({ ...sample, asset: {
    accountId: sample.asset.accountId, family: sample.asset.family, id: sample.asset.family,
    name: productName(sample.asset.family), scope: "account", tier: "unclassified", tags: { ledgerLevel: "product" },
  } });
  values.push({ ...sample, asset: {
    accountId: sample.asset.accountId, family: sample.asset.family, id: sample.asset.accountId,
    name: "Cloudflare account", scope: "account", tier: "unclassified", tags: { ledgerLevel: "account" },
  } });
  return values;
}

function resourceType(asset: AssetRef): string {
  const level = asset.tags?.ledgerLevel;
  return level === "account" || level === "product" ? level : `${asset.family}:${asset.scope}`;
}

function parentId(asset: AssetRef): string | null {
  const type = resourceType(asset);
  if (type === "account") return null;
  if (type === "product") return resourceId(asset.accountId, "account", "account", asset.accountId);
  if (asset.scope === "object" && asset.parentId) return resourceId(asset.accountId, asset.family, `${asset.family}:namespace`, asset.parentId);
  return resourceId(asset.accountId, asset.family, "product", asset.family);
}

function productName(family: string): string {
  return family.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase());
}

function resourceDepth(resource: Resource): number {
  if (resource.resourceType === "account") return 0;
  if (resource.resourceType === "product") return 1;
  if (resource.resourceType.endsWith(":namespace")) return 2;
  return 3;
}

function parsePayload(value: string): AccumulatorPayload {
  try {
    const parsed = JSON.parse(value) as AccumulatorPayload;
    return parsed && parsed.resources ? parsed : { resources: {} };
  } catch {
    return { resources: {} };
  }
}

export function aggregateDailyResource(payloads: AccumulatorPayload[], resourceIdValue: string): {
  metrics: Record<string, number>;
  estimatedByMetric: Record<string, number>;
  estimatedCostUsd: number;
  quality: DataQualityState;
  qualityByMetric: Record<string, DataQualityState>;
  sampling: Record<string, number | null>;
} {
  const metrics: Record<string, number> = {};
  const estimatedByMetric: Record<string, number> = {};
  const qualityByMetric: Record<string, DataQualityState> = {};
  const sampling: Record<string, number | null> = {};
  const qualities: DataQualityState[] = [];
  let estimatedCostUsd = 0;
  for (const payload of payloads) {
    const resource = payload.resources[resourceIdValue];
    if (!resource) continue;
    for (const [metricId, metric] of Object.entries(resource.metrics)) {
      metrics[metricId] = AGGREGATION_BY_METRIC.get(metricId) === "maximum"
        ? Math.max(metrics[metricId] ?? Number.NEGATIVE_INFINITY, metric.day)
        : (metrics[metricId] ?? 0) + metric.day;
      estimatedByMetric[metricId] = (estimatedByMetric[metricId] ?? 0) + metric.estimatedDayUsd;
      estimatedCostUsd += metric.estimatedDayUsd;
      qualities.push(metric.quality);
      qualityByMetric[metricId] = worstQuality([qualityByMetric[metricId] ?? "complete", metric.quality]);
      const current = sampling[metricId];
      sampling[metricId] = current === null || metric.sampleInterval === null
        ? null
        : Math.max(current ?? 1, metric.sampleInterval);
    }
  }
  return { metrics, estimatedByMetric, estimatedCostUsd, quality: worstQuality(qualities), qualityByMetric, sampling };
}

function splitOversizedShard(group: ShardGroup, payload: AccumulatorPayload): Array<{ group: ShardGroup; payload: AccumulatorPayload }> {
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength <= MAX_SHARD_BYTES || group.splitDepth > 0) {
    return [{ group, payload }];
  }
  const resources = new Map<number, AccumulatorPayload["resources"]>();
  for (const [id, resource] of Object.entries(payload.resources)) {
    const segment = resourceHashSegment(id, SPLIT_DEPTH);
    const partition = resources.get(segment) ?? {};
    partition[id] = resource;
    resources.set(segment, partition);
  }
  return [...resources.entries()].map(([segment, partition]) => ({
    group: {
      ...group,
      key: `${group.key}|${SPLIT_DEPTH}|${segment}`,
      splitDepth: SPLIT_DEPTH,
      splitSegment: segment,
    },
    payload: { resources: partition, ...(payload.sealedAt === undefined ? {} : { sealedAt: payload.sealedAt }) },
  }));
}

function parseNumberMap(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

function costChanges(changes: AccumulatorChange[]): AccumulatorChange[] {
  const grouped = new Map<string, AccumulatorChange[]>();
  for (const change of changes) {
    const key = [change.resourceId, change.localDay ?? "", change.billingCycleId ?? ""].join("|");
    grouped.set(key, [...(grouped.get(key) ?? []), change]);
  }
  return [...grouped.values()].map(values => {
    const first = values[0]!;
    const canonicalFamily = decodeURIComponent(first.resourceId.split(":")[1] ?? "")
      || first.metricDefinitionId.split(":")[0]
      || "unknown";
    return {
      localDay: first.localDay,
      billingCycleId: first.billingCycleId,
      resourceId: first.resourceId,
      metricDefinitionId: `${canonicalFamily}:estimated_cost_usd`,
      metricKey: "estimated_cost_usd",
      intervalValue: values.reduce((sum, value) => sum + Math.max(0, value.intervalValue), 0),
      dayValue: values.reduce((sum, value) => sum + value.estimatedDayUsd, 0),
      cycleValue: values.reduce((sum, value) => sum + value.estimatedCycleUsd, 0),
      estimatedDayUsd: values.reduce((sum, value) => sum + value.estimatedDayUsd, 0),
      estimatedCycleUsd: values.reduce((sum, value) => sum + value.estimatedCycleUsd, 0),
      quality: worstQuality(values.map(value => value.quality)),
      sampleInterval: values.some(value => value.sampleInterval === null)
        ? null
        : Math.max(...values.map(value => value.sampleInterval ?? 1)),
      cycleQuality: worstQuality(values.map(value => value.cycleQuality)),
      cycleSampleInterval: values.some(value => value.cycleSampleInterval === null)
        ? null
        : Math.max(...values.map(value => value.cycleSampleInterval ?? 1)),
      watermarkAt: values.reduce<number | null>(
        (minimum, value) => value.watermarkAt === null ? minimum : Math.min(minimum ?? value.watermarkAt, value.watermarkAt),
        null,
      ),
      rollingBaseline: values.reduce((sum, value) => sum + value.rollingBaseline, 0),
      periodStartAt: Math.min(...values.map(value => value.periodStartAt)),
      periodEndAt: Math.max(...values.map(value => value.periodEndAt)),
      historical: values.some(value => value.historical),
    };
  });
}

function parseNullableNumberMap(value: string): Record<string, number | null> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number | null] => entry[1] === null || typeof entry[1] === "number"));
  } catch { return {}; }
}
