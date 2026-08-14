import { METRIC_CATALOG, localDayAt, localDayBounds, resourceId, type LedgerRunBudget } from "@standardagents/brolly-core";
import type { AccumulatorChange } from "./ledger-accumulator.js";
import type { BillingUsageRecord, CloudflareClient } from "./cloudflare.js";
import type { Env } from "./env.js";

const MAX_BATCH = 100;

export interface BillingReconciliationResult {
  available: boolean;
  complete: boolean;
  records: number;
  cycles: number;
  unknownProducts: string[];
  authoritativeCostUsd: number | null;
  alertChanges: AccumulatorChange[];
  error?: string;
}

export async function reconcileBilling(
  env: Env,
  client: CloudflareClient,
  budget?: LedgerRunBudget,
  now = Date.now(),
): Promise<BillingReconciliationResult> {
  const records = await client.billingUsage(now - 31 * 86_400_000, now);
  if (!records) return { available: false, complete: false, records: 0, cycles: 0, unknownProducts: [], authoritativeCostUsd: null, alertChanges: [] };
  const truncated = records.length > 20_000;
  const boundedRecords = records.slice(0, 20_000);
  const cycles = new Map<string, { id: string; startsAt: number; endsAt: number; currency: string; cost: number }>();
  const dailyAggregates = new Map<string, BillingAggregate>();
  const cycleAggregates = new Map<string, BillingAggregate>();
  const unknownProducts = new Set<string>();
  const resourceFamilies = new Set<string>();
  const billingMetrics = new Set<string>();
  const statements: D1PreparedStatement[] = [];
  const nowValue = Date.now();
  const timeZone = env.BROLLY_TIMEZONE ?? "UTC";
  for (const record of boundedRecords) {
    const family = normalizeFamily(record.x_ProductFamilyId ?? record.x_ProductFamilyName ?? "unknown");
    const metric = normalizeMetric(record.x_BillableMetricId ?? record.x_BillableMetricName ?? "unknown");
    const mappedMetric = billingCatalogMetric(family, metric);
    const mapped = mappedMetric !== null;
    if (!mapped) unknownProducts.add(`${family}/${metric}`);
    const chargeStart = safeDate(record.ChargePeriodStart, now - 86_400_000);
    const chargeEnd = safeDate(record.ChargePeriodEnd, now);
    const startsAt = safeDate(record.BillingPeriodStart, Date.UTC(new Date(chargeStart).getUTCFullYear(), new Date(chargeStart).getUTCMonth(), 1));
    const endsAt = safeDate(record.BillingPeriodEnd, Date.UTC(new Date(startsAt).getUTCFullYear(), new Date(startsAt).getUTCMonth() + 1, 1));
    const currency = record.BillingCurrency ?? "USD";
    const cycleId = `${env.BROLLY_ACCOUNT_ID}:${startsAt}:${endsAt}`;
    const cost = record.BilledCost ?? record.EffectiveCost ?? record.ListCost ?? 0;
    const cycle = cycles.get(cycleId) ?? { id: cycleId, startsAt, endsAt, currency, cost: 0 };
    cycle.cost += cost;
    cycles.set(cycleId, cycle);
    const lineId = billingLineId(env.BROLLY_ACCOUNT_ID, record, family, metric);
    const productResourceId = resourceId(env.BROLLY_ACCOUNT_ID, family, "product", family);
    const accountResourceId = resourceId(env.BROLLY_ACCOUNT_ID, "account", "account", env.BROLLY_ACCOUNT_ID);
    const metricId = `${family}:${mappedMetric ?? metric}`;
    const billedMetricId = `${family}:billed_cost_usd`;
    const localDay = localDayAt(chargeStart, timeZone);
    const localBounds = localDayBounds(localDay, timeZone);
    addBillingAggregate(dailyAggregates, `${productResourceId}:${localDay}`, {
      resourceId: productResourceId, periodKey: localDay, startsAt: localBounds.start, endsAt: localBounds.end,
      metricId, quantity: record.ConsumedQuantity, cost,
    });
    addBillingAggregate(dailyAggregates, `${productResourceId}:${localDay}`, {
      resourceId: productResourceId, periodKey: localDay, startsAt: localBounds.start, endsAt: localBounds.end,
      metricId: billedMetricId, quantity: cost, cost: 0,
    });
    addBillingAggregate(dailyAggregates, `${accountResourceId}:${localDay}`, {
      resourceId: accountResourceId, periodKey: localDay, startsAt: localBounds.start, endsAt: localBounds.end,
      metricId: "account:billed_cost_usd", quantity: cost, cost,
    });
    addBillingAggregate(cycleAggregates, `${productResourceId}:${cycleId}`, {
      resourceId: productResourceId, periodKey: cycleId, startsAt, endsAt, metricId, quantity: record.ConsumedQuantity, cost,
    });
    addBillingAggregate(cycleAggregates, `${productResourceId}:${cycleId}`, {
      resourceId: productResourceId, periodKey: cycleId, startsAt, endsAt,
      metricId: billedMetricId, quantity: cost, cost: 0,
    });
    addBillingAggregate(cycleAggregates, `${accountResourceId}:${cycleId}`, {
      resourceId: accountResourceId, periodKey: cycleId, startsAt, endsAt,
      metricId: "account:billed_cost_usd", quantity: cost, cost,
    });
    statements.push(env.DB.prepare(
      `INSERT INTO billing_line_items(
         id,billing_cycle_id,account_id,charge_period_start,charge_period_end,product_family,metric_key,
         description,consumed_quantity,consumed_unit,billed_cost,effective_cost,list_cost,currency,
         resource_cloudflare_id,mapped,raw_metadata_json,revised_at
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
       ON CONFLICT(account_id,charge_period_start,charge_period_end,product_family,metric_key,resource_cloudflare_id,description,consumed_unit)
       DO UPDATE SET
         description=excluded.description,consumed_quantity=excluded.consumed_quantity,
         consumed_unit=excluded.consumed_unit,billed_cost=excluded.billed_cost,
         effective_cost=excluded.effective_cost,list_cost=excluded.list_cost,currency=excluded.currency,
         mapped=excluded.mapped,raw_metadata_json=excluded.raw_metadata_json,revised_at=excluded.revised_at`,
    ).bind(
      lineId, cycleId, env.BROLLY_ACCOUNT_ID, chargeStart, chargeEnd, family, metric,
      record.ChargeDescription ?? record.x_BillableMetricName ?? metric, record.ConsumedQuantity,
      record.ConsumedUnit, record.BilledCost ?? null, record.EffectiveCost ?? null,
      record.ListCost ?? null, currency, record.x_ZoneId ?? "", mapped ? 1 : 0,
      JSON.stringify({ zoneName: record.x_ZoneName ?? null, source: "cloudflare-billable-usage" }), nowValue,
    ));
    if (!resourceFamilies.has(family)) {
      statements.push(...billingResourceStatements(env, family, nowValue));
      resourceFamilies.add(family);
    }
    if (!billingMetrics.has(metricId)) {
      statements.push(...billingMetricDefinitionStatements(
        env.DB, family, metric, mappedMetric, record.x_BillableMetricName ?? metric, record.ConsumedUnit,
      ));
      billingMetrics.add(metricId);
    }
  }
  for (const cycle of cycles.values()) {
    statements.unshift(env.DB.prepare(
      `INSERT INTO billing_cycles(id,account_id,starts_at,ends_at,status,currency,authoritative_cost,reconciled_at,approximate)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status,currency=excluded.currency,authoritative_cost=excluded.authoritative_cost,
         reconciled_at=excluded.reconciled_at,approximate=0`,
    ).bind(
      cycle.id, env.BROLLY_ACCOUNT_ID, cycle.startsAt, cycle.endsAt,
      cycle.endsAt <= now ? "sealed" : "open", cycle.currency, cycle.cost, nowValue,
    ));
  }
  for (const aggregate of dailyAggregates.values()) {
    statements.push(env.DB.prepare(
      `INSERT INTO usage_daily(
         resource_id,local_day,period_start_at,period_end_at,metrics_json,estimated_cost_usd,
         authoritative_allocated_cost_usd,completeness,sampling_json,sealed,revision,revised_at
       ) VALUES(?1,?2,?3,?4,?5,NULL,?6,'complete','{}',1,1,?7)
       ON CONFLICT(resource_id,local_day) DO UPDATE SET
         metrics_json=json_patch(usage_daily.metrics_json,excluded.metrics_json),
         authoritative_allocated_cost_usd=excluded.authoritative_allocated_cost_usd,
         revision=usage_daily.revision+1,revised_at=excluded.revised_at`,
    ).bind(aggregate.resourceId, aggregate.periodKey, aggregate.startsAt, aggregate.endsAt, JSON.stringify(aggregate.metrics), aggregate.cost, nowValue));
  }
  for (const aggregate of cycleAggregates.values()) {
    statements.push(env.DB.prepare(
      `INSERT INTO usage_cycle_totals(
         resource_id,billing_cycle_id,metrics_json,estimated_cost_usd,authoritative_allocated_cost_usd,
         completeness,sampling_json,sealed,revision,revised_at
       ) VALUES(?1,?2,?3,NULL,?4,'complete','{}',0,1,?5)
       ON CONFLICT(resource_id,billing_cycle_id) DO UPDATE SET
         metrics_json=json_patch(usage_cycle_totals.metrics_json,excluded.metrics_json),
         authoritative_allocated_cost_usd=excluded.authoritative_allocated_cost_usd,
         revision=usage_cycle_totals.revision+1,revised_at=excluded.revised_at`,
    ).bind(aggregate.resourceId, aggregate.periodKey, JSON.stringify(aggregate.metrics), aggregate.cost, nowValue));
  }
  for (const unknown of unknownProducts) {
    statements.push(env.DB.prepare(
      `INSERT INTO collector_capabilities(
         account_id,collector_key,dataset,available,retention_days,sampling_behavior,finest_scope,
         last_verified_at,error_code,human_explanation,state,watermark_at
       ) VALUES(?1,'billing:catchall',?2,1,NULL,NULL,'account',?3,'unmapped_billing_product',?4,'delayed',?3)
       ON CONFLICT(account_id,collector_key,dataset) DO UPDATE SET
         last_verified_at=excluded.last_verified_at,human_explanation=excluded.human_explanation,
         state=excluded.state,watermark_at=excluded.watermark_at`,
    ).bind(env.BROLLY_ACCOUNT_ID, unknown, nowValue, `Authoritative billing includes ${unknown}; detailed resource telemetry is not mapped yet`));
  }
  if (truncated) statements.push(env.DB.prepare(
    `INSERT INTO collector_capabilities(
       account_id,collector_key,dataset,available,retention_days,sampling_behavior,finest_scope,
       last_verified_at,error_code,human_explanation,state,watermark_at
     ) VALUES(?1,'billing:billable-usage','billable-usage',1,NULL,NULL,'account',?2,
       'billing_row_limit',?3,'delayed',?2)
     ON CONFLICT(account_id,collector_key,dataset) DO UPDATE SET
       last_verified_at=excluded.last_verified_at,error_code=excluded.error_code,
       human_explanation=excluded.human_explanation,state=excluded.state,watermark_at=excluded.watermark_at`,
  ).bind(env.BROLLY_ACCOUNT_ID, nowValue, `Billing reconciliation retained the first 20,000 of ${records.length} lines`));
  await runBatches(env.DB, statements, budget);
  await allocateAuthoritativeCosts(env.DB, env.BROLLY_ACCOUNT_ID, boundedRecords, timeZone, budget);
  const authoritativeCostUsd = [...cycles.values()].reduce((total, cycle) => total + cycle.cost, 0);
  const alertChanges = billingAlertChanges(
    env.BROLLY_ACCOUNT_ID,
    boundedRecords,
    [...cycles.values()],
    env.BROLLY_TIMEZONE ?? "UTC",
    now,
  );
  return {
    available: true, complete: !truncated, records: boundedRecords.length, cycles: cycles.size,
    unknownProducts: [...unknownProducts].sort(), authoritativeCostUsd, alertChanges,
    ...(truncated ? { error: `Billing reconciliation reached its 20,000-line limit from ${records.length} returned lines` } : {}),
  };
}

