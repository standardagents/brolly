import type { AssetRef, ControlAction, CoverageResult, Evaluation, Incident, MetricSample, Policy } from "@standardagents/brolly-core";
import { DEFAULT_POLICY, upsertIncident } from "@standardagents/brolly-core";

export class Store {
  constructor(private readonly db: D1Database, private readonly chargeRows: (amount: number) => void) {}

  async acquireLease(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const result = await this.db.prepare(
      `INSERT INTO cron_lease(name, holder, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(name) DO UPDATE SET holder=excluded.holder, expires_at=excluded.expires_at
       WHERE cron_lease.expires_at < ?4 OR cron_lease.holder = ?2`,
    ).bind(name, holder, now + ttlMs, now).run();
    this.chargeMeta(result.meta);
    return (result.meta.changes ?? 0) > 0;
  }

  async loadPolicy(): Promise<Policy> {
    const row = await this.db.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first<{ value: string }>();
    this.chargeRows(row ? 1 : 0);
    if (!row) return DEFAULT_POLICY;
    try {
      const policy = JSON.parse(row.value) as Policy;
      return policy && ["observe", "approval", "automatic"].includes(policy.mode) && Array.isArray(policy.thresholds) ? policy : DEFAULT_POLICY;
    } catch { return DEFAULT_POLICY; }
  }

  async saveAssets(assets: AssetRef[]): Promise<void> {
    const now = Date.now();
    const statements = assets.map(asset => this.db.prepare(
        `INSERT INTO assets(account_id,family,asset_id,parent_id,name,scope,tier,metadata_json,discovered_at,seen_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
         ON CONFLICT(account_id,family,asset_id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,scope=excluded.scope,
           tier=CASE WHEN excluded.tier='control_plane' THEN 'control_plane' ELSE assets.tier END,
           metadata_json=json_patch(assets.metadata_json,excluded.metadata_json),seen_at=excluded.seen_at
         WHERE (excluded.tier='control_plane' AND assets.tier!='control_plane')
            OR json_patch(assets.metadata_json,excluded.metadata_json) != assets.metadata_json
            OR assets.seen_at < excluded.seen_at - 3600000`,
      ).bind(asset.accountId, asset.family, asset.id, asset.parentId ?? null, asset.name ?? null, asset.scope, asset.tier, JSON.stringify(asset.tags ?? {}), now));
    await this.runBatches(statements);
  }

  async saveCoverage(items: CoverageResult[]): Promise<void> {
    const statements = items.map(item => this.db.prepare(
        `INSERT INTO metric_coverage(family,metric,finest_scope,state,detail,checked_at) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(family,metric) DO UPDATE SET finest_scope=excluded.finest_scope,state=excluded.state,detail=excluded.detail,checked_at=excluded.checked_at`,
      ).bind(item.family, item.metric, item.finestScope, item.state, item.detail ?? null, item.checkedAt));
    await this.runBatches(statements);
  }

