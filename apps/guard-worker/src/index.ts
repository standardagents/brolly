import type { Env } from "./env.js";
import { runMonitor } from "./monitor.js";
import { executeCloudflareControl, executeDeploymentFuseControl, prepareCloudflareControl, rollbackCloudflareControl } from "./control.js";
import { DEFAULT_POLICY, METRIC_CATALOG, RunBudget, assetBudgetKey, type AssetRef, type ControlAction, type Policy } from "@standardagents/brolly-core";
import { assetList, dashboardData, onboardingData } from "./dashboard-api.js";
import { configurationData, refreshConfiguration } from "./configuration.js";
import { authRoute, authenticate, configuredEnv } from "./auth.js";
import { BudgetEstimateInProgressError, billingAccessConfiguration, configureOnboardingBillingAccess, onboardingBudgetEstimates, removeOnboardingBillingAccess } from "./budget-estimates.js";
import { releaseStatus, saveUpdateRepository } from "./updates.js";
import { ledgerApiRoute } from "./ledger-api.js";
import { LedgerStore } from "./ledger-store.js";
import { migrateLegacyPolicyRules } from "./policy-migration.js";
import { billingIngestionAvailable, ensureInitialIngestionJob, initialIngestionProgress, runInitialIngestion } from "./initial-ingestion.js";
import { configuredLedgerRunLimits } from "./ledger-settings.js";
import { notificationApiRoute } from "./notification-api.js";
import { alertLevelsApiRoute, loadAlertLevels } from "./alert-levels.js";
import { CloudflareClient } from "./cloudflare.js";