interface BillingAggregate {
  resourceId: string;
  periodKey: string;
  startsAt: number;
  endsAt: number;
  metrics: Record<string, number>;
  cost: number;
}

function addBillingAggregate(
  target: Map<string, BillingAggregate>,
  key: string,
  value: Omit<BillingAggregate, "metrics" | "cost"> & { metricId: string; quantity: number; cost: number },
): void {
  const aggregate = target.get(key) ?? {
    resourceId: value.resourceId, periodKey: value.periodKey, startsAt: value.startsAt,
    endsAt: value.endsAt, metrics: {}, cost: 0,
  };
  aggregate.startsAt = Math.min(aggregate.startsAt, value.startsAt);
  aggregate.endsAt = Math.max(aggregate.endsAt, value.endsAt);
  aggregate.metrics[value.metricId] = (aggregate.metrics[value.metricId] ?? 0) + value.quantity;
  aggregate.cost += value.cost;
  target.set(key, aggregate);
}

function billingResourceStatements(
  env: Env,
  family: string,
  now: number,
): D1PreparedStatement[] {
  const productResourceId = resourceId(env.BROLLY_ACCOUNT_ID, family, "product", family);
  const accountResourceId = resourceId(env.BROLLY_ACCOUNT_ID, "account", "account", env.BROLLY_ACCOUNT_ID);
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO resources(
         id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,
         first_seen_at,last_seen_at,last_active_at,coverage_status,control_capability,runtime_fuse_status,
         auto_quarantine_policy,tier,excluded,collector_key,dataset,metadata_json
       ) VALUES(?1,?2,NULL,'account','account',?2,'Cloudflare account',?3,?3,?3,'complete','none','unknown','inherit','unclassified',0,'billing','billable-usage','{}')`,
    ).bind(accountResourceId, env.BROLLY_ACCOUNT_ID, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO resources(
         id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,
         first_seen_at,last_seen_at,last_active_at,coverage_status,control_capability,runtime_fuse_status,
         auto_quarantine_policy,tier,excluded,collector_key,dataset,metadata_json
       ) VALUES(?1,?2,?3,?4,'product',?4,?5,?6,?6,?6,'complete','none','unknown','inherit','unclassified',0,'billing','billable-usage','{}')`,
    ).bind(productResourceId, env.BROLLY_ACCOUNT_ID, accountResourceId, family, displayFamily(family), now),
  ];
}

