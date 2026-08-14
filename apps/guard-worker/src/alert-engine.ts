import {
  exactAutomaticActionEligible,
  localDayAt,
  localDayBounds,
  selectAggregateContributor,
  type AssetRef,
  type ContributorEvidence,
  type ControlAction,
  type DataQualityState,
  type LedgerRunBudget,
  type Resource,
} from "@standardagents/brolly-core";
import { notify, type NotificationTarget } from "@standardagents/brolly-notifiers";
import { openJson } from "./credentials.js";
import type { Env } from "./env.js";
import type { AccumulatorChange } from "./ledger-accumulator.js";

const MAX_BATCH = 100;
const DEFAULT_EMERGENCY_REPEAT_MS = 6 * 60 * 60_000;

interface RuleLineRow {
  rule_id: string;
  account_id: string;
  target_resource_id: string | null;
  target_selector_json: string | null;
  metric_definition_id: string;
  measurement: "usage" | "estimated_cost" | "billed_cost";
  period: "day" | "billing_cycle";
  notification_target_ids_json: string;
  auto_quarantine: number;
  auto_quarantine_contributors: number;
  confirmation_window_ms: number;
  line_id: string;
  label: string;
  color: string;
  priority: number;
  threshold_value: number;
  line_action: "notify" | "quarantine" | null;
  repeat_interval_ms: number | null;
}

interface ResourceRow {
  id: string;
  account_id: string;
  parent_resource_id: string | null;
  product_family: string;
  resource_type: string;
  cloudflare_id: string;
  display_name: string;
  first_seen_at: number;
  last_seen_at: number;
  last_active_at: number | null;
  coverage_status: DataQualityState;
  control_capability: Resource["controlCapability"];
  runtime_fuse_status: Resource["runtimeFuseStatus"];
  auto_quarantine_policy: Resource["autoQuarantinePolicy"];
  tier: Resource["tier"];
  excluded: number;
  metadata_json: string;
}

interface InstanceRow extends RuleLineRow, ResourceRow {
  instance_id: string;
  observed_value: number;
  instance_threshold: number;
  data_quality: DataQualityState;
  status: "open" | "silenced" | "expired" | "resolved";
  first_breached_at: number;
  last_breached_at: number;
  next_notification_at: number | null;
  notification_count: number;
  historical: number;
  evidence_json: string;
}

export interface AlertNotification {
  instanceId: string;
  ruleId: string;
  lineId: string;
  lineLabel: string;
  priority: number;
  observed: number;
  threshold: number;
  metricDefinitionId: string;
  resource: Resource;
  notificationTargetIds: string[];
  repeatIntervalMs: number | null;
}

export interface AlertEvaluationResult {
  notifications: AlertNotification[];
  automaticActions: ControlAction[];
  breached: number;
}

interface BillingCycleBounds {
  startsAt: number;
  endsAt: number;
}

