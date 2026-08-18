import { METRIC_CATALOG, resourceId, type Policy, type ScopeLimits, type SpendLimits, type Threshold } from "@standardagents/brolly-core";
import { loadAlertLevels, type AlertLevel } from "./alert-levels.js";

const MAX_BATCH = 100;

export async function migrateLegacyPolicyRules(
  db: D1Database,
  accountId: string,
  policy: Policy,
  force = false,
): Promise<number> {
  const state = await db.prepare(
    `SELECT value FROM settings WHERE key='usage_ledger_policy_version' LIMIT 1`,
  ).first<{ value: string }>();
  if (!force && state?.value === policy.version) return 0;
  const levels = await loadAlertLevels(db);
  const now = Date.now();
  const rootId = resourceId(accountId, "account", "account", accountId);
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT OR IGNORE INTO resources(
         id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,
         first_seen_at,last_seen_at,coverage_status,control_capability,runtime_fuse_status,
         auto_quarantine_policy,tier,excluded,collector_key,dataset,metadata_json
       ) VALUES(?1,?2,NULL,'account','account',?2,'Cloudflare account',?3,?3,'missing','none','unknown','inherit','unclassified',0,'migration','legacy-policy','{}')`,
    ).bind(rootId, accountId, now),
  ];
  let ruleCount = 0;

  addSpendRule(db, statements, {
    id: legacyId("account", "estimated-cost"),
    key: "account:estimated-cost",
    accountId,
    targetResourceId: rootId,
    metricDefinitionId: "account:estimated_cost_usd",
    limits: chartCost(policy.limits?.day?.account, policy.accountDailySpend),
    levelEnabled: policy.limits?.day?.account?.costLevelEnabled,
    enabled: policy.limits?.day?.account?.costEnabled,
    levels,
    now,
  });
  ruleCount += 1;

  for (const product of METRIC_CATALOG) {
    const family = product.family;
    const productId = resourceId(accountId, family, "product", family);
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO resources(
         id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,
         first_seen_at,last_seen_at,coverage_status,control_capability,runtime_fuse_status,
         auto_quarantine_policy,tier,excluded,collector_key,dataset,metadata_json
       ) VALUES(?1,?2,?3,?4,'product',?4,?5,?6,?6,'missing','none','unknown','inherit','unclassified',0,'migration','legacy-policy','{}')`,
    ).bind(productId, accountId, rootId, family, displayFamily(family), now));
    const scope = policy.limits?.day?.[`family:${family}`];
    const limits = policy.familyDailySpend?.[family];
    if (!limits) continue;
    addSpendRule(db, statements, {
      id: legacyId("family", family),
      key: `family:${family}`,
      accountId,
      targetResourceId: productId,
      metricDefinitionId: `${family}:estimated_cost_usd`,
      limits: chartCost(scope, limits),
      levelEnabled: scope?.costLevelEnabled,
      enabled: scope?.costEnabled,
      levels,
      now,
    });
    ruleCount += 1;
  }

  for (const [key, limits] of Object.entries(policy.assetDailySpend ?? {})) {
    const parsed = parseAssetBudgetKey(key);
    if (!parsed) continue;
    const row = await db.prepare(
      `SELECT id FROM resources
       WHERE account_id=?1 AND product_family=?2 AND cloudflare_id=?3
         AND resource_type LIKE ?4 ORDER BY last_seen_at DESC LIMIT 1`,
    ).bind(accountId, parsed.family, parsed.id, `%:${parsed.scope}`).first<{ id: string }>();
    if (!row) continue;
    const scope = policy.limits?.day?.[`asset:${key}`];
    addSpendRule(db, statements, {
      id: legacyId("asset", key),
      key: `asset:${key}`,
      accountId,
      targetResourceId: row.id,
      metricDefinitionId: `${parsed.family}:estimated_cost_usd`,
      limits: chartCost(scope, limits),
      levelEnabled: scope?.costLevelEnabled,
      enabled: scope?.costEnabled,
      levels,
      now,
    });
    ruleCount += 1;
  }

  for (const threshold of policy.thresholds) {
    for (const product of METRIC_CATALOG.filter(item => item.metrics.includes(threshold.metric))) {
      addUsageRule(db, statements, accountId, product.family, threshold, levels, now);
      ruleCount += 1;
    }
  }

  if (policy.limits) {
    for (const [period, scopes] of [["day", policy.limits.day], ["billing_cycle", policy.limits.cycle]] as const) {
      for (const [scopeKey, scope] of Object.entries(scopes)) {
        const target = await resolvePolicyScope(db, accountId, rootId, scopeKey);
        if (!target) continue;
        if (period === "billing_cycle" && Object.keys(scope.cost).length) {
          addRule(db, statements, {
            id: chartRuleId(period, scopeKey, "cost"),
            key: `limits:${period}:${scopeKey}:cost`,
            accountId,
            targetResourceId: target.resourceId,
            metricDefinitionId: `${target.family}:estimated_cost_usd`,
            measurement: "estimated_cost",
            period,
            enabled: scope.costEnabled,
            lines: materializedSpendLines(scope.cost, levels, scope.costLevelEnabled),
            now,
          });
          ruleCount += 1;
        }
        for (const [metricDefinitionId, limits] of Object.entries(scope.usage)) {
          if (!Object.keys(limits).length) continue;
          addRule(db, statements, {
            id: chartRuleId(period, scopeKey, `usage:${metricDefinitionId}`),
            key: `limits:${period}:${scopeKey}:usage:${metricDefinitionId}`,
            accountId,
            targetResourceId: target.resourceId,
            metricDefinitionId,
            measurement: "usage",
            period,
            enabled: scope.usageEnabled?.[metricDefinitionId],
            lines: materializedSpendLines(limits, levels, scope.usageLevelEnabled?.[metricDefinitionId]),
            now,
          });
          ruleCount += 1;
        }
      }
    }
  }

  statements.push(
    db.prepare(
      `INSERT INTO settings(key,value,updated_at) VALUES('usage_ledger_policy_version',?1,?2)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    ).bind(policy.version, now),
    db.prepare(
      `INSERT INTO audit_log(id,actor,action,target,detail_json,created_at)
       VALUES(?1,'brolly-migration','policy.rules.migrate',?2,?3,?4)`,
    ).bind(crypto.randomUUID(), policy.version, JSON.stringify({ rules: ruleCount }), now),
  );
  await runBatches(db, statements);
  return ruleCount;
}

function chartCost(scope: ScopeLimits | undefined, fallback: SpendLimits): SpendLimits {
  return scope && Object.keys(scope.cost).length ? scope.cost : fallback;
}

async function resolvePolicyScope(
  db: D1Database,
  accountId: string,
  rootId: string,
  scopeKey: string,
): Promise<{ resourceId: string; family: string } | null> {
  if (scopeKey === "account") return { resourceId: rootId, family: "account" };
  const family = scopeKey.match(/^family:(.+)$/)?.[1];
  if (family) return { resourceId: resourceId(accountId, family, "product", family), family };
  const assetKey = scopeKey.match(/^asset:(.+)$/)?.[1];
  const asset = assetKey ? parseAssetBudgetKey(assetKey) : null;
  if (!asset) return null;
  const row = await db.prepare(
    `SELECT id FROM resources
     WHERE account_id=?1 AND product_family=?2 AND cloudflare_id=?3
       AND resource_type LIKE ?4 ORDER BY last_seen_at DESC LIMIT 1`,
  ).bind(accountId, asset.family, asset.id, `%:${asset.scope}`).first<{ id: string }>();
  return row ? { resourceId: row.id, family: asset.family } : null;
}

function chartRuleId(period: "day" | "billing_cycle", scope: string, dimension: string): string {
  return `policy:${period}:${encodeURIComponent(scope)}:${encodeURIComponent(dimension)}`;
}

function addSpendRule(db: D1Database, statements: D1PreparedStatement[], input: {
  id: string;
  key: string;
  accountId: string;
  targetResourceId: string;
  metricDefinitionId: string;
  limits: SpendLimits;
  levelEnabled?: Record<string, boolean>;
  enabled?: boolean;
  levels: AlertLevel[];
  now: number;
}): void {
  addRule(db, statements, {
    ...input,
    measurement: "estimated_cost",
    period: "day",
    enabled: input.enabled,
    lines: materializedSpendLines(input.limits, input.levels, input.levelEnabled),
  });
}

function addUsageRule(
  db: D1Database,
  statements: D1PreparedStatement[],
  accountId: string,
  family: string,
  threshold: Threshold,
  levels: AlertLevel[],
  now: number,
): void {
  const id = legacyId("threshold", `${family}:${threshold.metric}:${threshold.windowMs}`);
  addRule(db, statements, {
    id,
    key: `threshold:${family}:${threshold.metric}:${threshold.windowMs}`,
    accountId,
    targetResourceId: null,
    targetSelector: { productFamily: family },
    metricDefinitionId: `${family}:${threshold.metric}`,
    measurement: "usage",
    period: threshold.windowMs >= 28 * 86_400_000 ? "billing_cycle" : "day",
    now,
    lines: levels.flatMap((level, index) => {
      const value = thresholdValue(threshold, level);
      return value === undefined ? [] : [{
        levelId: level.id, label: level.label, color: levelColor(index, levels.length),
        priority: level.position * 10, value, enabled: true,
      }];
    }),
  });
}

function addRule(db: D1Database, statements: D1PreparedStatement[], input: {
  id: string;
  key: string;
  accountId: string;
  targetResourceId: string | null;
  targetSelector?: Record<string, string>;
  metricDefinitionId: string;
  measurement: "usage" | "estimated_cost";
  period: "day" | "billing_cycle";
  enabled?: boolean;
  lines: Array<{ levelId: string; label: string; color: string; priority: number; value: number; enabled: boolean }>;
  now: number;
}): void {
  statements.push(db.prepare(
    `INSERT INTO alert_rules(
       id,account_id,target_resource_id,target_selector_json,metric_definition_id,measurement,period,
       notification_target_ids_json,auto_quarantine,auto_quarantine_contributors,confirmation_window_ms,
       enabled,legacy_policy_key,created_at,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6,?7,'[]',0,0,300000,?8,?9,?10,?10)
     ON CONFLICT(id) DO UPDATE SET
       target_resource_id=excluded.target_resource_id,target_selector_json=excluded.target_selector_json,
       metric_definition_id=excluded.metric_definition_id,measurement=excluded.measurement,
       period=excluded.period,enabled=excluded.enabled,retired=0,
       legacy_policy_key=excluded.legacy_policy_key,updated_at=excluded.updated_at`,
  ).bind(
    input.id, input.accountId, input.targetResourceId, input.targetSelector ? JSON.stringify(input.targetSelector) : null,
    input.metricDefinitionId, input.measurement, input.period, input.enabled === false ? 0 : 1, input.key, input.now,
  ));
  statements.push(db.prepare(`UPDATE alert_lines SET retired=1,updated_at=?2 WHERE alert_rule_id=?1`).bind(input.id, input.now));
  for (const line of input.lines) {
    statements.push(db.prepare(
      `INSERT INTO alert_lines(
         id,alert_rule_id,level_id,label,color,priority,threshold_value,action,repeat_interval_ms,
         enabled,created_at,updated_at
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,'notify',NULL,?8,?9,?9)
       ON CONFLICT(alert_rule_id,level_id) DO UPDATE SET
         label=excluded.label,color=excluded.color,priority=excluded.priority,threshold_value=excluded.threshold_value,
         repeat_interval_ms=excluded.repeat_interval_ms,enabled=excluded.enabled,retired=0,updated_at=excluded.updated_at`,
    ).bind(
      `${input.id}:${line.levelId}`, input.id, line.levelId, line.label, line.color,
      line.priority, line.value, line.enabled ? 1 : 0, input.now,
    ));
  }
}

export function materializedSpendLines(limits: SpendLimits, levels: AlertLevel[], levelEnabled?: Record<string, boolean>): Array<{
  levelId: string;
  label: string;
  color: string;
  priority: number;
  value: number;
  enabled: boolean;
}> {
  return levels.flatMap((level, index) => finiteLimit(limits[level.id])
    ? [{ levelId: level.id, label: level.label, color: levelColor(index, levels.length), priority: level.position * 10, value: limits[level.id]!, enabled: levelEnabled?.[level.id] !== false }]
    : []);
}

function finiteLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function thresholdValue(threshold: Threshold, level: AlertLevel): number | undefined {
  const key = level.id === "warning" || level.id === "critical" || level.id === "emergency"
    ? level.id
    : level.label.toLowerCase() === "warning" || level.label.toLowerCase() === "critical" || level.label.toLowerCase() === "emergency"
      ? level.label.toLowerCase() as "warning" | "critical" | "emergency"
      : null;
  return key ? threshold[key] : undefined;
}

function levelColor(index: number, count: number): string {
  if (index === count - 1) return "#ef4444";
  if (index === count - 2) return "#dc6b24";
  return "#f59e0b";
}

function legacyId(kind: string, key: string): string {
  return `legacy:${kind}:${encodeURIComponent(key)}`;
}

function parseAssetBudgetKey(key: string): { family: string; scope: string; id: string } | null {
  const [family, scope, ...parts] = key.split(":");
  return family && scope && parts.length ? { family, scope, id: parts.join(":") } : null;
}

function displayFamily(family: string): string {
  return family.replaceAll("_", " ").replace(/\b\w/g, value => value.toUpperCase());
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += MAX_BATCH) {
    await db.batch(statements.slice(offset, offset + MAX_BATCH));
  }
}