function billingMetricDefinitionStatements(
  db: D1Database,
  family: string,
  billingMetric: string,
  mappedMetric: string | null,
  displayName: string,
  consumedUnit: string,
): D1PreparedStatement[] {
  const metricKey = mappedMetric ?? billingMetric;
  return [
    db.prepare(
      `INSERT OR IGNORE INTO metric_definitions(
         id,product_family,metric_key,display_name,unit,aggregation_kind,billing_mapping,
         collector_key,finest_scope,pricing_version_id,active,catalog_version
       ) VALUES(?1,?2,?3,?4,?5,'sum',?6,'billing:billable-usage','product',NULL,1,'billing-dynamic')`,
    ).bind(`${family}:${metricKey}`, family, metricKey, displayName, consumedUnit || "count", billingMetric),
    db.prepare(
      `INSERT OR IGNORE INTO metric_definitions(
         id,product_family,metric_key,display_name,unit,aggregation_kind,billing_mapping,
         collector_key,finest_scope,pricing_version_id,active,catalog_version
       ) VALUES(?1,?2,'billed_cost_usd','Billed cost','usd','sum','billed_cost',
         'billing:billable-usage','product',NULL,1,'billing-dynamic')`,
    ).bind(`${family}:billed_cost_usd`, family),
  ];
}