export async function evaluateUsageAlerts(
  env: Env,
  changes: AccumulatorChange[],
  context: {
    timeZone: string; billingCycleId: string; billingCycleStart: number;
    billingCycleEnd: number; now?: number; budget?: LedgerRunBudget;
  },
): Promise<AlertEvaluationResult> {
  if (!changes.length) return { notifications: [], automaticActions: [], breached: 0 };
  const now = context.now ?? Date.now();
  const controlMode = await loadControlMode(env.DB, context.budget);
  const metricIds = [...new Set(changes.map(change => change.metricDefinitionId))];
  const ruleLines = await loadRuleLines(env.DB, env.BROLLY_ACCOUNT_ID, metricIds, context.budget);
  if (!ruleLines.length) return { notifications: [], automaticActions: [], breached: 0 };
  const cycleRows = await loadBillingCycleBounds(env.DB, env.BROLLY_ACCOUNT_ID, changes, context.budget);
  const resourceRows = await loadResources(env.DB, [...new Set(changes.map(change => change.resourceId))], context.budget);
  const resources = new Map(resourceRows.map(row => [row.id, resourceFromRow(row)]));
  const changesByMetric = new Map<string, AccumulatorChange[]>();
  for (const change of changes) changesByMetric.set(
    change.metricDefinitionId,
    [...(changesByMetric.get(change.metricDefinitionId) ?? []), change],
  );
  const statements: D1PreparedStatement[] = [];
  const breachedIds = new Set<string>();
  for (const rule of ruleLines) {
    for (const change of changesByMetric.get(rule.metric_definition_id) ?? []) {
      const resource = resources.get(change.resourceId);
      if (!resource || !ruleMatchesResource(rule, resource)) continue;
      const observed = observedValue(rule.measurement, rule.period, change);
      const timestamp = Math.max(change.periodStartAt, change.periodEndAt - 1);
      const cycle = alertBillingCycleBounds(cycleRows, timestamp, {
        startsAt: context.billingCycleStart,
        endsAt: context.billingCycleEnd,
      });
      const bounds = rule.period === "day"
        ? localDayBounds(localDayAt(timestamp, context.timeZone), context.timeZone)
        : { start: cycle.startsAt, end: cycle.endsAt };
      const id = alertInstanceId(rule.rule_id, rule.line_id, resource.id, bounds.start, bounds.end);
      if (observed >= rule.threshold_value) {
        breachedIds.add(id);
        const historical = change.historical || bounds.end <= now;
        const evidenceQuality = rule.period === "day" ? change.quality : change.cycleQuality;
        const evidenceSampling = rule.period === "day" ? change.sampleInterval : change.cycleSampleInterval;
        const evidence = {
          quality: evidenceQuality, sampleInterval: evidenceSampling, watermarkAt: change.watermarkAt,
          rollingBaseline: change.rollingBaseline, measurement: rule.measurement,
        };
        statements.push(env.DB.prepare(
          `INSERT INTO alert_instances(
             id,alert_rule_id,alert_line_id,target_resource_id,period_start_at,period_end_at,
             observed_value,threshold_value,evidence_json,data_quality,status,first_breached_at,
             last_breached_at,next_notification_at,notification_count,historical
           ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13,0,?14)
           ON CONFLICT(alert_rule_id,alert_line_id,target_resource_id,period_start_at,period_end_at)
           DO UPDATE SET
             observed_value=excluded.observed_value,threshold_value=excluded.threshold_value,
             evidence_json=excluded.evidence_json,data_quality=excluded.data_quality,
             status=CASE WHEN alert_instances.status IN ('expired','resolved') AND excluded.historical=0 THEN 'open' ELSE alert_instances.status END,
             last_breached_at=excluded.last_breached_at,historical=excluded.historical`,
        ).bind(
          id, rule.rule_id, rule.line_id, resource.id, bounds.start, bounds.end,
          observed, rule.threshold_value, JSON.stringify(evidence), evidenceQuality,
          historical ? "expired" : "open", now, historical ? null : now, historical ? 1 : 0,
        ));
      } else {
        statements.push(env.DB.prepare(
          `UPDATE alert_instances SET status='resolved',last_breached_at=?6
           WHERE alert_rule_id=?1 AND alert_line_id=?2 AND target_resource_id=?3
             AND period_start_at=?4 AND period_end_at=?5 AND status='open'`,
        ).bind(rule.rule_id, rule.line_id, resource.id, bounds.start, bounds.end, now));
      }
    }
  }
  statements.push(env.DB.prepare(
    `UPDATE alert_instances SET status='expired',next_notification_at=NULL
     WHERE period_end_at<=?1 AND status IN ('open','silenced')`,
  ).bind(now));
  await runBatches(env.DB, statements, context.budget);
  if (!breachedIds.size) return { notifications: [], automaticActions: [], breached: 0 };
  const instances = (await loadBreachedInstances(env.DB, env.BROLLY_ACCOUNT_ID, now, context.budget))
    .filter(instance => breachedIds.has(instance.instance_id));
  const notifications = instances.filter(instance => alertInstanceCanNotify(
    instance.status, instance.historical === 1, instance.next_notification_at, now,
  )).map(notificationFromRow);
  const automaticActions: ControlAction[] = [];
  for (const instance of instances) {
    const action = await prepareExactRuleAction(env.DB, instance, now, controlMode, context.budget);
    if (action) automaticActions.push(action);
    const contributorAction = await prepareAggregateContributorAction(env.DB, instance, changes, resources, now, controlMode, context.budget);
    if (contributorAction) automaticActions.push(contributorAction);
  }
  return { notifications, automaticActions, breached: instances.length };
}

export async function dispatchAlertNotifications(env: Env, pending: AlertNotification[], budget?: LedgerRunBudget): Promise<void> {
  for (const item of pending.slice(0, 100)) {
    const targets = await notificationTargets(env.DB, item.notificationTargetIds, budget);
    let delivered = false;
    for (const row of targets) {
      if (!severityAllowed(item.lineLabel, Number(item.priority), String(row.minimum_severity))) continue;
      if (!await notificationDeliveryAllowed(env.DB, String(row.id), String(row.kind), Date.now(), budget)) continue;
      const config = env.BROLLY_CREDENTIAL_KEY
        ? await openJson<Omit<NotificationTarget, "id" | "kind" | "enabled">>(String(row.config_json), env.BROLLY_CREDENTIAL_KEY)
        : JSON.parse(String(row.config_json)) as Omit<NotificationTarget, "id" | "kind" | "enabled">;
      const incident = {
        id: item.instanceId, key: item.instanceId, asset: assetFromResource(item.resource),
        metric: item.metricDefinitionId, severity: alertSeverity(item.lineLabel, item.priority),
        observed: item.observed, threshold: item.threshold,
        reason: `${item.lineLabel} threshold crossed for ${item.metricDefinitionId}`,
        action: "notify" as const, status: "open" as const, firstSeen: Date.now(), lastSeen: Date.now(), occurrences: 1,
      };
      const result = await notify({
        ...config, id: String(row.id), kind: row.kind as NotificationTarget["kind"], enabled: true,
      }, incident);
      const delivery = await env.DB.prepare(
        `INSERT INTO notification_deliveries(
           id,target_id,incident_id,kind,ok,status_code,error,created_at,alert_instance_id
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?3)`,
      ).bind(
        crypto.randomUUID(), row.id, item.instanceId, row.kind, result.ok ? 1 : 0,
        result.status ?? null, result.error?.slice(0, 2000) ?? null, Date.now(),
      ).run();
      chargeMeta(budget, delivery.meta);
      delivered ||= result.ok;
    }
    const next = delivered
      ? item.repeatIntervalMs === null ? null : Date.now() + item.repeatIntervalMs
      : Date.now() + 15 * 60_000;
    const updated = await env.DB.prepare(
      `UPDATE alert_instances SET
         notification_count=notification_count+?2,next_notification_at=?3
       WHERE id=?1 AND status='open'`,
    ).bind(item.instanceId, delivered ? 1 : 0, next).run();
    chargeMeta(budget, updated.meta);
  }
}