  async saveSamples(samples: MetricSample[]): Promise<void> {
    const statements = samples.map(sample => this.db.prepare(
        `INSERT OR IGNORE INTO metric_samples(account_id,family,asset_id,metric,unit,value,estimated_cost_usd,source,sampled,start_at,end_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
      ).bind(sample.asset.accountId, sample.asset.family, sample.asset.id, sample.metric, sample.unit, sample.value, sample.estimatedCostUsd ?? null, sample.source, sample.sampled ? 1 : 0, sample.start, sample.end));
    await this.runBatches(statements);
  }

  async baseline(sample: MetricSample, limit = 288): Promise<number[]> {
    const result = await this.db.prepare(
      `SELECT value FROM metric_samples WHERE account_id=?1 AND family=?2 AND asset_id=?3 AND metric=?4 AND end_at < ?5 ORDER BY end_at DESC LIMIT ?6`,
    ).bind(sample.asset.accountId, sample.asset.family, sample.asset.id, sample.metric, sample.end, limit).all<{ value: number }>();
    this.chargeMeta(result.meta);
    return result.results.map(row => row.value);
  }

  async applyAssetPolicies(samples: MetricSample[], family: string): Promise<void> {
    const result = await this.db.prepare(
      `SELECT asset_id,tier,name,metadata_json FROM assets WHERE account_id=?1 AND family=?2 LIMIT 5000`,
    ).bind(samples[0]?.asset.accountId ?? "", family).all<{ asset_id: string; tier: AssetRef["tier"]; name: string | null; metadata_json: string }>();
    this.chargeMeta(result.meta);
    const policies = new Map(result.results.map(row => [row.asset_id, row]));
    for (const sample of samples) {
      const direct = policies.get(sample.asset.id);
      const parent = sample.asset.parentId ? policies.get(sample.asset.parentId) : undefined;
      if (!direct && !parent) continue;
      const parentTags = parseTags(parent?.metadata_json);
      const directTags = parseTags(direct?.metadata_json);
      const tier = direct?.tier && direct.tier !== "unclassified" ? direct.tier : parent?.tier ?? direct?.tier ?? sample.asset.tier;
      sample.asset = {
        ...sample.asset,
        tier,
        name: direct?.name ?? sample.asset.name,
        tags: { ...parentTags, ...directTags },
      };
    }
  }

  async claimDailySummary(day: string): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT INTO settings(key,value,updated_at) VALUES('last_daily_summary',?1,?2)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
       WHERE settings.value != excluded.value`,
    ).bind(day, Date.now()).run();
    this.chargeMeta(result.meta);
    return (result.meta.changes ?? 0) > 0;
  }

  async recordEvaluation(evaluation: Evaluation): Promise<{ previous?: Incident; incident: Incident; notify: boolean }> {
    const row = await this.db.prepare(`SELECT * FROM incidents WHERE incident_key=?1 LIMIT 1`).bind(evaluation.key).first<Record<string, unknown>>();
    this.chargeRows(row ? 1 : 0);
    const previous = row ? fromIncidentRow(row, evaluation.asset) : undefined;
    const incident = upsertIncident(previous, evaluation);
    const lastNotifiedAt = row?.last_notified_at == null ? null : Number(row.last_notified_at);
    const notify = !previous || previous.severity !== incident.severity || lastNotifiedAt === null
      || incident.lastSeen - lastNotifiedAt >= 15 * 60_000;
    const written = await this.db.prepare(
      `INSERT INTO incidents(id,incident_key,account_id,family,asset_id,severity,metric,observed,threshold_value,expected,reason,proposed_action,status,first_seen,last_seen,occurrences,last_notified_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
       ON CONFLICT(incident_key) DO UPDATE SET severity=excluded.severity,observed=excluded.observed,threshold_value=excluded.threshold_value,expected=excluded.expected,reason=excluded.reason,proposed_action=excluded.proposed_action,status=excluded.status,last_seen=excluded.last_seen,occurrences=excluded.occurrences,last_notified_at=COALESCE(excluded.last_notified_at,incidents.last_notified_at)`,
    ).bind(incident.id, incident.key, incident.asset.accountId, incident.asset.family, incident.asset.id, incident.severity, incident.metric, incident.observed, incident.threshold ?? null, incident.expected ?? null, incident.reason, incident.action, incident.status, incident.firstSeen, incident.lastSeen, incident.occurrences, notify ? incident.lastSeen : null).run();
    this.chargeMeta(written.meta);
    return { previous, incident, notify };
  }

  async ensureRuntimeAction(incident: Incident): Promise<ControlAction> {
    const kind: ControlAction["kind"] = incident.asset.family === "queues"
      ? "pause_consumer"
      : "runtime_quarantine";
    const idempotencyKey = `${incident.id}:${incident.severity}:${kind}`;
    const existing = await this.db.prepare(`SELECT * FROM actions WHERE idempotency_key=?1 LIMIT 1`).bind(idempotencyKey).first<Record<string, unknown>>();
    this.chargeRows(existing ? 1 : 0);
    if (existing) return actionFromRow(existing, incident.asset);
    const id = crypto.randomUUID();
    const now = Date.now();
    const rollback = {
      workerScript: incident.asset.family === "workers" ? incident.asset.id : incident.asset.tags?.cloudflareWorkerScript,
      action: "resume",
    };
    const result = await this.db.prepare(
      `INSERT INTO actions(id,incident_id,idempotency_key,account_id,family,asset_id,kind,state,reason,observed_json,rollback_json,actor,created_at,updated_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,'prepared',?8,?9,?10,'brolly-policy',?11,?11)`,
    ).bind(id, incident.id, idempotencyKey, incident.asset.accountId, incident.asset.family, incident.asset.id, kind, incident.reason, JSON.stringify({ [incident.metric]: incident.observed }), JSON.stringify(rollback), now).run();
    this.chargeMeta(result.meta);
    await this.audit("brolly-policy", "action.prepare", id, { incidentId: incident.id, severity: incident.severity, rollback });
    return { id, incidentId: incident.id, asset: incident.asset, kind, state: "prepared", reason: incident.reason, observed: { [incident.metric]: incident.observed }, rollback, actor: "brolly-policy", createdAt: now };
  }

  async resolveIncident(key: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE incidents SET status='resolved',last_seen=?2 WHERE incident_key=?1 AND status!='resolved'`).bind(key, Date.now()).run();
    this.chargeMeta(result.meta);
  }

  async setActionState(actionId: string, state: ControlAction["state"], error?: string): Promise<void> {
    const result = await this.db.prepare(`UPDATE actions SET state=?2,error=?3,updated_at=?4 WHERE id=?1`).bind(actionId, state, error ?? null, Date.now()).run();
    this.chargeMeta(result.meta);
  }

  async claimActionState(actionId: string, expected: ControlAction["state"], next: ControlAction["state"]): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE actions SET state=?3,error=NULL,updated_at=?4 WHERE id=?1 AND state=?2`)
      .bind(actionId, expected, next, Date.now()).run();
    this.chargeMeta(result.meta);
    return Number(result.meta.changes ?? 0) === 1;
  }