function billingAlertChanges(
  accountId: string,
  records: BillingUsageRecord[],
  cycles: Array<{ id: string; startsAt: number; endsAt: number }>,
  timeZone: string,
  now: number,
): AccumulatorChange[] {
  const day = localDayAt(now, timeZone);
  const dayBounds = localDayBounds(day, timeZone);
  const currentCycle = cycles.find(cycle => cycle.startsAt <= now && cycle.endsAt > now)
    ?? cycles.sort((left, right) => right.startsAt - left.startsAt)[0];
  if (!currentCycle) return [];
  const totals = new Map<string, { day: number; cycle: number }>();
  for (const record of records) {
    const family = normalizeFamily(record.x_ProductFamilyId ?? record.x_ProductFamilyName ?? "unknown");
    const startsAt = safeDate(record.ChargePeriodStart, now);
    const cost = record.BilledCost ?? record.EffectiveCost ?? record.ListCost;
    if (cost === undefined) continue;
    const product = totals.get(family) ?? { day: 0, cycle: 0 };
    if (startsAt >= dayBounds.start && startsAt < dayBounds.end) product.day += cost;
    if (startsAt >= currentCycle.startsAt && startsAt < currentCycle.endsAt) product.cycle += cost;
    totals.set(family, product);
  }
  const account = [...totals.values()].reduce((sum, value) => ({
    day: sum.day + value.day,
    cycle: sum.cycle + value.cycle,
  }), { day: 0, cycle: 0 });
  const values = [["account", account] as const, ...[...totals.entries()]];
  return values.map(([family, total]) => ({
    localDay: day,
    billingCycleId: currentCycle.id,
    resourceId: family === "account"
      ? resourceId(accountId, "account", "account", accountId)
      : resourceId(accountId, family, "product", family),
    metricDefinitionId: `${family}:billed_cost_usd`,
    metricKey: "billed_cost_usd",
    intervalValue: total.day,
    dayValue: total.day,
    cycleValue: total.cycle,
    estimatedDayUsd: 0,
    estimatedCycleUsd: 0,
    billedDayUsd: total.day,
    billedCycleUsd: total.cycle,
    quality: "complete",
    sampleInterval: 1,
    cycleQuality: "complete",
    cycleSampleInterval: 1,
    watermarkAt: now,
    rollingBaseline: 0,
    periodStartAt: dayBounds.start,
    periodEndAt: dayBounds.end,
    historical: false,
  }));
}