export async function notificationDeliveryAllowed(
  db: D1Database,
  targetId: string,
  kind: string,
  now = Date.now(),
  budget?: LedgerRunBudget,
): Promise<boolean> {
  const result = await db.prepare(
    `SELECT
       SUM(CASE WHEN created_at>=?2 THEN 1 ELSE 0 END) AS hourly,
       SUM(CASE WHEN created_at>=?3 THEN 1 ELSE 0 END) AS daily
     FROM notification_deliveries WHERE target_id=?1 AND created_at>=?3`,
  ).bind(targetId, now - 3_600_000, now - 86_400_000).first<{ hourly: number | null; daily: number | null }>();
  budget?.charge("d1RowsRead", 1);
  return Number(result?.hourly ?? 0) < 20 && (kind !== "twilio" || Number(result?.daily ?? 0) < 5);
}

export async function silenceAlertInstance(db: D1Database, instanceId: string, actor: string): Promise<boolean> {
  const now = Date.now();
  const result = await db.prepare(
    `UPDATE alert_instances SET status='silenced',silenced_at=?2,silenced_by=?3,next_notification_at=NULL
     WHERE id=?1 AND status='open'`,
  ).bind(instanceId, now, actor).run();
  if (Number(result.meta.changes ?? 0) !== 1) return false;
  await db.prepare(
    `INSERT INTO audit_log(id,actor,action,target,detail_json,created_at)
     VALUES(?1,?2,'alert_instance.silence',?3,'{}',?4)`,
  ).bind(crypto.randomUUID(), actor, instanceId, now).run();
  return true;
}

async function prepareExactRuleAction(
  db: D1Database,
  instance: InstanceRow,
  now: number,
  controlMode: "observe" | "approval" | "automatic",
  budget?: LedgerRunBudget,
): Promise<ControlAction | null> {
  if (controlMode === "observe" || instance.line_action !== "quarantine" || instance.target_resource_id !== instance.id) return null;
  const resource = resourceFromRow(instance);
  if (!manualActionEligible(resource, instance)) return null;
  const metadata = resource.metadata;
  const existing = await db.prepare(
    `SELECT * FROM actions WHERE alert_instance_id=?1 AND state IN ('prepared','approved','running','succeeded') LIMIT 1`,
  ).bind(instance.instance_id).first<Record<string, unknown>>();
  budget?.charge("d1RowsRead", existing ? 1 : 0);
  const parentDenied = await hasDeniedAncestor(db, resource.id, budget);
  if (parentDenied) return null;
  const evidence = parseEvidence(instance.evidence_json);
  const automatic = controlMode === "automatic" && instance.auto_quarantine === 1;
  if (!automatic) {
    if (existing) return null;
    await insertPreparedAction(
      db, instance, resource, now, false,
      `${instance.label} threshold crossed; operator approval is required`,
      budget,
    );
    return null;
  }
  const activeAction = await db.prepare(
    `SELECT id,state,alert_instance_id FROM actions WHERE account_id=?1 AND family=?2 AND asset_id=?3
     AND state IN ('prepared','approved','running','succeeded')
     ORDER BY CASE state WHEN 'succeeded' THEN 0 WHEN 'running' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END LIMIT 1`,
  ).bind(resource.accountId, resource.productFamily, resource.cloudflareId).first<Record<string, unknown>>();
  budget?.charge("d1RowsRead", activeAction ? 1 : 0);
  const eligible = exactAutomaticActionEligible({
    resource, quality: instance.data_quality, sampleInterval: evidence.sampleInterval,
    measurement: instance.measurement, fresh: evidence.watermarkAt !== null && now - evidence.watermarkAt <= 15 * 60_000,
    ruleOptIn: true, parentDenied: false,
    alreadyQuarantined: blocksAutomaticAction(activeAction, instance.instance_id),
    confirmationSatisfied: now - instance.first_breached_at >= instance.confirmation_window_ms,
  });
  if (!eligible) return null;
  const workerScript = resource.productFamily === "workers" ? resource.cloudflareId : metadata.cloudflareWorkerScript;
  if (!workerScript) return null;
  if (existing) return Number(existing.automatic) === 1 && existing.state === "prepared"
    ? actionFromStoredRow(existing, resource)
    : null;
  return insertPreparedAction(
    db, instance, resource, now, true,
    `${instance.label} threshold remained breached for ${instance.confirmation_window_ms} ms`, budget,
  );
}