  async audit(actor: string, action: string, target: string, detail: unknown): Promise<void> {
    const result = await this.db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
    this.chargeMeta(result.meta);
  }

  async listNotificationTargets(): Promise<Array<Record<string, unknown>>> {
    const result = await this.db.prepare(`SELECT * FROM notification_targets WHERE enabled=1 LIMIT 20`).all<Record<string, unknown>>();
    this.chargeMeta(result.meta);
    return result.results;
  }

  async notificationAllowed(targetId: string, kind: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.db.prepare(
      `SELECT
         SUM(CASE WHEN created_at>=?2 THEN 1 ELSE 0 END) AS hourly,
         SUM(CASE WHEN created_at>=?3 THEN 1 ELSE 0 END) AS daily
       FROM notification_deliveries WHERE target_id=?1 AND created_at>=?3`,
    ).bind(targetId, now - 3_600_000, now - 86_400_000).first<{ hourly: number | null; daily: number | null }>();
    this.chargeRows(result ? 1 : 0);
    return Number(result?.hourly ?? 0) < 20 && (kind !== "twilio" || Number(result?.daily ?? 0) < 5);
  }

  async recordNotification(targetId: string, incidentId: string, kind: string, result: { ok: boolean; status?: number; error?: string }): Promise<void> {
    const written = await this.db.prepare(
      `INSERT INTO notification_deliveries(id,target_id,incident_id,kind,ok,status_code,error,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`,
    ).bind(crypto.randomUUID(), targetId, incidentId, kind, result.ok ? 1 : 0, result.status ?? null, result.error?.slice(0, 2000) ?? null, Date.now()).run();
    this.chargeMeta(written.meta);
  }

  private chargeMeta(meta: { rows_read?: number; rows_written?: number; changes?: number }): void {
    this.chargeRows((meta.rows_read ?? 0) + (meta.rows_written ?? meta.changes ?? 0));
  }

  private async runBatches(statements: D1PreparedStatement[], batchSize = 100): Promise<void> {
    for (let offset = 0; offset < statements.length; offset += batchSize) {
      const results = await this.db.batch(statements.slice(offset, offset + batchSize));
      for (const result of results) this.chargeMeta(result.meta);
    }
  }
}

function parseTags(value?: string): Record<string, string> {
  if (!value) return {};
  try { return JSON.parse(value) as Record<string, string>; } catch { return {}; }
}

function actionFromRow(row: Record<string, unknown>, asset: AssetRef): ControlAction {
  return {
    id: String(row.id), incidentId: String(row.incident_id), asset, kind: row.kind as ControlAction["kind"], state: row.state as ControlAction["state"],
    reason: String(row.reason), observed: JSON.parse(String(row.observed_json)) as Record<string, number>, rollback: JSON.parse(String(row.rollback_json)) as Record<string, unknown>,
    actor: String(row.actor), createdAt: Number(row.created_at),
  };
}

function fromIncidentRow(row: Record<string, unknown>, asset: AssetRef): Incident {
  return {
    id: String(row.id), key: String(row.incident_key), asset, metric: String(row.metric), severity: row.severity as Incident["severity"],
    observed: Number(row.observed), threshold: row.threshold_value == null ? undefined : Number(row.threshold_value),
    expected: row.expected == null ? undefined : Number(row.expected), reason: String(row.reason), action: row.proposed_action as Incident["action"],
    status: row.status as Incident["status"], firstSeen: Number(row.first_seen), lastSeen: Number(row.last_seen), occurrences: Number(row.occurrences),
  };
}
