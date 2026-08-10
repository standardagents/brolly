import type { Env } from "./env.js";
import { runMonitor } from "./monitor.js";
import { executeCloudflareControl, executeDeploymentFuseControl, executeRuntimeControl, prepareCloudflareControl, rollbackCloudflareControl } from "./control.js";
import { DEFAULT_POLICY, METRIC_CATALOG, assetBudgetKey, type AssetRef, type ControlAction, type Policy } from "@standardagents/brolly-core";
import { sealJson } from "./credentials.js";
import { assetList, dashboardData, onboardingData } from "./dashboard-api.js";
import { configurationData, refreshConfiguration } from "./configuration.js";

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMonitor(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "brolly-guard" });
    if (!authorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });

    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      return Response.json(await dashboardData(env));
    }

    if (url.pathname === "/api/assets" && request.method === "GET") {
      return Response.json(await assetList(request, env));
    }

    if (url.pathname === "/api/configuration" && request.method === "GET") {
      return Response.json(await configurationData(env));
    }

    if (url.pathname === "/api/configuration/verify" && request.method === "POST") {
      const body = await request.json<{ workerScripts?: string[] }>();
      try {
        const result = await refreshConfiguration(env, body.workerScripts ?? []);
        await audit(env.DB, "admin", "configuration.verify", body.workerScripts?.join(",") ?? "", { workers: body.workerScripts?.length ?? 0 });
        return Response.json(result);
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    }

    if (url.pathname === "/api/onboarding" && request.method === "GET") {
      return Response.json(await onboardingData(env));
    }

    if (url.pathname === "/api/onboarding" && request.method === "POST") {
      const body = await request.json<{ policy: Policy; integrations?: Array<{ family: "workers" | "durable_objects"; id: string; workerScript?: string; installed: boolean }> }>();
      if (!validPolicy(body.policy, true)) return Response.json({ error: "Every account, product, resource, and object limit must be finite, nonnegative, and ordered warning ≤ critical ≤ emergency" }, { status: 400 });
      const scopedAssets = await env.DB.prepare(`SELECT family,asset_id,scope,metadata_json FROM assets WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace') LIMIT 2500`).all<{ family: string; asset_id: string; scope: AssetRef["scope"]; metadata_json: string }>();
      const missingScopedBudgets = scopedAssets.results.filter(asset => !body.policy.assetDailySpend?.[assetBudgetKey({ family: asset.family, scope: asset.scope, id: asset.asset_id })]);
      if (missingScopedBudgets.length) return Response.json({ error: `Set limits for every discovered Worker and Durable Object namespace (${missingScopedBudgets.length} missing)` }, { status: 400 });
      const now = Date.now();
      const knownAssets = new Map(scopedAssets.results.map(asset => [`${asset.family}:${asset.asset_id}`, asset]));
      const integrationStatements: D1PreparedStatement[] = [];
      for (const integration of body.integrations ?? []) {
        const asset = knownAssets.get(`${integration.family}:${integration.id}`);
        if (!asset) return Response.json({ error: `Unknown runtime integration target ${integration.family}/${integration.id}` }, { status: 400 });
        const workerScript = integration.workerScript?.trim();
        if (workerScript && !/^[A-Za-z0-9_-]+$/.test(workerScript)) return Response.json({ error: `Invalid Worker script name for ${integration.id}` }, { status: 400 });
        let tags: Record<string, string>;
        try { tags = JSON.parse(asset.metadata_json || "{}") as Record<string, string>; } catch { tags = {}; }
        if (integration.installed && workerScript) {
          tags.workerScript = workerScript;
          tags.brollyFuse = "true";
        } else {
          delete tags.workerScript;
          delete tags.brollyFuse;
        }
        integrationStatements.push(env.DB.prepare(`UPDATE assets SET metadata_json=?3,seen_at=?4 WHERE family=?1 AND asset_id=?2 AND account_id=?5`).bind(integration.family, integration.id, JSON.stringify(tags), now, env.BROLLY_ACCOUNT_ID));
      }
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('policy',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(JSON.stringify(body.policy), now),
        env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('onboarding_complete','true',?1) ON CONFLICT(key) DO UPDATE SET value='true',updated_at=excluded.updated_at`).bind(now),
      ]);
      for (let index = 0; index < integrationStatements.length; index += 100) await env.DB.batch(integrationStatements.slice(index, index + 100));
      await audit(env.DB, "admin", "onboarding.complete", body.policy.version, { mode: body.policy.mode, families: Object.keys(body.policy.familyDailySpend ?? {}).length, scopedAssets: Object.keys(body.policy.assetDailySpend ?? {}).length, runtimeIntegrations: body.integrations?.filter(item => item.installed).length ?? 0, thresholds: body.policy.thresholds.length });
      return Response.json({ ok: true, policy: body.policy });
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      const [incidentRows, coverageRow, assetRow, sampleRow] = await Promise.all([
        env.DB.prepare(`SELECT severity,family,asset_id,reason,observed,last_seen FROM incidents WHERE status='open' AND metric!='telemetry_coverage' ORDER BY CASE severity WHEN 'emergency' THEN 0 WHEN 'critical' THEN 1 ELSE 2 END,last_seen DESC LIMIT 100`).all(),
        env.DB.prepare(`SELECT SUM(CASE WHEN state!='healthy' THEN 1 ELSE 0 END) AS c,MAX(checked_at) AS at FROM metric_coverage`).first<{ c: number | null; at: number | null }>(),
        env.DB.prepare(`SELECT COUNT(*) AS c FROM assets`).first<{ c: number }>(),
        env.DB.prepare(`SELECT MAX(end_at) AS at FROM metric_samples`).first<{ at: number | null }>(),
      ]);
      return Response.json({ openIncidents: incidentRows.results.length, coverageGaps: coverageRow?.c ?? 0, assets: assetRow?.c ?? 0, lastCheckAt: coverageRow?.at ?? null, lastSampleAt: sampleRow?.at ?? null, incidents: incidentRows.results });
    }

    if (url.pathname === "/api/incidents" && request.method === "GET") {
      const result = await env.DB.prepare(`SELECT * FROM incidents ORDER BY last_seen DESC LIMIT 250`).all();
      return Response.json({ incidents: result.results });
    }

    if (url.pathname === "/api/run" && request.method === "POST") {
      await runMonitor(env);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/policy" && request.method === "GET") {
      const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first<{ value: string }>();
      return Response.json(row ? JSON.parse(row.value) : DEFAULT_POLICY);
    }

    if (url.pathname === "/api/policy" && request.method === "PUT") {
      const policy = await request.json<Policy>();
      if (!validPolicy(policy)) {
        return Response.json({ error: "Invalid policy" }, { status: 400 });
      }
      await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('policy',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(JSON.stringify(policy), Date.now()).run();
      await audit(env.DB, "admin", "policy.update", policy.version, { mode: policy.mode, thresholds: policy.thresholds.length });
      return Response.json({ ok: true, policy });
    }

    if (url.pathname === "/api/actions" && request.method === "POST") {
      const body = await request.json<{ incidentId: string; runtimeUrl?: string; workerScript?: string; execute?: boolean; kind?: ControlAction["kind"] }>();
      const incident = await env.DB.prepare(`SELECT * FROM incidents WHERE id=?1 LIMIT 1`).bind(body.incidentId).first<Record<string, unknown>>();
      if (!incident) return Response.json({ error: "Incident not found" }, { status: 404 });
      const assetRow = await env.DB.prepare(`SELECT * FROM assets WHERE account_id=?1 AND family=?2 AND asset_id=?3 LIMIT 1`).bind(incident.account_id, incident.family, incident.asset_id).first<Record<string, unknown>>();
      const asset = assetFromRows(incident, assetRow);
      if (asset.tier === "control_plane" || asset.tier === "critical" || asset.tier === "unclassified") {
        return Response.json({ error: `Asset tier ${asset.tier} requires classification/override before a stop can be prepared` }, { status: 409 });
      }
      const now = Date.now();
      const id = crypto.randomUUID();
      const fuseInstalled = asset.tags?.brollyFuse === "true";
      const configuredWorkerScript = body.workerScript ?? (fuseInstalled ? (asset.tags?.workerScript ?? (asset.family === "workers" ? asset.id : undefined)) : undefined);
      const kind = body.kind ?? (asset.family === "queues" ? "pause_consumer" : configuredWorkerScript ? "runtime_quarantine" : asset.family === "workers" ? "disable_trigger" : "runtime_quarantine");
      const validKind = asset.family === "queues" ? kind === "pause_consumer"
        : asset.family === "workers" ? kind === "disable_trigger" || kind === "runtime_quarantine"
          : asset.family === "durable_objects" ? kind === "runtime_quarantine" : false;
      if (!validKind) return Response.json({ error: `Control ${kind} is not valid for ${asset.family}` }, { status: 400 });
      if (kind === "runtime_quarantine" && body.execute && !configuredWorkerScript && !body.runtimeUrl) return Response.json({ error: "Owning Worker script is required" }, { status: 400 });
      const action: ControlAction = {
        id, incidentId: body.incidentId, asset, kind, state: "prepared",
        reason: String(incident.reason), observed: { [String(incident.metric)]: Number(incident.observed) },
        rollback: { ...(body.runtimeUrl ? { runtimeUrl: body.runtimeUrl } : {}), ...(configuredWorkerScript ? { workerScript: configuredWorkerScript } : {}), action: "resume" }, actor: "admin", createdAt: now,
      };
      await env.DB.prepare(
        `INSERT INTO actions(id,incident_id,idempotency_key,account_id,family,asset_id,kind,state,reason,observed_json,rollback_json,actor,created_at,updated_at)
         VALUES(?1,?2,?1,?3,?4,?5,?6,'prepared',?7,?8,?9,'admin',?10,?10)`,
      ).bind(id, body.incidentId, asset.accountId, asset.family, asset.id, action.kind, action.reason, JSON.stringify(action.observed), JSON.stringify(action.rollback), now).run();
      await audit(env.DB, "admin", "action.prepare", id, action);
      if (!body.execute) return Response.json({ ok: true, action }, { status: 201 });
      return runAction(env, action, { runtimeUrl: body.runtimeUrl, workerScript: configuredWorkerScript }, "quarantine", false);
    }

    const actionMatch = url.pathname.match(/^\/api\/actions\/([^/]+)\/(execute|resume)$/);
    if (actionMatch && request.method === "POST") {
      const id = actionMatch[1]!;
      const row = await env.DB.prepare(`SELECT * FROM actions WHERE id=?1 LIMIT 1`).bind(id).first<Record<string, unknown>>();
      if (!row) return Response.json({ error: "Action not found" }, { status: 404 });
      const rollback = JSON.parse(String(row.rollback_json)) as { runtimeUrl?: string; workerScript?: string };
      const body = await request.json<{ runtimeUrl?: string; workerScript?: string; releaseForensicHold?: boolean }>().catch(() => ({} as { runtimeUrl?: string; workerScript?: string; releaseForensicHold?: boolean }));
      const runtimeUrl = body.runtimeUrl ?? rollback.runtimeUrl;
      const workerScript = body.workerScript ?? rollback.workerScript ?? (row.family === "workers" ? String(row.asset_id) : undefined);
      if (row.kind === "runtime_quarantine" && !runtimeUrl && !workerScript) return Response.json({ error: "Owning Worker script is required" }, { status: 400 });
      const assetRow = await env.DB.prepare(`SELECT * FROM assets WHERE account_id=?1 AND family=?2 AND asset_id=?3 LIMIT 1`).bind(row.account_id, row.family, row.asset_id).first<Record<string, unknown>>();
      const action: ControlAction = {
        id: String(row.id), incidentId: String(row.incident_id), asset: assetFromRows(row, assetRow), kind: row.kind as ControlAction["kind"],
        state: row.state as ControlAction["state"], reason: String(row.reason), observed: JSON.parse(String(row.observed_json)), rollback,
        actor: "admin", createdAt: Number(row.created_at),
      };
      return runAction(env, action, { runtimeUrl, workerScript }, actionMatch[2] === "resume" ? "resume" : "quarantine", body.releaseForensicHold === true);
    }

    if (url.pathname === "/api/targets" && request.method === "GET") {
      const result = await env.DB.prepare(
        `SELECT t.id,t.kind,t.enabled,t.minimum_severity,t.created_at,t.updated_at,
          (SELECT d.created_at FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY d.created_at DESC LIMIT 1) AS last_delivery_at,
          (SELECT d.ok FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY d.created_at DESC LIMIT 1) AS last_delivery_ok,
          (SELECT d.error FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY d.created_at DESC LIMIT 1) AS last_delivery_error
         FROM notification_targets t ORDER BY t.created_at ASC LIMIT 50`,
      ).all<Record<string, unknown>>();
      return Response.json({
        targets: result.results.map(row => ({
          id: String(row.id), kind: String(row.kind), enabled: Number(row.enabled) === 1,
          minimumSeverity: String(row.minimum_severity), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
          lastDeliveryAt: row.last_delivery_at == null ? null : Number(row.last_delivery_at),
          lastDeliveryOk: row.last_delivery_ok == null ? null : Number(row.last_delivery_ok) === 1,
          lastDeliveryError: row.last_delivery_error == null ? null : String(row.last_delivery_error),
        })),
        credentialStorageReady: Boolean(env.BROLLY_CREDENTIAL_KEY),
      });
    }

    if (url.pathname === "/api/targets" && request.method === "POST") {
      const body = await request.json<{ id?: string; kind: string; config: Record<string, unknown>; enabled?: boolean; minimumSeverity?: string }>();
      if (!["discord", "slack", "webhook", "resend", "postmark", "twilio"].includes(body.kind)) return Response.json({ error: "Invalid notification target kind" }, { status: 400 });
      if (!["info", "warning", "critical", "emergency"].includes(body.minimumSeverity ?? "warning")) return Response.json({ error: "Invalid minimum severity" }, { status: 400 });
      const configError = validateNotificationConfig(body.kind, body.config);
      if (configError) return Response.json({ error: configError }, { status: 400 });
      if (!env.BROLLY_CREDENTIAL_KEY) return Response.json({ error: "BROLLY_CREDENTIAL_KEY is required; target credentials will never be stored in plaintext" }, { status: 503 });
      const id = body.id ?? crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO notification_targets(id,kind,config_json,enabled,minimum_severity,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,config_json=excluded.config_json,enabled=excluded.enabled,minimum_severity=excluded.minimum_severity,updated_at=excluded.updated_at`,
      ).bind(id, body.kind, await sealJson(body.config, env.BROLLY_CREDENTIAL_KEY), body.enabled === false ? 0 : 1, body.minimumSeverity ?? "warning", now).run();
      await audit(env.DB, "admin", "notification_target.upsert", id, { kind: body.kind });
      return Response.json({ ok: true, id });
    }

    const targetMatch = url.pathname.match(/^\/api\/targets\/([^/]+)$/);
    if (targetMatch && request.method === "PATCH") {
      const body = await request.json<{ enabled?: boolean; minimumSeverity?: string }>();
      if (body.minimumSeverity !== undefined && !["info", "warning", "critical", "emergency"].includes(body.minimumSeverity)) {
        return Response.json({ error: "Invalid minimum severity" }, { status: 400 });
      }
      if (body.enabled === undefined && body.minimumSeverity === undefined) return Response.json({ error: "No target change supplied" }, { status: 400 });
      const id = decodeURIComponent(targetMatch[1]!);
      const result = await env.DB.prepare(
        `UPDATE notification_targets SET enabled=COALESCE(?2,enabled),minimum_severity=COALESCE(?3,minimum_severity),updated_at=?4 WHERE id=?1`,
      ).bind(id, body.enabled === undefined ? null : body.enabled ? 1 : 0, body.minimumSeverity ?? null, Date.now()).run();
      if ((result.meta.changes ?? 0) === 0) return Response.json({ error: "Notification target not found" }, { status: 404 });
      await audit(env.DB, "admin", "notification_target.update", id, body);
      return Response.json({ ok: true, id });
    }

    const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/([^/]+)$/);
    if (assetMatch && request.method === "PATCH") {
      const body = await request.json<{ tier: AssetRef["tier"]; tags?: Record<string, string | null>; name?: string }>();
      if (!["control_plane", "critical", "standard", "disposable", "unclassified"].includes(body.tier)) {
        return Response.json({ error: "Invalid asset tier" }, { status: 400 });
      }
      const family = decodeURIComponent(assetMatch[1]!);
      const id = decodeURIComponent(assetMatch[2]!);
      const result = await env.DB.prepare(`UPDATE assets SET tier=?4,metadata_json=json_patch(metadata_json,?5),name=COALESCE(?6,name),seen_at=?7 WHERE account_id=?1 AND family=?2 AND asset_id=?3`).bind(env.BROLLY_ACCOUNT_ID, family, id, body.tier, JSON.stringify(body.tags ?? {}), body.name ?? null, Date.now()).run();
      if ((result.meta.changes ?? 0) === 0) return Response.json({ error: "Asset not found" }, { status: 404 });
      await audit(env.DB, "admin", "asset.classify", `${family}/${id}`, body);
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/api/incidents/") && url.pathname.endsWith("/ack") && request.method === "POST") {
      const id = url.pathname.split("/")[3];
      await env.DB.prepare(`UPDATE incidents SET status='acknowledged' WHERE id=?1`).bind(id).run();
      await audit(env.DB, "admin", "incident.acknowledge", id ?? "", {});
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

async function runAction(env: Env, action: ControlAction, control: { runtimeUrl?: string; workerScript?: string }, requested: "quarantine" | "resume", release: boolean): Promise<Response> {
  const startState = requested === "resume" ? "running" : "approved";
  await env.DB.prepare(`UPDATE actions SET state=?2,updated_at=?3 WHERE id=?1`).bind(action.id, startState, Date.now()).run();
  await audit(env.DB, "admin", `action.${requested}.start`, action.id, { ...control, releaseForensicHold: release, kind: action.kind });
  try {
    let detail = JSON.stringify({ ok: true });
    if (action.kind === "runtime_quarantine") {
      if (control.workerScript) {
        detail = JSON.stringify(await executeDeploymentFuseControl(env, action, control.workerScript, requested));
      } else {
        const response = await executeRuntimeControl(env, action, control.runtimeUrl!, requested, release);
        detail = await response.text();
        if (!response.ok) throw new Error(`Runtime returned ${response.status}: ${detail}`);
      }
    } else if (requested === "resume") {
      await rollbackCloudflareControl(env, action);
    } else {
      const rollback = await prepareCloudflareControl(env, action);
      action.rollback = rollback;
      await env.DB.prepare(`UPDATE actions SET rollback_json=?2,updated_at=?3 WHERE id=?1`).bind(action.id, JSON.stringify(rollback), Date.now()).run();
      await audit(env.DB, "admin", "action.rollback_snapshot", action.id, rollback);
      await executeCloudflareControl(env, action);
      detail = JSON.stringify({ ok: true, rollback });
    }
    await env.DB.prepare(`UPDATE actions SET state=?2,error=NULL,updated_at=?3 WHERE id=?1`).bind(action.id, requested === "resume" ? "rolled_back" : "succeeded", Date.now()).run();
    await audit(env.DB, "admin", `action.${requested}.succeeded`, action.id, { response: detail.slice(0, 4000) });
    return new Response(detail, { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`UPDATE actions SET state='failed',error=?2,updated_at=?3 WHERE id=?1`).bind(action.id, message, Date.now()).run();
    await audit(env.DB, "admin", `action.${requested}.failed`, action.id, { error: message });
    return Response.json({ error: message, actionId: action.id }, { status: 502 });
  }
}

function assetFromRows(primary: Record<string, unknown>, asset: Record<string, unknown> | null): AssetRef {
  let tags: Record<string, string> = {};
  try { tags = JSON.parse(String(asset?.metadata_json ?? "{}")) as Record<string, string>; } catch { /* optional metadata */ }
  return {
    accountId: String(primary.account_id), family: String(primary.family), id: String(primary.asset_id),
    parentId: asset?.parent_id == null ? undefined : String(asset.parent_id), name: asset?.name == null ? undefined : String(asset.name),
    scope: (asset?.scope ?? (primary.family === "durable_objects" ? "object" : "resource")) as AssetRef["scope"],
    tier: (asset?.tier ?? "unclassified") as AssetRef["tier"], tags,
  };
}

function authorized(request: Request, env: Env): boolean {
  const value = request.headers.get("authorization");
  return !!env.BROLLY_ADMIN_TOKEN && value === `Bearer ${env.BROLLY_ADMIN_TOKEN}`;
}

export function validateNotificationConfig(kind: string, config: Record<string, unknown> | null | undefined): string | null {
  if (!config || typeof config !== "object") return "Notification configuration is required";
  const present = (key: string) => typeof config[key] === "string" && String(config[key]).trim().length > 0;
  if ((kind === "discord" || kind === "slack" || kind === "webhook") && !present("url")) return `${kind} webhook URL is required`;
  if (kind === "twilio" && !["accountSid", "token", "from", "to"].every(present)) return "Twilio account SID, auth token, from number, and destination number are required";
  if (kind === "resend" && !["apiKey", "from", "to"].every(present)) return "Resend API key, from address, and destination address are required";
  if (kind === "postmark" && !["token", "from", "to"].every(present)) return "Postmark token, from address, and destination address are required";
  return null;
}

async function audit(db: D1Database, actor: string, action: string, target: string, detail: unknown): Promise<void> {
  await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
}

function validPolicy(policy: Policy, requireEveryFamily = false): boolean {
  const finiteNonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!["observe", "approval", "automatic"].includes(policy?.mode) || typeof policy?.version !== "string" || !policy.version || !Array.isArray(policy.thresholds)) return false;
  const spend = policy.accountDailySpend;
  if (!spend || !finiteNonnegative(spend.warning) || !finiteNonnegative(spend.critical) || !finiteNonnegative(spend.emergency)
    || spend.warning > spend.critical || spend.critical > spend.emergency) return false;
  const familySpend = policy.familyDailySpend ?? {};
  if (requireEveryFamily && METRIC_CATALOG.some(definition => !familySpend[definition.family])) return false;
  if (Object.values(familySpend).some(limit => !finiteNonnegative(limit?.warning) || !finiteNonnegative(limit?.critical) || !finiteNonnegative(limit?.emergency)
    || limit.warning > limit.critical || limit.critical > limit.emergency)) return false;
  if (Object.values(policy.assetDailySpend ?? {}).some(limit => !finiteNonnegative(limit?.warning) || !finiteNonnegative(limit?.critical) || !finiteNonnegative(limit?.emergency)
    || limit.warning > limit.critical || limit.critical > limit.emergency)) return false;
  return policy.thresholds.every(threshold => typeof threshold.metric === "string" && !!threshold.metric
    && finiteNonnegative(threshold.windowMs) && threshold.windowMs > 0
    && [threshold.warning, threshold.critical, threshold.emergency, threshold.minimumBaselineSamples, threshold.anomalyMultiplier]
      .every(value => value === undefined || finiteNonnegative(value)));
}