async function insertPreparedAction(
  db: D1Database,
  instance: InstanceRow,
  resource: Resource,
  now: number,
  automatic: boolean,
  reason: string,
  budget?: LedgerRunBudget,
): Promise<ControlAction | null> {
  const workerScript = resource.productFamily === "workers" ? resource.cloudflareId : resource.metadata.cloudflareWorkerScript;
  if (!workerScript) return null;
  const action: ControlAction = {
    id: crypto.randomUUID(), incidentId: instance.instance_id, asset: assetFromResource(resource),
    kind: "runtime_quarantine", state: "prepared", reason,
    observed: { [instance.metric_definition_id]: instance.observed_value },
    rollback: { workerScript, action: "resume" }, actor: "brolly-alert-rule", createdAt: now,
  };
  const auditId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO audit_log(id,actor,action,target,detail_json,created_at)
       VALUES(?1,'brolly-alert-rule','action.prepare',?2,?3,?4)`,
    ).bind(auditId, action.id, JSON.stringify({ alertInstanceId: instance.instance_id, automatic }), now),
    db.prepare(
      `INSERT OR IGNORE INTO actions(
         id,incident_id,idempotency_key,account_id,family,asset_id,kind,state,reason,observed_json,
         rollback_json,actor,created_at,updated_at,alert_instance_id,evidence_quality,automatic
       ) VALUES(?1,?2,?3,?4,?5,?6,'runtime_quarantine','prepared',?7,?8,?9,?10,?11,?11,?2,?12,?13)`,
    ).bind(
      action.id, instance.instance_id, `alert:${instance.instance_id}`, resource.accountId,
      resource.productFamily, resource.cloudflareId, action.reason, JSON.stringify(action.observed),
      JSON.stringify(action.rollback), action.actor, now, instance.data_quality, automatic ? 1 : 0,
    ),
    db.prepare(`UPDATE alert_instances SET linked_action_id=?2 WHERE id=?1`).bind(instance.instance_id, action.id),
  ]);
  for (const result of results) chargeMeta(budget, result.meta);
  return Number(results[1]?.meta.changes ?? 0) === 1 ? action : null;
}

async function prepareAggregateContributorAction(
  db: D1Database,
  instance: InstanceRow,
  changes: AccumulatorChange[],
  resources: Map<string, Resource>,
  now: number,
  controlMode: "observe" | "approval" | "automatic",
  budget?: LedgerRunBudget,
): Promise<ControlAction | null> {
  if (controlMode === "observe" || instance.line_action !== "quarantine" || !instance.target_resource_id) return null;
  if (instance.measurement !== "usage" || instance.data_quality !== "complete" || instance.historical === 1) return null;
  const target = resourceFromRow(instance);
  if (!["account", "product"].includes(target.resourceType) && !target.resourceType.endsWith(":namespace")) return null;
  const applicable = changes.filter(change => change.metricDefinitionId === instance.metric_definition_id)
    .map(change => ({ change, resource: resources.get(change.resourceId) }))
    .filter((item): item is { change: AccumulatorChange; resource: Resource } => Boolean(item.resource))
    .filter(item => isExactControllableResource(item.resource) && isDescendant(item.resource, target.id, resources));
  if (!applicable.length) return null;
  const aggregateExcess = Math.max(0, instance.observed_value - instance.instance_threshold);
  const ownEmergency = await ownEmergencyThresholds(db, instance, applicable.map(item => item.resource.id), budget);
  const evidence: ContributorEvidence[] = applicable.map(item => ({
    resourceId: item.resource.id,
    latestIntervalValue: item.change.intervalValue,
    periodValue: instance.period === "day" ? item.change.dayValue : item.change.cycleValue,
    aggregateExcess,
    rollingBaseline: item.change.rollingBaseline,
    crossedOwnEmergency: ownEmergency.has(item.resource.id)
      && (instance.period === "day" ? item.change.dayValue : item.change.cycleValue) >= ownEmergency.get(item.resource.id)!,
    eligible: periodQuality(item.change, instance.period) === "complete"
      && periodSampleInterval(item.change, instance.period) === 1
      && item.resource.controlCapability !== "none" && item.resource.runtimeFuseStatus === "verified"
      && !item.resource.excluded && item.resource.autoQuarantinePolicy !== "deny"
      && item.resource.tier !== "critical" && item.resource.tier !== "control_plane" && item.resource.tier !== "unclassified",
  }));
  const selected = selectAggregateContributor(evidence);
  if (!selected) {
    const cleared = await db.prepare(`DELETE FROM contributor_candidates WHERE alert_instance_id=?1`)
      .bind(instance.instance_id).run();
    chargeMeta(budget, cleared.meta);
    await auditAmbiguousContributors(db, instance, evidence, now, budget);
    await prepareAmbiguousContributorApproval(db, instance, applicable, evidence, now, budget);
    return null;
  }
  if (controlMode !== "automatic" || instance.auto_quarantine_contributors !== 1) {
    const resource = resources.get(selected.resourceId);
    if (resource && manualActionEligible(resource, instance) && !await hasDeniedAncestor(db, resource.id, budget)) {
      await insertPreparedAction(
        db, instance, resource, now, false,
        `${resource.displayName} is the leading contributor; operator approval is required`, budget,
      );
    }
    return null;
  }
  const watermark = applicable.find(item => item.resource.id === selected.resourceId)?.change.watermarkAt ?? now;
  const updates = await db.batch([
    db.prepare(`DELETE FROM contributor_candidates WHERE alert_instance_id=?1 AND resource_id!=?2`).bind(instance.instance_id, selected.resourceId),
    db.prepare(
      `INSERT INTO contributor_candidates(
         alert_instance_id,resource_id,scan_watermark_at,consecutive_wins,evidence_json,updated_at
       ) VALUES(?1,?2,?3,1,?4,?5)
       ON CONFLICT(alert_instance_id,resource_id) DO UPDATE SET
         consecutive_wins=CASE WHEN contributor_candidates.scan_watermark_at=?3 THEN contributor_candidates.consecutive_wins ELSE contributor_candidates.consecutive_wins+1 END,
         scan_watermark_at=?3,evidence_json=?4,updated_at=?5`,
    ).bind(instance.instance_id, selected.resourceId, watermark, JSON.stringify(selected), now),
  ]);
  for (const result of updates) chargeMeta(budget, result.meta);
  if (Number(updates[1]?.meta.changes ?? 0) !== 1) return null;
  const streak = await db.prepare(
    `SELECT consecutive_wins FROM contributor_candidates WHERE alert_instance_id=?1 AND resource_id=?2 LIMIT 1`,
  ).bind(instance.instance_id, selected.resourceId).first<{ consecutive_wins: number }>();
  budget?.charge("d1RowsRead", streak ? 1 : 0);
  if (Number(streak?.consecutive_wins ?? 0) < 2) return null;
  const resource = resources.get(selected.resourceId);
  if (!resource || await hasDeniedAncestor(db, resource.id, budget)) return null;
  const change = applicable.find(item => item.resource.id === selected.resourceId)!.change;
  const activeAction = await db.prepare(
    `SELECT * FROM actions WHERE account_id=?1 AND family=?2 AND asset_id=?3
     AND state IN ('prepared','approved','running','succeeded')
     ORDER BY CASE state WHEN 'succeeded' THEN 0 WHEN 'running' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END LIMIT 1`,
  ).bind(resource.accountId, resource.productFamily, resource.cloudflareId).first<Record<string, unknown>>();
  budget?.charge("d1RowsRead", activeAction ? 1 : 0);
  const eligible = exactAutomaticActionEligible({
    resource, quality: periodQuality(change, instance.period),
    sampleInterval: periodSampleInterval(change, instance.period), measurement: "usage",
    fresh: change.watermarkAt !== null && now - change.watermarkAt <= 15 * 60_000,
    ruleOptIn: true, parentDenied: false,
    alreadyQuarantined: blocksAutomaticAction(activeAction, instance.instance_id),
    confirmationSatisfied: true,
  });
  if (!eligible) return null;
  if (activeAction) return Number(activeAction.automatic) === 1 && activeAction.state === "prepared"
    ? actionFromStoredRow(activeAction, resource)
    : null;
  return insertPreparedAction(
    db, instance, resource, now, true,
    `${resource.displayName} was the deterministic top contributor in two consecutive complete scans`, budget,
  );
}

async function auditAmbiguousContributors(
  db: D1Database,
  instance: InstanceRow,
  evidence: ContributorEvidence[],
  now: number,
  budget?: LedgerRunBudget,
): Promise<void> {
  const top = [...evidence].sort((left, right) => right.latestIntervalValue - left.latestIntervalValue).slice(0, 5);
  if (!top.length) return;
  const key = `contributors:ambiguous:${instance.instance_id}:${instance.last_breached_at}`;
  const exists = await db.prepare(`SELECT 1 AS present FROM audit_log WHERE target=?1 LIMIT 1`).bind(key).first();
  budget?.charge("d1RowsRead", exists ? 1 : 0);
  if (exists) return;
  const result = await db.prepare(
    `INSERT INTO audit_log(id,actor,action,target,detail_json,created_at)
     VALUES(?1,'brolly-alert-rule','contributors.ambiguous',?2,?3,?4)`,
  ).bind(crypto.randomUUID(), key, JSON.stringify({ alertInstanceId: instance.instance_id, top }), now).run();
  chargeMeta(budget, result.meta);
}

async function prepareAmbiguousContributorApproval(
  db: D1Database,
  instance: InstanceRow,
  applicable: Array<{ change: AccumulatorChange; resource: Resource }>,
  evidence: ContributorEvidence[],
  now: number,
  budget?: LedgerRunBudget,
): Promise<void> {
  const byResource = new Map(applicable.map(item => [item.resource.id, item.resource]));
  const ranked = [...evidence].sort((left, right) =>
    right.latestIntervalValue - left.latestIntervalValue
    || right.periodValue - left.periodValue
    || left.resourceId.localeCompare(right.resourceId));
  for (const candidate of ranked.slice(0, 5)) {
    const resource = byResource.get(candidate.resourceId);
    if (!resource || !manualActionEligible(resource, instance) || await hasDeniedAncestor(db, resource.id, budget)) continue;
    await insertPreparedAction(
      db, instance, resource, now, false,
      `${resource.displayName} is among the leading contributors; attribution requires operator review`, budget,
    );
    return;
  }
}

async function ownEmergencyThresholds(
  db: D1Database,
  instance: InstanceRow,
  resourceIds: string[],
  budget?: LedgerRunBudget,
): Promise<Map<string, number>> {
  const wanted = new Set(resourceIds);
  const result = await db.prepare(
    `SELECT r.target_resource_id,MIN(l.threshold_value) AS threshold_value
     FROM alert_rules r JOIN alert_lines l ON l.alert_rule_id=r.id
     WHERE r.account_id=?1 AND r.metric_definition_id=?2 AND r.period=?3
       AND r.enabled=1 AND r.retired=0 AND l.enabled=1 AND l.retired=0
       AND r.target_resource_id IS NOT NULL
       AND (lower(l.label)='emergency' OR l.priority>=100)
     GROUP BY r.target_resource_id LIMIT 5000`,
  ).bind(instance.account_id, instance.metric_definition_id, instance.period)
    .all<{ target_resource_id: string; threshold_value: number }>();
  chargeMeta(budget, result.meta);
  return new Map(result.results
    .filter(row => wanted.has(row.target_resource_id))
    .map(row => [row.target_resource_id, Number(row.threshold_value)]));
}

function manualActionEligible(resource: Resource, instance: InstanceRow): boolean {
  if (instance.status !== "open" || instance.historical === 1 || ["missing", "stale"].includes(instance.data_quality)) return false;
  if (!isExactControllableResource(resource) || resource.excluded || resource.controlCapability !== "runtime_fuse") return false;
  if (!["standard", "disposable"].includes(resource.tier)) return false;
  if (!resource.metadata.brollyFuse || resource.metadata.brollyFuse !== "true") return false;
  if (resource.productFamily === "workers") return /^[A-Za-z0-9_-]+$/.test(resource.cloudflareId);
  return /^[a-f0-9]{64}$/i.test(resource.cloudflareId) && Boolean(resource.metadata.cloudflareWorkerScript);
}

async function loadControlMode(db: D1Database, budget?: LedgerRunBudget): Promise<"observe" | "approval" | "automatic"> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first<{ value: string }>();
  budget?.charge("d1RowsRead", row ? 1 : 0);
  if (!row) return "approval";
  try {
    const mode = (JSON.parse(row.value) as { mode?: unknown }).mode;
    return mode === "observe" || mode === "automatic" || mode === "approval" ? mode : "approval";
  } catch { return "approval"; }
}

function isDescendant(resource: Resource, targetId: string, resources: Map<string, Resource>): boolean {
  let current: Resource | undefined = resource;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === targetId) return true;
    visited.add(current.id);
    current = current.parentResourceId ? resources.get(current.parentResourceId) : undefined;
  }
  return false;
}

async function hasDeniedAncestor(db: D1Database, resourceId: string, budget?: LedgerRunBudget): Promise<boolean> {
  const row = await db.prepare(
    `WITH RECURSIVE ancestors(id,parent_resource_id,auto_quarantine_policy,excluded,tier) AS (
       SELECT id,parent_resource_id,auto_quarantine_policy,excluded,tier FROM resources WHERE id=?1
       UNION ALL
       SELECT r.id,r.parent_resource_id,r.auto_quarantine_policy,r.excluded,r.tier
       FROM resources r JOIN ancestors a ON r.id=a.parent_resource_id
     )
     SELECT 1 AS denied FROM ancestors
     WHERE auto_quarantine_policy='deny' OR excluded=1 OR tier IN ('control_plane','critical') LIMIT 1`,
  ).bind(resourceId).first<{ denied: number }>();
  budget?.charge("d1RowsRead", row ? 1 : 0);
  return Boolean(row);
}

async function loadRuleLines(db: D1Database, accountId: string, metricIds: string[], budget?: LedgerRunBudget): Promise<RuleLineRow[]> {
  const placeholders = metricIds.map((_, index) => `?${index + 2}`).join(",");
  const result = await db.prepare(
    `SELECT
       r.id AS rule_id,r.account_id,r.target_resource_id,r.target_selector_json,r.metric_definition_id,
       r.measurement,r.period,r.notification_target_ids_json,r.auto_quarantine,
       r.auto_quarantine_contributors,r.confirmation_window_ms,
       l.id AS line_id,l.label,l.color,l.priority,l.threshold_value,l.action AS line_action,l.repeat_interval_ms
     FROM alert_rules r JOIN alert_lines l ON l.alert_rule_id=r.id
     WHERE r.account_id=?1 AND r.enabled=1 AND r.retired=0 AND l.enabled=1 AND l.retired=0
       AND r.metric_definition_id IN (${placeholders})
     ORDER BY r.id,l.priority`,
  ).bind(accountId, ...metricIds).all<RuleLineRow>();
  chargeMeta(budget, result.meta);
  return result.results;
}

async function loadResources(db: D1Database, ids: string[], budget?: LedgerRunBudget): Promise<ResourceRow[]> {
  if (ids.length > 400) {
    const wanted = new Set(ids);
    const accountId = decodeURIComponent(ids[0]?.split(":")[0] ?? "");
    const result = await db.prepare(
      `SELECT * FROM resources WHERE account_id=?1 ORDER BY last_seen_at DESC LIMIT 50000`,
    ).bind(accountId).all<ResourceRow>();
    chargeMeta(budget, result.meta);
    return result.results.filter(row => wanted.has(row.id));
  }
  const rows: ResourceRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 90) {
    const page = ids.slice(offset, offset + 90);
    const placeholders = page.map((_, index) => `?${index + 1}`).join(",");
    const result = await db.prepare(`SELECT * FROM resources WHERE id IN (${placeholders})`).bind(...page).all<ResourceRow>();
    chargeMeta(budget, result.meta);
    rows.push(...result.results);
  }
  return rows;
}

async function loadBreachedInstances(db: D1Database, accountId: string, breachedAt: number, budget?: LedgerRunBudget): Promise<InstanceRow[]> {
  const rows: InstanceRow[] = [];
  let after = "";
  while (rows.length < 100_000) {
    const result = await db.prepare(
      `SELECT
         i.id AS instance_id,i.observed_value,i.threshold_value AS instance_threshold,i.data_quality,
         i.status,i.first_breached_at,i.last_breached_at,i.next_notification_at,i.notification_count,
         i.historical,i.evidence_json,
         r.id AS rule_id,r.account_id,r.target_resource_id,r.target_selector_json,r.metric_definition_id,
         r.measurement,r.period,r.notification_target_ids_json,r.auto_quarantine,
         r.auto_quarantine_contributors,r.confirmation_window_ms,
         l.id AS line_id,l.label,l.color,l.priority,l.threshold_value,l.action AS line_action,l.repeat_interval_ms,
         target.*
       FROM alert_instances i
       JOIN alert_rules r ON r.id=i.alert_rule_id JOIN alert_lines l ON l.id=i.alert_line_id
       JOIN resources target ON target.id=i.target_resource_id
       WHERE r.account_id=?1 AND i.last_breached_at=?2 AND i.id>?3
       ORDER BY i.id LIMIT 10000`,
    ).bind(accountId, breachedAt, after).all<InstanceRow>();
    chargeMeta(budget, result.meta);
    rows.push(...result.results);
    if (result.results.length < 10_000) break;
    after = result.results.at(-1)!.instance_id;
  }
  return rows;
}

async function notificationTargets(db: D1Database, ids: string[], budget?: LedgerRunBudget): Promise<Array<Record<string, unknown>>> {
  if (!ids.length) {
    const result = await db.prepare(`SELECT * FROM notification_targets WHERE enabled=1 LIMIT 50`).all<Record<string, unknown>>();
    chargeMeta(budget, result.meta);
    return result.results;
  }
  const page = ids.slice(0, 50);
  const placeholders = page.map((_, index) => `?${index + 1}`).join(",");
  const result = await db.prepare(`SELECT * FROM notification_targets WHERE enabled=1 AND id IN (${placeholders})`).bind(...page).all<Record<string, unknown>>();
  chargeMeta(budget, result.meta);
  return result.results;
}

function notificationFromRow(row: InstanceRow): AlertNotification {
  return {
    instanceId: row.instance_id, ruleId: row.rule_id, lineId: row.line_id, lineLabel: row.label,
    priority: row.priority, observed: row.observed_value, threshold: row.instance_threshold,
    metricDefinitionId: row.metric_definition_id, resource: resourceFromRow(row),
    notificationTargetIds: parseStringArray(row.notification_target_ids_json),
    repeatIntervalMs: alertRepeatInterval(row.label, row.repeat_interval_ms),
  };
}

export function alertRepeatInterval(label: string, configured: number | null): number | null {
  return configured ?? (label.toLowerCase() === "emergency" ? DEFAULT_EMERGENCY_REPEAT_MS : null);
}

export function alertInstanceCanNotify(
  status: InstanceRow["status"],
  historical: boolean,
  nextNotificationAt: number | null,
  now: number,
): boolean {
  return status === "open" && !historical && nextNotificationAt !== null && nextNotificationAt <= now;
}

export function alertBillingCycleBounds(
  cycles: BillingCycleBounds[],
  timestamp: number,
  fallback: BillingCycleBounds,
): BillingCycleBounds {
  return cycles.find(cycle => cycle.startsAt <= timestamp && cycle.endsAt > timestamp) ?? fallback;
}

async function loadBillingCycleBounds(
  db: D1Database,
  accountId: string,
  changes: AccumulatorChange[],
  budget?: LedgerRunBudget,
): Promise<BillingCycleBounds[]> {
  const timestamps = changes.map(change => Math.max(change.periodStartAt, change.periodEndAt - 1));
  const minimum = Math.min(...timestamps);
  const maximum = Math.max(...timestamps);
  const result = await db.prepare(
    `SELECT starts_at,ends_at FROM billing_cycles
     WHERE account_id=?1 AND ends_at>?2 AND starts_at<=?3
     ORDER BY approximate ASC,starts_at ASC LIMIT 36`,
  ).bind(accountId, minimum, maximum).all<{ starts_at: number; ends_at: number }>();
  chargeMeta(budget, result.meta);
  return result.results.map(row => ({ startsAt: Number(row.starts_at), endsAt: Number(row.ends_at) }));
}

function observedValue(measurement: RuleLineRow["measurement"], period: RuleLineRow["period"], change: AccumulatorChange): number {
  if (measurement === "usage") return period === "day" ? change.dayValue : change.cycleValue;
  if (measurement === "estimated_cost") return period === "day" ? change.estimatedDayUsd : change.estimatedCycleUsd;
  return period === "day" ? change.billedDayUsd ?? 0 : change.billedCycleUsd ?? 0;
}

function periodQuality(change: AccumulatorChange, period: RuleLineRow["period"]): DataQualityState {
  return period === "day" ? change.quality : change.cycleQuality;
}

function periodSampleInterval(change: AccumulatorChange, period: RuleLineRow["period"]): number | null {
  return period === "day" ? change.sampleInterval : change.cycleSampleInterval;
}

function ruleMatchesResource(rule: RuleLineRow, resource: Resource): boolean {
  if (rule.target_resource_id) return rule.target_resource_id === resource.id;
  if (!rule.target_selector_json) return false;
  let selector: Record<string, string>;
  try { selector = JSON.parse(rule.target_selector_json) as Record<string, string>; } catch { return false; }
  return (!selector.productFamily || selector.productFamily === resource.productFamily)
    && (!selector.resourceType || selector.resourceType === resource.resourceType)
    && (!selector.parentResourceId || selector.parentResourceId === resource.parentResourceId)
    && (!selector.cloudflareId || selector.cloudflareId === resource.cloudflareId)
    && (!selector.tier || selector.tier === resource.tier)
    && Object.entries(selector).filter(([key]) => key.startsWith("tag:")).every(([key, value]) => resource.metadata[key.slice(4)] === value);
}

function resourceFromRow(row: ResourceRow): Resource {
  return {
    id: row.id, accountId: row.account_id, parentResourceId: row.parent_resource_id,
    productFamily: row.product_family, resourceType: row.resource_type, cloudflareId: row.cloudflare_id,
    displayName: row.display_name, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    lastActiveAt: row.last_active_at, coverageStatus: row.coverage_status,
    controlCapability: row.control_capability, runtimeFuseStatus: row.runtime_fuse_status,
    autoQuarantinePolicy: row.auto_quarantine_policy, tier: row.tier, excluded: row.excluded === 1,
    metadata: parseStringRecord(row.metadata_json),
  };
}

function assetFromResource(resource: Resource): AssetRef {
  const scope = resource.resourceType.split(":").at(-1);
  return {
    accountId: resource.accountId, family: resource.productFamily, id: resource.cloudflareId,
    parentId: resource.parentResourceId ?? undefined, name: resource.displayName,
    scope: scope === "object" || scope === "namespace" || scope === "resource" || scope === "zone" || scope === "account" ? scope : "resource",
    tier: resource.tier, tags: resource.metadata,
  };
}

function actionFromStoredRow(row: Record<string, unknown>, resource: Resource): ControlAction {
  return {
    id: String(row.id),
    incidentId: String(row.incident_id),
    asset: assetFromResource(resource),
    kind: String(row.kind) as ControlAction["kind"],
    state: String(row.state) as ControlAction["state"],
    reason: String(row.reason),
    observed: parseNumberRecord(row.observed_json),
    rollback: parseUnknownRecord(row.rollback_json),
    actor: String(row.actor),
    createdAt: Number(row.created_at),
  };
}

function blocksAutomaticAction(row: Record<string, unknown> | null, alertInstanceId: string): boolean {
  return Boolean(row) && (row?.state !== "prepared" || row.alert_instance_id !== alertInstanceId);
}

function isExactControllableResource(resource: Resource): boolean {
  return resource.resourceType.endsWith(":resource") && resource.productFamily === "workers"
    || resource.resourceType.endsWith(":object") && resource.productFamily === "durable_objects";
}

function parseEvidence(value: string): { sampleInterval: number | null; watermarkAt: number | null } {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      sampleInterval: typeof parsed.sampleInterval === "number" ? parsed.sampleInterval : null,
      watermarkAt: typeof parsed.watermarkAt === "number" ? parsed.watermarkAt : null,
    };
  } catch { return { sampleInterval: null, watermarkAt: null }; }
}

function alertSeverity(label: string, priority: number): "warning" | "critical" | "emergency" {
  const normalized = label.toLowerCase();
  if (normalized === "emergency" || priority >= 100) return "emergency";
  if (normalized === "critical" || priority >= 75) return "critical";
  return "warning";
}

function severityAllowed(label: string, priority: number, minimum: string): boolean {
  const rank = { info: 0, warning: 1, critical: 2, emergency: 3 } as const;
  return rank[alertSeverity(label, priority)] >= (rank[minimum as keyof typeof rank] ?? 1);
}

function alertInstanceId(ruleId: string, lineId: string, resourceIdValue: string, start: number, end: number): string {
  return [ruleId, lineId, resourceIdValue, start, end].map(encodeURIComponent).join(":");
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

function parseStringArray(value: string): string[] {
  try { return (JSON.parse(value) as unknown[]).filter((item): item is string => typeof item === "string"); } catch { return []; }
}

function parseStringRecord(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

function parseNumberRecord(value: unknown): Record<string, number> {
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch { return {}; }
}

function parseUnknownRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