type RuntimeIntegrationInput = { family: "workers" | "durable_objects"; id: string; workerScript?: string; installed: boolean };
type RuntimeAssetRow = { family: string; asset_id: string; scope: AssetRef["scope"]; metadata_json: string };

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const activeEnv = await configuredEnv(env);
      if (activeEnv) await runMonitor(activeEnv);
    })());
  },

  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "brolly-guard" });
    const authResponse = await authRoute(request, env);
    if (authResponse) return authResponse;
    const actor = await authenticate(request, env);
    if (!actor) return Response.json({ error: "Sign in with Cloudflare" }, { status: 401 });
    const activeEnv = await configuredEnv(env, actor);
    if (!activeEnv) return Response.json({ error: "Choose one Cloudflare account during sign-in before using Brolly" }, { status: 409 });
    env = activeEnv;

    const notificationResponse = await notificationApiRoute(request, env, actor.actor);
    if (notificationResponse) return notificationResponse;

    const alertLevelsResponse = await alertLevelsApiRoute(request, env, actor.actor);
    if (alertLevelsResponse) return alertLevelsResponse;

    const ledgerResponse = await ledgerApiRoute(request, env, actor.actor);
    if (ledgerResponse) return ledgerResponse;

    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      return Response.json(await dashboardData(env));
    }

    if (url.pathname === "/api/releases" && request.method === "GET") {
      return Response.json(await releaseStatus(env), { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/update-settings" && request.method === "PUT") {
      const body = await request.json<{ repository?: string }>();
      try {
        const repository = await saveUpdateRepository(env, body.repository ?? "");
        await audit(env.DB, actor.actor, "updates.repository", repository ?? "", { repository });
        return Response.json({ ok: true, repository });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    }

    if (url.pathname === "/api/assets" && request.method === "GET") {
      return Response.json(await assetList(request, env));
    }

    if (url.pathname === "/api/cloudflare-zones" && request.method === "GET") {
      const budget = new RunBudget({ apiCalls: 10, databaseRows: 0, samples: 500, wallMs: 10_000 });
      return Response.json({ accountId: env.BROLLY_ACCOUNT_ID, zones: await new CloudflareClient(env, budget).zones() }, { headers: { "cache-control": "no-store" } });
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

    if (url.pathname === "/api/onboarding/ingest" && request.method === "GET") {
      return Response.json(await initialIngestionProgress(env.DB, env.BROLLY_ACCOUNT_ID), {
        headers: { "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/onboarding/ingest" && request.method === "POST") {
      const job = await ensureInitialIngestionJob(env.DB, env.BROLLY_ACCOUNT_ID, {
        billingAvailable: await billingIngestionAvailable(env),
      });
      if (job.created || job.status === "pending" || job.status === "running") {
        const work = runInitialIngestion(env, job.id).catch(() => undefined);
        if (ctx) ctx.waitUntil(work);
        else void work;
      }
      return Response.json({ ok: true, job }, { status: job.created ? 202 : 200, headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/api/onboarding/estimates" && request.method === "POST") {
      try {
        return Response.json(await onboardingBudgetEstimates(env), { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: error instanceof BudgetEstimateInProgressError ? 429 : 400 },
        );
      }
    }

    const billingAccessRoute = url.pathname === "/api/billing-access" || url.pathname === "/api/onboarding/billing-access";

    if (billingAccessRoute && request.method === "GET") {
      return Response.json(await billingAccessConfiguration(env), { headers: { "cache-control": "no-store" } });
    }

    if (billingAccessRoute && request.method === "PUT") {
      const body = await request.json<{ token?: string }>();
      try {
        const result = await configureOnboardingBillingAccess(env, body.token ?? "");
        await audit(env.DB, actor.actor, "billing_access.configure", env.BROLLY_ACCOUNT_ID, { verified: true, records: result.records });
        return Response.json({ ok: true, ...result });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    }

    if (billingAccessRoute && request.method === "DELETE") {
      if (env.CLOUDFLARE_BILLING_TOKEN) return Response.json({ error: "Billing access is supplied as a Worker secret and must be removed in Cloudflare" }, { status: 409 });
      await removeOnboardingBillingAccess(env);
      await audit(env.DB, actor.actor, "billing_access.remove", env.BROLLY_ACCOUNT_ID, {});
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/onboarding" && request.method === "POST") {
      const body = await request.json<{ policy: Policy; integrations?: RuntimeIntegrationInput[] }>();
      const alertLevels = await loadAlertLevels(env.DB);
      if (!validPolicy(body.policy, true, alertLevels.map(level => level.id))) return Response.json({ error: "Policy limits and risk tolerance must be finite, in range, and ordered by alert level" }, { status: 400 });
      const scopedAssets = await env.DB.prepare(`SELECT family,asset_id,scope,metadata_json FROM assets WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace') LIMIT 2500`).all<RuntimeAssetRow>();
      const missingScopedBudgets = scopedAssets.results.filter(asset => !body.policy.assetDailySpend?.[assetBudgetKey({ family: asset.family, scope: asset.scope, id: asset.asset_id })]);
      if (missingScopedBudgets.length) return Response.json({ error: `Set limits for every discovered Worker and Durable Object namespace (${missingScopedBudgets.length} missing)` }, { status: 400 });
      const now = Date.now();
      const integrationUpdates = prepareRuntimeIntegrationUpdates(env, scopedAssets.results, body.integrations ?? [], now);
      if ("error" in integrationUpdates) return Response.json({ error: integrationUpdates.error }, { status: integrationUpdates.status });
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('policy',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(JSON.stringify(body.policy), now),
        env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('onboarding_complete','true',?1) ON CONFLICT(key) DO UPDATE SET value='true',updated_at=excluded.updated_at`).bind(now),
      ]);
      for (let index = 0; index < integrationUpdates.statements.length; index += 100) await env.DB.batch(integrationUpdates.statements.slice(index, index + 100));
      const ledger = new LedgerStore(env.DB);
      await ledger.syncMetricCatalog();
      await migrateLegacyPolicyRules(env.DB, env.BROLLY_ACCOUNT_ID, body.policy, true);
      const initialIngestion = await ensureInitialIngestionJob(env.DB, env.BROLLY_ACCOUNT_ID, {
        billingAvailable: await billingIngestionAvailable(env), now,
      });
      if (initialIngestion.created || initialIngestion.status === "pending" || initialIngestion.status === "running") {
        const work = runInitialIngestion(env, initialIngestion.id, now).catch(() => undefined);
        if (ctx) ctx.waitUntil(work);
        else void work;
      }
      await audit(env.DB, "admin", "onboarding.complete", body.policy.version, { levels: alertLevels.length, families: Object.keys(body.policy.familyDailySpend ?? {}).length, scopedAssets: Object.keys(body.policy.assetDailySpend ?? {}).length, runtimeIntegrations: body.integrations?.filter(item => item.installed).length ?? 0, thresholds: body.policy.thresholds.length });
      return Response.json({ ok: true, policy: body.policy, initialIngestion });
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
      await runMonitor(env, { force: true });
      const [lastRun, collectors, runLimits] = await Promise.all([
        env.DB.prepare(
          `SELECT id,started_at,completed_at,status,coverage_status,graphql_queries,rest_requests,
             d1_rows_read,d1_rows_written,continuation_json
           FROM monitor_runs WHERE account_id=?1 ORDER BY started_at DESC LIMIT 1`,
        ).bind(env.BROLLY_ACCOUNT_ID).first<Record<string, unknown>>(),
        env.DB.prepare(
          `SELECT collector_key,dataset,watermark_at,state FROM collector_capabilities
           WHERE account_id=?1 ORDER BY collector_key,dataset`,
        ).bind(env.BROLLY_ACCOUNT_ID).all<Record<string, unknown>>(),
        configuredLedgerRunLimits(env.DB),
      ]);
      return Response.json({
        ok: true,
        budget: runLimits,
        datasets: collectors.results.map(row => ({
          collectorKey: row.collector_key,
          dataset: row.dataset,
          watermarkAt: row.watermark_at,
          state: row.state,
        })),
        run: lastRun ? {
          id: lastRun.id,
          startedAt: lastRun.started_at,
          completedAt: lastRun.completed_at,
          status: lastRun.status,
          coverage: lastRun.coverage_status,
          graphqlQueries: lastRun.graphql_queries,
          restRequests: lastRun.rest_requests,
          d1RowsRead: lastRun.d1_rows_read,
          d1RowsWritten: lastRun.d1_rows_written,
          continuation: lastRun.continuation_json ? JSON.parse(String(lastRun.continuation_json)) : null,
        } : null,
      });
    }

    if (url.pathname === "/api/policy" && request.method === "GET") {
      const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first<{ value: string }>();
      return Response.json(row ? JSON.parse(row.value) : DEFAULT_POLICY);
    }

    if (url.pathname === "/api/policy" && request.method === "PUT") {
      const body = await request.json<Policy | { policy: Policy; integrations?: RuntimeIntegrationInput[] }>();
      const policy = "policy" in body ? body.policy : body;
      const integrations = "policy" in body ? body.integrations ?? [] : [];
      const alertLevels = await loadAlertLevels(env.DB);
      if (!validPolicy(policy, false, alertLevels.map(level => level.id))) {
        return Response.json({ error: "Invalid policy" }, { status: 400 });
      }
      const now = Date.now();
      const scopedAssets = integrations.length
        ? await env.DB.prepare(`SELECT family,asset_id,scope,metadata_json FROM assets WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace') LIMIT 2500`).all<RuntimeAssetRow>()
        : { results: [] as RuntimeAssetRow[] };
      const integrationUpdates = prepareRuntimeIntegrationUpdates(env, scopedAssets.results, integrations, now);
      if ("error" in integrationUpdates) return Response.json({ error: integrationUpdates.error }, { status: integrationUpdates.status });
      await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('policy',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(JSON.stringify(policy), now).run();
      for (let index = 0; index < integrationUpdates.statements.length; index += 100) await env.DB.batch(integrationUpdates.statements.slice(index, index + 100));
      await new LedgerStore(env.DB).syncMetricCatalog();
      await migrateLegacyPolicyRules(env.DB, env.BROLLY_ACCOUNT_ID, policy, true);
      await audit(env.DB, "admin", "policy.update", policy.version, { levels: alertLevels.length, thresholds: policy.thresholds.length, runtimeIntegrations: integrations.filter(item => item.installed).length });
      return Response.json({ ok: true, policy });
    }

    if (url.pathname === "/api/actions" && request.method === "POST") {
      const body = await request.json<{ incidentId: string; execute?: boolean }>();
      const incident = await env.DB.prepare(`SELECT * FROM incidents WHERE id=?1 LIMIT 1`).bind(body.incidentId).first<Record<string, unknown>>();
      if (!incident) return Response.json({ error: "Incident not found" }, { status: 404 });
      const incidentError = executableIncidentError(incident);
      if (incidentError) return Response.json({ error: incidentError }, { status: 409 });
      const existingAction = await env.DB.prepare(
        `SELECT id,state FROM actions WHERE incident_id=?1 AND state IN ('prepared','running','succeeded','failed') ORDER BY created_at DESC LIMIT 1`,
      ).bind(body.incidentId).first<{ id: string; state: string }>();
      if (existingAction) return Response.json({ error: `This incident already has an active ${existingAction.state} action`, actionId: existingAction.id }, { status: 409 });
      const assetRow = await env.DB.prepare(`SELECT * FROM assets WHERE account_id=?1 AND family=?2 AND asset_id=?3 LIMIT 1`).bind(incident.account_id, incident.family, incident.asset_id).first<Record<string, unknown>>();
      const asset = await assetFromRows(env, incident, assetRow);
      if (asset.tier === "control_plane" || asset.tier === "critical" || asset.tier === "unclassified") {
        return Response.json({ error: `Asset tier ${asset.tier} requires classification/override before a stop can be prepared` }, { status: 409 });
      }
      const now = Date.now();
      const id = crypto.randomUUID();
      const fuseInstalled = asset.tags?.brollyFuse === "true";
      const configuredWorkerScript = fuseInstalled ? authoritativeWorkerScript(asset) : undefined;
      const kind: ControlAction["kind"] = asset.family === "queues" ? "pause_consumer" : "runtime_quarantine";
      const validKind = asset.family === "queues" ? kind === "pause_consumer"
        : asset.family === "workers" ? kind === "runtime_quarantine"
          : asset.family === "durable_objects" ? kind === "runtime_quarantine" : false;
      if (!validKind) return Response.json({ error: `Control ${kind} is not valid for ${asset.family}` }, { status: 400 });
      if (kind === "runtime_quarantine" && !configuredWorkerScript) return Response.json({ error: "A verified Cloudflare-owned Worker mapping and Brolly fuse are required" }, { status: 409 });
      const action: ControlAction = {
        id, incidentId: body.incidentId, asset, kind, state: "prepared",
        reason: String(incident.reason), observed: { [String(incident.metric)]: Number(incident.observed) },
        rollback: { ...(configuredWorkerScript ? { workerScript: configuredWorkerScript } : {}), action: "resume" }, actor: actor.actor, createdAt: now,
      };
      await env.DB.prepare(
        `INSERT INTO actions(id,incident_id,idempotency_key,account_id,family,asset_id,kind,state,reason,observed_json,rollback_json,actor,created_at,updated_at)
         VALUES(?1,?2,?1,?3,?4,?5,?6,'prepared',?7,?8,?9,?10,?11,?11)`,
      ).bind(id, body.incidentId, asset.accountId, asset.family, asset.id, action.kind, action.reason, JSON.stringify(action.observed), JSON.stringify(action.rollback), actor.actor, now).run();
      await audit(env.DB, actor.actor, "action.prepare", id, action);
      if (!body.execute) return Response.json({ ok: true, action }, { status: 201 });
      return runAction(env, action, { workerScript: configuredWorkerScript }, "quarantine");
    }

    const actionMatch = url.pathname.match(/^\/api\/actions\/([^/]+)\/(execute|resume)$/);
    if (actionMatch && request.method === "POST") {
      const id = actionMatch[1]!;
      const row = await env.DB.prepare(`SELECT * FROM actions WHERE id=?1 LIMIT 1`).bind(id).first<Record<string, unknown>>();
      if (!row) return Response.json({ error: "Action not found" }, { status: 404 });
      const rollback = JSON.parse(String(row.rollback_json)) as { workerScript?: string };
      const assetRow = await env.DB.prepare(`SELECT * FROM assets WHERE account_id=?1 AND family=?2 AND asset_id=?3 LIMIT 1`).bind(row.account_id, row.family, row.asset_id).first<Record<string, unknown>>();
      const action: ControlAction = {
        id: String(row.id), incidentId: String(row.incident_id), asset: await assetFromRows(env, row, assetRow), kind: row.kind as ControlAction["kind"],
        state: row.state as ControlAction["state"], reason: String(row.reason), observed: JSON.parse(String(row.observed_json)), rollback,
        actor: actor.actor, createdAt: Number(row.created_at),
      };
      if (action.kind === "disable_trigger") return Response.json({ error: "Legacy route controls are retired and cannot be executed or restored by Brolly" }, { status: 409 });
      const workerScript = authoritativeWorkerScript(action.asset);
      if (row.kind === "runtime_quarantine" && !workerScript) return Response.json({ error: "An authoritative owning Worker and deployment fuse are required; legacy callback controls are retired" }, { status: 409 });
      if (rollback.workerScript && workerScript !== rollback.workerScript) return Response.json({ error: "The authoritative Worker mapping changed after this action was prepared; prepare a new action" }, { status: 409 });
      return runAction(env, action, { workerScript }, actionMatch[2] === "resume" ? "resume" : "quarantine");
    }

    const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/([^/]+)$/);
    if (assetMatch && request.method === "PATCH") {
      const body = await request.json<{ tier: AssetRef["tier"]; tags?: Record<string, string | null>; name?: string }>();
      if (!["control_plane", "critical", "standard", "disposable", "unclassified"].includes(body.tier)) {
        return Response.json({ error: "Invalid asset tier" }, { status: 400 });
      }
      const family = decodeURIComponent(assetMatch[1]!);
      const id = decodeURIComponent(assetMatch[2]!);
      const current = await env.DB.prepare(`SELECT tier,metadata_json FROM assets WHERE account_id=?1 AND family=?2 AND asset_id=?3 LIMIT 1`).bind(env.BROLLY_ACCOUNT_ID, family, id).first<{ tier: AssetRef["tier"]; metadata_json: string }>();
      if (!current) return Response.json({ error: "Asset not found" }, { status: 404 });
      if (current.tier === "control_plane" && body.tier !== "control_plane") return Response.json({ error: "Control-plane protection is immutable" }, { status: 409 });
      if (isBrollyWorker(env, family, id) && body.tier !== "control_plane") return Response.json({ error: "Brolly cannot remove protection from its own Worker" }, { status: 409 });
      if (body.tags && (Object.hasOwn(body.tags, "workerScript") || Object.hasOwn(body.tags, "cloudflareWorkerScript"))) return Response.json({ error: "Worker ownership is discovered from Cloudflare and cannot be overridden" }, { status: 400 });
      const now = Date.now();
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE assets SET tier=?4,metadata_json=json_patch(metadata_json,?5),
             name=COALESCE(?6,name),seen_at=?7
           WHERE account_id=?1 AND family=?2 AND asset_id=?3`,
        ).bind(env.BROLLY_ACCOUNT_ID, family, id, body.tier, JSON.stringify(body.tags ?? {}), body.name ?? null, now),
        env.DB.prepare(
          `UPDATE resources SET tier=?4,metadata_json=json_patch(metadata_json,?5),
             display_name=COALESCE(?6,display_name),last_seen_at=MAX(last_seen_at,?7)
           WHERE account_id=?1 AND product_family=?2 AND cloudflare_id=?3
             AND resource_type NOT IN ('account','product')`,
        ).bind(env.BROLLY_ACCOUNT_ID, family, id, body.tier, JSON.stringify(body.tags ?? {}), body.name ?? null, now),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) return Response.json({ error: "Asset not found" }, { status: 404 });
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

async function runAction(env: Env, action: ControlAction, control: { workerScript?: string }, requested: "quarantine" | "resume"): Promise<Response> {
  if (requested === "quarantine") {
    const incident = await env.DB.prepare(`SELECT severity,status,last_seen FROM incidents WHERE id=?1 LIMIT 1`)
      .bind(action.incidentId).first<Record<string, unknown>>();
    if (incident) {
      const incidentError = executableIncidentError(incident);
      if (incidentError) return Response.json({ error: incidentError }, { status: 409 });
    } else {
      const alertInstance = await env.DB.prepare(
        `SELECT status,historical,period_end_at,last_breached_at,data_quality
         FROM alert_instances WHERE id=?1 LIMIT 1`,
      ).bind(action.incidentId).first<Record<string, unknown>>();
      const alertError = executableAlertInstanceError(alertInstance);
      if (alertError) return Response.json({ error: alertError }, { status: 409 });
    }
    if (["control_plane", "critical", "unclassified"].includes(action.asset.tier)) {
      return Response.json({ error: `Asset is now protected as ${action.asset.tier}; prepare a new action after reviewing its classification` }, { status: 409 });
    }
  }
  const expectedState = requested === "resume" ? "succeeded" : "prepared or failed";
  const claimed = requested === "resume"
    ? await env.DB.prepare(`UPDATE actions SET state='running',error=NULL,updated_at=?3 WHERE id=?1 AND state=?2`).bind(action.id, "succeeded", Date.now()).run()
    : await env.DB.prepare(`UPDATE actions SET state='running',error=NULL,updated_at=?2 WHERE id=?1 AND state IN ('prepared','failed')`).bind(action.id, Date.now()).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) {
    return Response.json({ error: `Action is ${action.state}; ${requested} requires ${expectedState}` }, { status: 409 });
  }
  await audit(env.DB, action.actor, `action.${requested}.start`, action.id, { ...control, kind: action.kind });
  try {
    let detail = JSON.stringify({ ok: true });
    if (action.kind === "runtime_quarantine") {
      if (!control.workerScript) throw new Error("A deployment-fuse Worker mapping is required");
      detail = JSON.stringify(await executeDeploymentFuseControl(env, action, control.workerScript, requested));
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
    await audit(env.DB, action.actor, `action.${requested}.succeeded`, action.id, { response: detail.slice(0, 4000) });
    return new Response(detail, { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(`UPDATE actions SET state=?2,error=?3,updated_at=?4 WHERE id=?1`).bind(action.id, requested === "resume" ? "succeeded" : "failed", message.slice(0, 2000), Date.now()).run();
    await audit(env.DB, action.actor, `action.${requested}.failed`, action.id, { error: message.slice(0, 2000) });
    return Response.json({ error: message, actionId: action.id }, { status: 502 });
  }
}

const ACTION_INCIDENT_MAX_AGE_MS = 30 * 60_000;

export function executableIncidentError(incident: Record<string, unknown> | null): string | null {
  if (!incident) return "The source incident no longer exists; no control was applied";
  if (String(incident.severity) !== "emergency") return "Only an active emergency incident can authorize a shutdown action";
  if (!["open", "acknowledged"].includes(String(incident.status))) return "The source incident is resolved; no control was applied";
  const lastSeen = Number(incident.last_seen);
  if (!Number.isFinite(lastSeen) || lastSeen < Date.now() - ACTION_INCIDENT_MAX_AGE_MS) {
    return "The source incident is stale; run a fresh scan and prepare a new action";
  }
  return null;
}

export function executableAlertInstanceError(instance: Record<string, unknown> | null, now = Date.now()): string | null {
  if (!instance) return "The source alert instance no longer exists; no control was applied";
  if (!["open", "acknowledged"].includes(String(instance.status)) || Number(instance.historical) === 1 || Number(instance.period_end_at) <= now) {
    return "The source alert instance is inactive; no control was applied";
  }
  if (["missing", "stale"].includes(String(instance.data_quality))) {
    return "The source alert evidence is unavailable or stale; run a fresh scan before applying control";
  }
  const lastBreachedAt = Number(instance.last_breached_at);
  if (!Number.isFinite(lastBreachedAt) || lastBreachedAt < now - ACTION_INCIDENT_MAX_AGE_MS) {
    return "The source alert evidence is stale; run a fresh scan before applying control";
  }
  return null;
}

async function assetFromRows(env: Env, primary: Record<string, unknown>, asset: Record<string, unknown> | null): Promise<AssetRef> {
  const current = await env.DB.prepare(
    `SELECT r.*,p.cloudflare_id AS parent_cloudflare_id,p.tier AS parent_tier,
       p.metadata_json AS parent_metadata_json
     FROM resources r LEFT JOIN resources p ON p.id=r.parent_resource_id
     WHERE r.account_id=?1 AND r.product_family=?2 AND r.cloudflare_id=?3
       AND (r.resource_type LIKE '%:resource' OR r.resource_type LIKE '%:object')
     ORDER BY CASE WHEN r.resource_type LIKE '%:object' THEN 0 ELSE 1 END LIMIT 1`,
  ).bind(String(primary.account_id), String(primary.family), String(primary.asset_id)).first<Record<string, unknown>>();
  if (current) return assetFromResourceRow(current);
  let tags: Record<string, string> = {};
  try { tags = JSON.parse(String(asset?.metadata_json ?? "{}")) as Record<string, string>; } catch { /* optional metadata */ }
  let parentTier: AssetRef["tier"] | undefined;
  if (asset?.parent_id != null && String(primary.family) === "durable_objects") {
    const parent = await env.DB.prepare(`SELECT tier,metadata_json FROM assets WHERE account_id=?1 AND family='durable_objects' AND asset_id=?2 LIMIT 1`)
      .bind(String(primary.account_id), String(asset.parent_id)).first<{ tier: AssetRef["tier"]; metadata_json: string }>();
    if (parent) {
      let parentTags: Record<string, string> = {};
      try { parentTags = JSON.parse(parent.metadata_json || "{}") as Record<string, string>; } catch { /* optional metadata */ }
      tags = { ...parentTags, ...tags };
      parentTier = parent.tier;
    }
  }
  const directTier = (asset?.tier ?? "unclassified") as AssetRef["tier"];
  return {
    accountId: String(primary.account_id), family: String(primary.family), id: String(primary.asset_id),
    parentId: asset?.parent_id == null ? undefined : String(asset.parent_id), name: asset?.name == null ? undefined : String(asset.name),
    scope: (asset?.scope ?? (primary.family === "durable_objects" ? "object" : "resource")) as AssetRef["scope"],
    tier: directTier !== "unclassified" ? directTier : parentTier ?? directTier, tags,
  };
}

function assetFromResourceRow(row: Record<string, unknown>): AssetRef {
  const directTags = parseStringRecord(row.metadata_json);
  const parentTags = parseStringRecord(row.parent_metadata_json);
  const directTier = String(row.tier) as AssetRef["tier"];
  const parentTier = row.parent_tier == null ? undefined : String(row.parent_tier) as AssetRef["tier"];
  const suffix = String(row.resource_type).split(":").at(-1);
  return {
    accountId: String(row.account_id), family: String(row.product_family), id: String(row.cloudflare_id),
    parentId: row.parent_cloudflare_id == null ? undefined : String(row.parent_cloudflare_id),
    name: row.display_name == null ? undefined : String(row.display_name),
    scope: suffix === "object" || suffix === "namespace" || suffix === "resource" || suffix === "zone" || suffix === "account"
      ? suffix : "resource",
    tier: directTier !== "unclassified" ? directTier : parentTier ?? directTier,
    tags: { ...parentTags, ...directTags },
  };
}

function parseStringRecord(value: unknown): Record<string, string> {
  try {
    const parsed = JSON.parse(String(value ?? "{}")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

function authoritativeWorkerScript(asset: AssetRef): string | undefined {
  if (asset.family === "workers" && asset.scope === "resource") return asset.id;
  if (asset.family === "durable_objects" && asset.scope === "object") return asset.tags?.cloudflareWorkerScript;
  return undefined;
}

function isBrollyWorker(env: Env, family: string, id: string): boolean {
  if (family !== "workers") return false;
  return id === (env.BROLLY_SELF_WORKER_NAME ?? "brolly-guard") || id === "brolly-guard" || id.startsWith("brolly-guard-");
}

function prepareRuntimeIntegrationUpdates(
  env: Env,
  assets: RuntimeAssetRow[],
  integrations: RuntimeIntegrationInput[],
  now: number,
): { statements: D1PreparedStatement[] } | { error: string; status: number } {
  const knownAssets = new Map(assets.map(asset => [`${asset.family}:${asset.asset_id}`, asset]));
  const statements: D1PreparedStatement[] = [];
  for (const integration of integrations) {
    const asset = knownAssets.get(`${integration.family}:${integration.id}`);
    if (!asset) return { error: `Unknown runtime integration target ${integration.family}/${integration.id}`, status: 400 };
    const workerScript = integration.workerScript?.trim();
    if (workerScript && !/^[A-Za-z0-9_-]+$/.test(workerScript)) return { error: `Invalid Worker script name for ${integration.id}`, status: 400 };
    let tags: Record<string, string>;
    try { tags = JSON.parse(asset.metadata_json || "{}") as Record<string, string>; } catch { tags = {}; }
    const discoveredWorker = integration.family === "workers" ? integration.id : tags.cloudflareWorkerScript;
    if (workerScript && discoveredWorker && workerScript !== discoveredWorker) {
      return { error: `Cloudflare maps ${integration.id} to ${discoveredWorker}, not ${workerScript}`, status: 409 };
    }
    delete tags.workerScript;
    if (integration.installed && discoveredWorker) tags.brollyFuse = "true";
    else delete tags.brollyFuse;
    statements.push(env.DB.prepare(`UPDATE assets SET metadata_json=?3,seen_at=?4 WHERE family=?1 AND asset_id=?2 AND account_id=?5`)
      .bind(integration.family, integration.id, JSON.stringify(tags), now, env.BROLLY_ACCOUNT_ID));
  }
  return { statements };
}

async function audit(db: D1Database, actor: string, action: string, target: string, detail: unknown): Promise<void> {
  await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
}

export function validPolicy(policy: Policy, requireEveryFamily = false, levelIds: string[] = ["warning", "critical", "emergency"]): boolean {
  const finiteNonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const validSpend = (spend: Record<string, number> | undefined) => Boolean(spend)
    && levelIds.every(levelId => finiteNonnegative(spend?.[levelId]))
    && levelIds.every((levelId, index) => index === 0 || spend![levelIds[index - 1]!]! <= spend![levelId]!);
  if (typeof policy?.version !== "string" || !policy.version || !Array.isArray(policy.thresholds) || !levelIds.length) return false;
  if (!validSpend(policy.accountDailySpend)) return false;
  const familySpend = policy.familyDailySpend ?? {};
  if (requireEveryFamily && METRIC_CATALOG.some(definition => !familySpend[definition.family])) return false;
  if (Object.values(familySpend).some(limit => !validSpend(limit))) return false;
  if (Object.values(policy.assetDailySpend ?? {}).some(limit => !validSpend(limit))) return false;
  if (policy.riskTolerance) {
    const tolerance = policy.riskTolerance;
    if (!["conservative", "balanced", "growth", "custom"].includes(tolerance.preset)) return false;
    if (!tolerance.percentOfTypical || !levelIds.every(levelId => {
      const value = tolerance.percentOfTypical[levelId];
      return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 10_000;
    })) return false;
    if (!levelIds.every((levelId, index) => index === 0 || tolerance.percentOfTypical[levelIds[index - 1]!]! < tolerance.percentOfTypical[levelId]!)) return false;
    if (!tolerance.baseline || !finiteNonnegative(tolerance.baseline.computedAt)
      || !finiteNonnegative(tolerance.baseline.windowDays) || tolerance.baseline.windowDays <= 0) return false;
  }
  if (policy.limits) {
    if (!policy.limits.day || !policy.limits.cycle) return false;
    const validOptionalSpend = (spend: Record<string, number> | undefined) => !spend || Object.keys(spend).length === 0 || validSpend(spend);
    const validBooleanMap = (values: Record<string, boolean> | undefined) => !values || Object.values(values).every(value => typeof value === "boolean");
    for (const scopes of [policy.limits.day, policy.limits.cycle]) {
      if (!scopes || typeof scopes !== "object") return false;
      for (const scope of Object.values(scopes)) {
        if (!scope || !validOptionalSpend(scope.cost) || !scope.usage || Object.values(scope.usage).some(value => !validOptionalSpend(value))) return false;
        if (scope.costEnabled !== undefined && typeof scope.costEnabled !== "boolean") return false;
        if (scope.enabled !== undefined && typeof scope.enabled !== "boolean") return false;
        if (!validBooleanMap(scope.usageEnabled) || !validBooleanMap(scope.costLevelEnabled)) return false;
        if (scope.usageLevelEnabled && Object.values(scope.usageLevelEnabled).some(value => !validBooleanMap(value))) return false;
      }
    }
  }
  return policy.thresholds.every(threshold => typeof threshold.metric === "string" && !!threshold.metric
    && finiteNonnegative(threshold.windowMs) && threshold.windowMs > 0
    && [threshold.warning, threshold.critical, threshold.emergency, threshold.minimumBaselineSamples, threshold.anomalyMultiplier]
      .every(value => value === undefined || finiteNonnegative(value))
    && (threshold.warning === undefined || threshold.critical === undefined || threshold.warning <= threshold.critical)
    && (threshold.critical === undefined || threshold.emergency === undefined || threshold.critical <= threshold.emergency)
    && (threshold.warning === undefined || threshold.emergency === undefined || threshold.warning <= threshold.emergency));
}

export { validateNotificationConfig, validateProviderConfig } from "./notification-api.js";
