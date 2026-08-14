import { METRIC_CATALOG, resourceId, type Policy, type SpendLimits, type Threshold } from "@standardagents/brolly-core";

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
    limits: policy.accountDailySpend,
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
    const limits = policy.familyDailySpend?.[family];
    if (!limits) continue;
    addSpendRule(db, statements, {
      id: legacyId("family", family),
      key: `family:${family}`,
      accountId,
      targetResourceId: productId,
      metricDefinitionId: `${family}:estimated_cost_usd`,
      limits,
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
    addSpendRule(db, statements, {
      id: legacyId("asset", key),
      key: `asset:${key}`,
      accountId,
      targetResourceId: row.id,
      metricDefinitionId: `${parsed.family}:estimated_cost_usd`,
      limits,
      now,
    });
    ruleCount += 1;
  }

  for (const threshold of policy.thresholds) {
    for (const product of METRIC_CATALOG.filter(item => item.metrics.includes(threshold.metric))) {
      addUsageRule(db, statements, accountId, product.family, threshold, now);
      ruleCount += 1;
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

function addSpendRule(db: D1Database, statements: D1PreparedStatement[], input: {
  id: string;
  key: string;
  accountId: string;
  targetResourceId: string;
  metricDefinitionId: string;
  limits: SpendLimits;
  now: number;
}): void {
  addRule(db, statements, {
    ...input,
    measurement: "estimated_cost",
    period: "day",
    lines: [
      { label: "Warning", color: "#f59e0b", priority: 50, value: input.limits.warning, enabled: true },
      { label: "Critical", color: "#dc6b24", priority: 75, value: input.limits.critical, enabled: false },
      { label: "Emergency", color: "#ef4444", priority: 100, value: input.limits.emergency, enabled: true },
    ],
  });
}

function addUsageRule(
  db: D1Database,
  statements: D1PreparedStatement[],
  accountId: string,
  family: string,
  threshold: Threshold,
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
    lines: [
      ...(threshold.warning === undefined ? [] : [{ label: "Warning", color: "#f59e0b", priority: 50, value: threshold.warning, enabled: true }]),
      ...(threshold.critical === undefined ? [] : [{ label: "Critical", color: "#dc6b24", priority: 75, value: threshold.critical, enabled: false }]),
      ...(threshold.emergency === undefined ? [] : [{ label: "Emergency", color: "#ef4444", priority: 100, value: threshold.emergency, enabled: true }]),
    ],
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
  lines: Array<{ label: string; color: string; priority: number; value: number; enabled: boolean }>;
  now: number;
}): void {
  statements.push(db.prepare(
    `INSERT INTO alert_rules(
       id,account_id,target_resource_id,target_selector_json,metric_definition_id,measurement,period,
       notification_target_ids_json,auto_quarantine,auto_quarantine_contributors,confirmation_window_ms,
       enabled,legacy_policy_key,created_at,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6,?7,'[]',0,0,300000,1,?8,?9,?9)
     ON CONFLICT(id) DO UPDATE SET
       target_resource_id=excluded.target_resource_id,target_selector_json=excluded.target_selector_json,
       metric_definition_id=excluded.metric_definition_id,measurement=excluded.measurement,
       period=excluded.period,enabled=1,retired=0,
       legacy_policy_key=excluded.legacy_policy_key,updated_at=excluded.updated_at`,
  ).bind(
    input.id, input.accountId, input.targetResourceId, input.targetSelector ? JSON.stringify(input.targetSelector) : null,
    input.metricDefinitionId, input.measurement, input.period, input.key, input.now,
  ));
  for (const line of input.lines) {
    statements.push(db.prepare(
      `INSERT INTO alert_lines(
         id,alert_rule_id,label,color,priority,threshold_value,action,repeat_interval_ms,
         enabled,created_at,updated_at
       ) VALUES(?1,?2,?3,?4,?5,?6,'notify',?7,?8,?9,?9)
       ON CONFLICT(alert_rule_id,label) DO UPDATE SET
         color=excluded.color,priority=excluded.priority,threshold_value=excluded.threshold_value,
         repeat_interval_ms=excluded.repeat_interval_ms,enabled=excluded.enabled,retired=0,updated_at=excluded.updated_at`,
    ).bind(
      `${input.id}:${line.label.toLowerCase()}`, input.id, line.label, line.color,
      line.priority, line.value, line.label === "Emergency" ? 6 * 60 * 60_000 : null,
      line.enabled ? 1 : 0, input.now,
    ));
  }
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