async function allocateAuthoritativeCosts(
  db: D1Database,
  accountId: string,
  records: BillingUsageRecord[],
  timeZone: string,
  budget?: LedgerRunBudget,
): Promise<void> {
  const productDays = new Map<string, { family: string; day: string; cost: number }>();
  for (const record of records) {
    const cost = record.BilledCost ?? record.EffectiveCost ?? record.ListCost;
    if (cost === undefined) continue;
    const family = normalizeFamily(record.x_ProductFamilyId ?? record.x_ProductFamilyName ?? "unknown");
    const day = localDayAt(safeDate(record.ChargePeriodStart, Date.now()), timeZone);
    const key = `${family}:${day}`;
    const item = productDays.get(key) ?? { family, day, cost: 0 };
    item.cost += cost;
    productDays.set(key, item);
  }
  for (const item of productDays.values()) {
    const rows = await db.prepare(
      `SELECT u.resource_id,u.estimated_cost_usd FROM usage_daily u JOIN resources r ON r.id=u.resource_id
       WHERE r.account_id=?1 AND r.product_family=?2 AND u.local_day=?3
         AND r.resource_type NOT IN ('account','product')
         AND NOT EXISTS (SELECT 1 FROM resources child WHERE child.parent_resource_id=r.id)
         AND u.estimated_cost_usd>0 LIMIT 5000`,
    ).bind(accountId, item.family, item.day).all<{ resource_id: string; estimated_cost_usd: number }>();
    chargeMeta(budget, rows.meta);
    const estimate = rows.results.reduce((total, row) => total + row.estimated_cost_usd, 0);
    if (estimate <= 0) continue;
    const updates = rows.results.map(row => db.prepare(
      `UPDATE usage_daily SET authoritative_allocated_cost_usd=?3,revision=revision+1,revised_at=?4
       WHERE resource_id=?1 AND local_day=?2`,
    ).bind(row.resource_id, item.day, item.cost * row.estimated_cost_usd / estimate, Date.now()));
    await runBatches(db, updates, budget);
  }
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[], budget?: LedgerRunBudget): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += MAX_BATCH) {
    const results = await db.batch(statements.slice(offset, offset + MAX_BATCH));
    for (const result of results) chargeMeta(budget, result.meta);
  }
}

function chargeMeta(budget: LedgerRunBudget | undefined, meta: { rows_read?: number; rows_written?: number; changes?: number }): void {
  budget?.charge("d1RowsRead", meta.rows_read ?? 0);
  budget?.charge("d1RowsWritten", meta.rows_written ?? meta.changes ?? 0);
}

function billingLineId(accountId: string, record: BillingUsageRecord, family: string, metric: string): string {
  return [
    accountId, record.ChargePeriodStart, record.ChargePeriodEnd, family, metric,
    record.x_ZoneId ?? "account", record.ChargeDescription ?? record.x_BillableMetricName,
    record.ConsumedUnit,
  ].map(encodeURIComponent).join(":");
}

function normalizeFamily(value: string): string {
  const normalized = normalizeMetric(value);
  const aliases: Record<string, string> = {
    durable_objects: "durable_objects", workers_kv: "kv", workers_ai: "workers_ai",
    ai_gateway: "ai_gateway", browser_rendering: "browser_rendering", worker_builds: "worker_builds",
  };
  return aliases[normalized] ?? normalized;
}

function normalizeMetric(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

export function billingCatalogMetric(family: string, billingMetric: string): string | null {
  const product = METRIC_CATALOG.find(item => item.family === family && item.family !== "unknown");
  if (!product) return null;
  return [...product.metrics].sort((left, right) => right.length - left.length)
    .find(metric => billingMetric === metric || billingMetric.includes(metric)) ?? null;
}

function displayFamily(family: string): string {
  return family.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase());
}

function safeDate(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
