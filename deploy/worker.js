//#region ../../packages/core/dist/budget.js
var MonitoringBudgetExceededError = class extends Error {
	kind;
	constructor(kind, message) {
		super(message);
		this.name = "MonitoringBudgetExceededError";
		this.kind = kind;
	}
};
var DEFAULT_RUN_LIMITS = {
	apiCalls: 150,
	databaseRows: 25e3,
	samples: 2e4,
	wallMs: 45e3
};
var RunBudget = class {
	limits;
	signal;
	usage = {
		apiCalls: 0,
		databaseRows: 0,
		samples: 0,
		wallMs: 0
	};
	startedAt = Date.now();
	controller = new AbortController();
	constructor(limits = DEFAULT_RUN_LIMITS) {
		this.limits = limits;
		this.signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(limits.wallMs)]);
	}
	charge(kind, amount = 1) {
		if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`Invalid ${kind} charge`);
		this.checkpoint();
		this.usage[kind] += amount;
		if (this.usage[kind] > this.limits[kind]) this.trip(kind);
	}
	remaining(kind) {
		if (kind === "wallMs") return Math.max(0, this.limits.wallMs - (Date.now() - this.startedAt));
		return Math.max(0, this.limits[kind] - this.usage[kind]);
	}
	checkpoint() {
		this.usage.wallMs = Date.now() - this.startedAt;
		if (this.usage.wallMs > this.limits.wallMs) this.trip("wallMs");
		if (this.signal.aborted) throw new MonitoringBudgetExceededError("wallMs", "Monitoring run aborted");
	}
	trip(kind) {
		this.controller.abort(`${kind} budget exceeded`);
		throw new MonitoringBudgetExceededError(kind, `Monitoring ${kind} budget exceeded (${this.usage[kind]}/${this.limits[kind]})`);
	}
};
//#endregion
//#region ../../packages/core/dist/catalog.js
var METRIC_CATALOG = [
	{
		family: "workers",
		metrics: [
			"requests",
			"cpu_ms",
			"cache_requests"
		],
		preferredScope: "resource",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "durable_objects",
		metrics: [
			"requests",
			"duration_gb_seconds",
			"incoming_websocket_messages",
			"rows_read",
			"rows_written",
			"kv_read_units",
			"kv_write_units",
			"kv_delete_requests",
			"sql_storage_bytes",
			"kv_storage_bytes"
		],
		preferredScope: "object",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "workers_ai",
		metrics: ["neurons", "requests"],
		preferredScope: "resource",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "queues",
		metrics: [
			"operations",
			"messages",
			"bytes"
		],
		preferredScope: "resource",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "d1",
		metrics: [
			"rows_read",
			"rows_written",
			"storage_bytes"
		],
		preferredScope: "resource",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "r2",
		metrics: [
			"class_a",
			"class_b",
			"storage_bytes",
			"egress_bytes"
		],
		preferredScope: "resource",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "kv",
		metrics: [
			"reads",
			"writes",
			"deletes",
			"lists",
			"storage_bytes"
		],
		preferredScope: "namespace",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "pages",
		metrics: ["requests", "builds"],
		preferredScope: "resource",
		fastSource: "rest",
		billingSource: true
	},
	{
		family: "images",
		metrics: [
			"transformations",
			"stored_images",
			"delivery"
		],
		preferredScope: "account",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "stream",
		metrics: ["minutes_stored", "minutes_delivered"],
		preferredScope: "account",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "vectorize",
		metrics: ["queried_dimensions", "stored_dimensions"],
		preferredScope: "resource",
		fastSource: "rest",
		billingSource: true
	},
	{
		family: "hyperdrive",
		metrics: ["database_queries"],
		preferredScope: "resource",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "ai_gateway",
		metrics: [
			"requests",
			"tokens",
			"cost_usd"
		],
		preferredScope: "resource",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "zones",
		metrics: ["requests", "bandwidth_bytes"],
		preferredScope: "zone",
		fastSource: "graphql",
		billingSource: true
	}
];
//#endregion
//#region ../../packages/core/dist/policy.js
var DEFAULT_FAMILY_DAILY_SPEND = Object.fromEntries([
	"workers",
	"durable_objects",
	"workers_ai",
	"queues",
	"d1",
	"r2",
	"kv",
	"pages",
	"images",
	"stream",
	"vectorize",
	"hyperdrive",
	"ai_gateway",
	"zones"
].map((family) => [family, {
	warning: 1,
	critical: 5,
	emergency: 10
}]));
var DEFAULT_POLICY = {
	version: "2026-08-09.1",
	mode: "approval",
	accountDailySpend: {
		warning: 5,
		critical: 12.5,
		emergency: 25
	},
	familyDailySpend: DEFAULT_FAMILY_DAILY_SPEND,
	assetDailySpend: {},
	thresholds: [
		{
			metric: "rows_read",
			windowMs: 3e5,
			warning: 1e6,
			critical: 25e5,
			emergency: 5e6,
			minimumBaselineSamples: 12,
			anomalyMultiplier: 8
		},
		{
			metric: "rows_written",
			windowMs: 3e5,
			warning: 5e3,
			critical: 12500,
			emergency: 25e3,
			minimumBaselineSamples: 12,
			anomalyMultiplier: 8
		},
		{
			metric: "rows_read",
			windowMs: 864e5,
			emergency: 1e8
		},
		{
			metric: "rows_written",
			windowMs: 864e5,
			emergency: 5e5
		},
		{
			metric: "projected_daily_cost_usd",
			windowMs: 864e5,
			warning: .5,
			critical: 2,
			emergency: 5,
			minimumBaselineSamples: 12,
			anomalyMultiplier: 6
		}
	]
};
function robustExpected(values) {
	if (values.length === 0) return void 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle];
}
function evaluateSample(sample, threshold, baseline, policy) {
	const absolute = absoluteSeverity(sample.value, threshold);
	const expected = baseline.length >= (threshold.minimumBaselineSamples ?? Number.POSITIVE_INFINITY) ? robustExpected(baseline) : void 0;
	const anomalous = expected !== void 0 && expected > 0 && sample.value >= expected * (threshold.anomalyMultiplier ?? 8);
	const severity = absolute ?? (anomalous ? "warning" : null);
	if (!severity) return null;
	const action = sample.metric === "projected_daily_cost_usd" || sample.source === "billing" || sample.metric.endsWith("_cost_usd") ? policy.mode === "observe" ? "notify" : "prepare_stop" : controlAction(sample.asset, severity, policy);
	return {
		key: [
			sample.asset.accountId,
			sample.asset.family,
			sample.asset.id,
			sample.metric,
			threshold.windowMs
		].join(":"),
		asset: sample.asset,
		metric: sample.metric,
		severity,
		observed: sample.value,
		threshold: thresholdForSeverity(threshold, severity),
		expected,
		reason: anomalous && !absolute ? `${sample.metric} is ${formatMultiple(sample.value, expected)} above its robust baseline` : `${sample.metric} crossed the ${severity} hard threshold`,
		action
	};
}
function evaluateProjectedDailySpend(asset, usd, policy) {
	const threshold = {
		metric: "projected_daily_cost_usd",
		windowMs: 864e5,
		...scopedSpendLimits(asset, policy) ?? policy.familyDailySpend?.[asset.family] ?? policy.accountDailySpend
	};
	const severity = absoluteSeverity(usd, threshold);
	if (!severity) return null;
	return {
		key: `${asset.accountId}:${asset.family}:${asset.scope}:${asset.id}:projected_daily_cost_usd`,
		asset,
		metric: threshold.metric,
		severity,
		observed: usd,
		threshold: thresholdForSeverity(threshold, severity),
		reason: `Projected ${asset.family === "account" ? "monitored account" : asset.family} spend crossed the ${severity} threshold`,
		action: policy.mode === "observe" ? "notify" : "prepare_stop"
	};
}
function assetBudgetKey(asset) {
	return `${asset.family}:${asset.scope}:${asset.id}`;
}
function scopedSpendLimits(asset, policy) {
	const direct = policy.assetDailySpend?.[assetBudgetKey(asset)];
	if (direct) return direct;
	if (asset.family === "durable_objects" && asset.scope === "object" && asset.parentId) return policy.assetDailySpend?.[assetBudgetKey({
		family: asset.family,
		scope: "namespace",
		id: asset.parentId
	})];
}
function absoluteSeverity(value, threshold) {
	if (threshold.emergency !== void 0 && value >= threshold.emergency) return "emergency";
	if (threshold.critical !== void 0 && value >= threshold.critical) return "critical";
	if (threshold.warning !== void 0 && value >= threshold.warning) return "warning";
	return null;
}
function thresholdForSeverity(threshold, severity) {
	return severity === "emergency" ? threshold.emergency : severity === "critical" ? threshold.critical : threshold.warning;
}
function controlAction(asset, severity, policy) {
	if (asset.tier === "control_plane" || asset.tier === "critical" || asset.tier === "unclassified") return "notify";
	if (severity !== "emergency") return "notify";
	return policy.mode === "automatic" ? "stop" : policy.mode === "approval" ? "prepare_stop" : "notify";
}
function formatMultiple(value, expected) {
	const multiple = expected === 0 ? Number.POSITIVE_INFINITY : value / expected;
	return Number.isFinite(multiple) ? `${multiple.toFixed(1)}x` : "infinitely";
}
//#endregion
//#region ../../packages/core/dist/incidents.js
function upsertIncident(existing, evaluation, now = Date.now()) {
	if (!existing) return {
		...evaluation,
		id: crypto.randomUUID(),
		firstSeen: now,
		lastSeen: now,
		occurrences: 1,
		status: "open"
	};
	return {
		...existing,
		...evaluation,
		id: existing.id,
		firstSeen: existing.firstSeen,
		lastSeen: now,
		occurrences: existing.occurrences + 1,
		status: existing.status === "resolved" ? "open" : existing.status
	};
}
//#endregion
//#region ../../packages/notifiers/dist/index.js
async function notify(target, incident, fetcher = fetch) {
	if (!target.enabled) return {
		targetId: target.id,
		ok: true
	};
	try {
		const request = buildRequest(target, incident);
		const response = await fetcher(request.url, request.init);
		return response.ok ? {
			targetId: target.id,
			ok: true,
			status: response.status
		} : {
			targetId: target.id,
			ok: false,
			status: response.status,
			error: await response.text()
		};
	} catch (error) {
		return {
			targetId: target.id,
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
function buildRequest(target, incident) {
	const summary = `[Brolly ${incident.severity.toUpperCase()}] ${incident.asset.family}/${incident.asset.name ?? incident.asset.id}: ${incident.reason}. Observed ${incident.observed.toLocaleString()} ${incident.metric}.`;
	const json = (body, headers = {}) => ({
		method: "POST",
		headers: {
			"content-type": "application/json",
			...headers
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(1e4)
	});
	switch (target.kind) {
		case "discord": return {
			url: required(target.url, "Discord webhook URL"),
			init: json({ content: summary })
		};
		case "slack": return {
			url: required(target.url, "Slack webhook URL"),
			init: json({ text: summary })
		};
		case "webhook": return {
			url: required(target.url, "Webhook URL"),
			init: json({
				type: "brolly.incident",
				incident
			}, target.token ? { authorization: `Bearer ${target.token}` } : {})
		};
		case "resend": return {
			url: "https://api.resend.com/emails",
			init: json({
				from: required(target.from, "Resend from"),
				to: [required(target.to, "Resend to")],
				subject: summary.slice(0, 150),
				text: summary
			}, { authorization: `Bearer ${required(target.token, "Resend token")}` })
		};
		case "postmark": return {
			url: "https://api.postmarkapp.com/email",
			init: json({
				From: required(target.from, "Postmark from"),
				To: required(target.to, "Postmark to"),
				Subject: summary.slice(0, 150),
				TextBody: summary
			}, { "x-postmark-server-token": required(target.token, "Postmark token") })
		};
		case "twilio": {
			const sid = required(target.accountSid, "Twilio account SID");
			const form = new URLSearchParams({
				From: required(target.from, "Twilio from"),
				To: required(target.to, "Twilio to"),
				Body: summary
			});
			return {
				url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
				init: {
					method: "POST",
					headers: {
						authorization: `Basic ${btoa(`${sid}:${required(target.token, "Twilio auth token")}`)}`,
						"content-type": "application/x-www-form-urlencoded"
					},
					body: form,
					signal: AbortSignal.timeout(1e4)
				}
			};
		}
	}
}
function required(value, label) {
	if (!value) throw new Error(`${label} is required`);
	return value;
}
//#endregion
//#region src/oauth-config.ts
var BROLLY_PUBLIC_OAUTH_CLIENT_ID = "5690968d2377c6200202668946420dec";
var BROLLY_PUBLIC_OAUTH_REDIRECT_URI = "https://brolly-login.standardagents.ai/oauth/callback";
function oauthClientId(env) {
	const configured = env.BROLLY_OAUTH_CLIENT_ID?.trim();
	return configured && !configured.startsWith("REPLACE_") ? configured : BROLLY_PUBLIC_OAUTH_CLIENT_ID;
}
function oauthRedirectUri(env) {
	const configured = env.BROLLY_OAUTH_REDIRECT_URI?.trim();
	return configured && !configured.startsWith("REPLACE_") ? configured : BROLLY_PUBLIC_OAUTH_REDIRECT_URI;
}
//#endregion
//#region src/credentials.ts
async function operationalToken(env) {
	if (!env.BROLLY_CREDENTIAL_KEY) return fallbackToken(env);
	const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='oauth_credentials' LIMIT 1`).first();
	if (!row) return fallbackToken(env);
	const stored = await openJson(row.value, env.BROLLY_CREDENTIAL_KEY);
	if (!stored.expiresAt || stored.expiresAt - Date.now() > 3e5) return stored.accessToken;
	if (!stored.refreshToken) throw new Error("Cloudflare OAuth expired and cannot be refreshed; reconnect Cloudflare from Brolly");
	const holder = crypto.randomUUID();
	const now = Date.now();
	const lease = await env.DB.prepare(`INSERT INTO cron_lease(name,holder,expires_at) VALUES('oauth-refresh',?1,?2)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?3`).bind(holder, now + 3e4, now).run();
	if (Number(lease.meta.changes ?? 0) !== 1) throw new Error("Cloudflare OAuth refresh is already in progress; retry shortly");
	try {
		const currentRow = await env.DB.prepare(`SELECT value FROM settings WHERE key='oauth_credentials' LIMIT 1`).first();
		if (!currentRow) return fallbackToken(env);
		const current = await openJson(currentRow.value, env.BROLLY_CREDENTIAL_KEY);
		if (!current.expiresAt || current.expiresAt - Date.now() > 3e5) return current.accessToken;
		if (!current.refreshToken) throw new Error("Cloudflare OAuth expired and cannot be refreshed; reconnect Cloudflare from Brolly");
		const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: oauthClientId(env),
				refresh_token: current.refreshToken
			}),
			signal: AbortSignal.timeout(1e4)
		});
		if (!response.ok) throw new Error(`Cloudflare OAuth refresh failed (${response.status}); reconnect Cloudflare from Brolly`);
		const payload = await response.json();
		const refreshed = {
			accessToken: payload.access_token,
			refreshToken: payload.refresh_token ?? current.refreshToken,
			expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1e3 : void 0
		};
		await env.DB.prepare(`UPDATE settings SET value=?1,updated_at=?2 WHERE key='oauth_credentials'`).bind(await sealJson(refreshed, env.BROLLY_CREDENTIAL_KEY), Date.now()).run();
		return refreshed.accessToken;
	} finally {
		await env.DB.prepare(`DELETE FROM cron_lease WHERE name='oauth-refresh' AND holder=?1`).bind(holder).run();
	}
}
async function configuredBillingToken(env) {
	if (env.CLOUDFLARE_BILLING_TOKEN) return env.CLOUDFLARE_BILLING_TOKEN;
	if (!env.BROLLY_CREDENTIAL_KEY) return void 0;
	const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='billing_credentials' LIMIT 1`).first();
	if (!row) return void 0;
	return (await openJson(row.value, env.BROLLY_CREDENTIAL_KEY)).token;
}
function fallbackToken(env) {
	if (!env.CLOUDFLARE_OAUTH_TOKEN) throw new Error("Connect this Brolly instance to Cloudflare before scanning or controlling resources");
	return env.CLOUDFLARE_OAUTH_TOKEN;
}
async function openJson(value, secret) {
	const envelope = JSON.parse(value);
	const key = await importKey(secret);
	const plaintext = await crypto.subtle.decrypt({
		name: "AES-GCM",
		iv: decode(envelope.iv)
	}, key, decode(envelope.ciphertext));
	return JSON.parse(new TextDecoder().decode(plaintext));
}
async function sealJson(value, secret) {
	const iv = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(12));
	const key = await importKey(secret);
	const ciphertext = await crypto.subtle.encrypt({
		name: "AES-GCM",
		iv
	}, key, new TextEncoder().encode(JSON.stringify(value)));
	return JSON.stringify({
		iv: encode(iv),
		ciphertext: encode(new Uint8Array(ciphertext))
	});
}
async function importKey(secret) {
	return crypto.subtle.importKey("raw", decode(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}
function decode(value) {
	const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
}
function encode(value) {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
//#endregion
//#region src/cloudflare.ts
var API$2 = "https://api.cloudflare.com/client/v4";
var REQUEST_TIMEOUT_MS = 8e3;
var CloudflareClient = class {
	env;
	budget;
	tokenPromise = null;
	constructor(env, budget) {
		this.env = env;
		this.budget = budget;
	}
	async inventory() {
		const endpoints = [
			[
				"workers",
				`/accounts/${this.env.BROLLY_ACCOUNT_ID}/workers/scripts`,
				"resource"
			],
			[
				"durable_objects",
				`/accounts/${this.env.BROLLY_ACCOUNT_ID}/workers/durable_objects/namespaces`,
				"namespace"
			],
			[
				"queues",
				`/accounts/${this.env.BROLLY_ACCOUNT_ID}/queues`,
				"resource"
			],
			[
				"d1",
				`/accounts/${this.env.BROLLY_ACCOUNT_ID}/d1/database`,
				"resource"
			],
			[
				"r2",
				`/accounts/${this.env.BROLLY_ACCOUNT_ID}/r2/buckets`,
				"resource"
			],
			[
				"kv",
				`/accounts/${this.env.BROLLY_ACCOUNT_ID}/storage/kv/namespaces`,
				"namespace"
			],
			[
				"vectorize",
				`/accounts/${this.env.BROLLY_ACCOUNT_ID}/vectorize/v2/indexes`,
				"resource"
			],
			[
				"hyperdrive",
				`/accounts/${this.env.BROLLY_ACCOUNT_ID}/hyperdrive/configs`,
				"resource"
			],
			[
				"pages",
				`/accounts/${this.env.BROLLY_ACCOUNT_ID}/pages/projects`,
				"resource"
			],
			[
				"ai_gateway",
				`/accounts/${this.env.BROLLY_ACCOUNT_ID}/ai-gateway/gateways`,
				"resource"
			],
			[
				"zones",
				`/zones?account.id=${encodeURIComponent(this.env.BROLLY_ACCOUNT_ID)}&per_page=50`,
				"zone"
			]
		];
		const results = await Promise.all(endpoints.map(async ([family, path, scope]) => {
			try {
				const listed = await this.listRows(path);
				const assets = [];
				for (const row of listed.rows) {
					const id = stringValue(row.id) ?? stringValue(row.uuid) ?? stringValue(row.queue_id) ?? stringValue(row.name) ?? stringValue(row.namespace_id);
					if (!id) continue;
					const name = stringValue(row.name) ?? stringValue(row.queue_name) ?? stringValue(row.title) ?? id;
					const tags = {};
					if (family === "durable_objects") {
						const workerScript = stringValue(row.script);
						const className = stringValue(row.class);
						if (workerScript) tags.cloudflareWorkerScript = workerScript;
						if (className) tags.durableObjectClass = className;
						if (typeof row.use_sqlite === "boolean") tags.durableObjectStorage = row.use_sqlite ? "SQLite" : "key-value";
					}
					if (family === "workers") {
						const etag = stringValue(row.etag);
						const modifiedOn = stringValue(row.modified_on);
						if (etag) tags.cloudflareEtag = etag;
						if (modifiedOn) tags.cloudflareModifiedOn = modifiedOn;
					}
					assets.push({
						accountId: this.env.BROLLY_ACCOUNT_ID,
						family,
						id,
						name,
						scope,
						tier: name === "brolly-guard" ? "control_plane" : "unclassified",
						tags
					});
				}
				return {
					assets,
					coverage: inventoryCoverage(family, scope, listed.truncated ? "delayed" : "healthy", listed.truncated ? "Inventory exceeded the bounded 10-page collector; discovered pages are retained" : void 0)
				};
			} catch (error) {
				return {
					assets: [],
					coverage: inventoryCoverage(family, scope, error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable", error instanceof Error ? error.message : String(error))
				};
			}
		}));
		return {
			assets: results.flatMap((result) => result.assets),
			coverage: results.map((result) => result.coverage)
		};
	}
	async durableObjectUsage(since, until) {
		const query = `query BrollyDurableObjects($account: String!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        byRowsRead: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_rowsRead_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { rowsRead rowsWritten }
        }
        byRowsWritten: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_rowsWritten_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { rowsRead rowsWritten }
        }
        byRequests: durableObjectsInvocationsAdaptiveGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { namespaceId objectId type }
          sum { requests }
        }
        byDuration: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_duration_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { duration }
        }
        byIncomingWebsocketMessages: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_inboundWebsocketMsgCount_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { inboundWebsocketMsgCount }
        }
        byStorageReadUnits: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_storageReadUnits_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { storageReadUnits }
        }
        byStorageWriteUnits: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_storageWriteUnits_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { storageWriteUnits }
        }
        byStorageDeletes: durableObjectsPeriodicGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [sum_storageDeletes_DESC]
        ) {
          dimensions { namespaceId objectId }
          sum { storageDeletes }
        }
        sqlStorage: durableObjectsSqlStorageGroups(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [max_storedBytes_DESC]
        ) {
          dimensions { namespaceId }
          max { storedBytes }
        }
        kvStorage: durableObjectsStorageGroups(
          limit: 1
          filter: { datetime_geq: $since, datetime_lt: $until }
          orderBy: [max_storedBytes_DESC]
        ) {
          max { storedBytes }
        }
      } }
    }`;
		try {
			this.budget.charge("apiCalls");
			const response = await fetch(`${API$2}/graphql`, {
				method: "POST",
				headers: authHeaders(await this.token()),
				body: JSON.stringify({
					query,
					variables: {
						account: this.env.BROLLY_ACCOUNT_ID,
						since: new Date(since).toISOString(),
						until: new Date(until).toISOString()
					}
				}),
				signal: this.budget.signal
			});
			if (!response.ok) throw await cloudflareApiError(response);
			const payload = await response.json();
			if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
			const account = payload.data?.viewer?.accounts?.[0];
			const truncated = [
				account?.byRequests ?? [],
				account?.byDuration ?? [],
				account?.byIncomingWebsocketMessages ?? [],
				account?.byRowsRead ?? [],
				account?.byRowsWritten ?? [],
				account?.byStorageReadUnits ?? [],
				account?.byStorageWriteUnits ?? [],
				account?.byStorageDeletes ?? []
			].some((list) => list.length >= 1e3);
			const operationDefinitions = [
				[
					account?.byDuration ?? [],
					"duration_gb_seconds",
					"gb_seconds",
					(group) => group.sum.duration
				],
				[
					account?.byIncomingWebsocketMessages ?? [],
					"incoming_websocket_messages",
					"count",
					(group) => group.sum.inboundWebsocketMsgCount
				],
				[
					account?.byRowsRead ?? [],
					"rows_read",
					"rows",
					(group) => group.sum.rowsRead
				],
				[
					account?.byRowsWritten ?? [],
					"rows_written",
					"rows",
					(group) => group.sum.rowsWritten
				],
				[
					account?.byStorageReadUnits ?? [],
					"kv_read_units",
					"count",
					(group) => group.sum.storageReadUnits
				],
				[
					account?.byStorageWriteUnits ?? [],
					"kv_write_units",
					"count",
					(group) => group.sum.storageWriteUnits
				],
				[
					account?.byStorageDeletes ?? [],
					"kv_delete_requests",
					"requests",
					(group) => group.sum.storageDeletes
				]
			];
			const operationSamples = /* @__PURE__ */ new Map();
			const addOperationSample = (asset, name, unit, value) => {
				const key = `${asset.parentId ?? ""}:${asset.id}:${name}`;
				const next = metric(asset, name, unit, value, since, until, truncated);
				const existing = operationSamples.get(key);
				if (!existing) {
					operationSamples.set(key, next);
					return;
				}
				existing.value += next.value;
				existing.estimatedCostUsd = (existing.estimatedCostUsd ?? 0) + (next.estimatedCostUsd ?? 0);
			};
			for (const group of account?.byRequests ?? []) {
				const value = group.sum.requests;
				if (value === void 0) continue;
				const asset = {
					accountId: this.env.BROLLY_ACCOUNT_ID,
					family: "durable_objects",
					id: group.dimensions.objectId,
					parentId: group.dimensions.namespaceId,
					scope: "object",
					tier: "unclassified"
				};
				const hibernatedWebsocketMessage = group.dimensions.type === "hibernation";
				addOperationSample(asset, hibernatedWebsocketMessage ? "incoming_websocket_messages" : "requests", hibernatedWebsocketMessage ? "count" : "requests", value);
			}
			for (const [groups, name, unit, read] of operationDefinitions) for (const group of groups) {
				const value = read(group);
				if (value === void 0) continue;
				addOperationSample({
					accountId: this.env.BROLLY_ACCOUNT_ID,
					family: "durable_objects",
					id: group.dimensions.objectId,
					parentId: group.dimensions.namespaceId,
					scope: "object",
					tier: "unclassified"
				}, name, unit, value);
			}
			const samples = [...operationSamples.values()];
			for (const group of account?.sqlStorage ?? []) {
				const value = group.max.storedBytes;
				if (value === void 0) continue;
				const asset = {
					accountId: this.env.BROLLY_ACCOUNT_ID,
					family: "durable_objects",
					id: group.dimensions.namespaceId,
					scope: "namespace",
					tier: "unclassified"
				};
				samples.push(metric(asset, "sql_storage_bytes", "bytes", value, since, until, truncated));
			}
			const kvStoredBytes = Math.max(0, ...(account?.kvStorage ?? []).map((group) => group.max.storedBytes ?? 0));
			if ((account?.kvStorage?.length ?? 0) > 0) {
				const asset = {
					accountId: this.env.BROLLY_ACCOUNT_ID,
					family: "durable_objects",
					id: "legacy-kv-storage",
					name: "Legacy key-value Durable Object storage",
					scope: "account",
					tier: "control_plane"
				};
				samples.push(metric(asset, "kv_storage_bytes", "bytes", kvStoredBytes, since, until, false));
			}
			this.budget.charge("samples", samples.length);
			return {
				samples,
				coverage: [
					...coverageForMetrics("durable_objects", [
						"requests",
						"duration_gb_seconds",
						"incoming_websocket_messages",
						"rows_read",
						"rows_written",
						"kv_read_units",
						"kv_write_units",
						"kv_delete_requests"
					], truncated ? "delayed" : "healthy", truncated ? "Per-metric top-1000 response was truncated; high consumers are included but the long tail is not enumerable" : void 0, "object"),
					...coverageForMetrics("durable_objects", ["sql_storage_bytes"], (account?.sqlStorage?.length ?? 0) >= 1e3 ? "delayed" : "healthy", void 0, "namespace"),
					...coverageForMetrics("durable_objects", ["kv_storage_bytes"], "healthy", void 0, "account")
				]
			};
		} catch (error) {
			const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
			const detail = error instanceof Error ? error.message : String(error);
			return {
				samples: [],
				coverage: [
					...coverageForMetrics("durable_objects", [
						"requests",
						"duration_gb_seconds",
						"incoming_websocket_messages",
						"rows_read",
						"rows_written",
						"kv_read_units",
						"kv_write_units",
						"kv_delete_requests"
					], state, detail, "object"),
					...coverageForMetrics("durable_objects", ["sql_storage_bytes"], state, detail, "namespace"),
					...coverageForMetrics("durable_objects", ["kv_storage_bytes"], state, detail, "account")
				]
			};
		}
	}
	async workerUsage(since, until) {
		const query = `query BrollyWorkers($account: String!, $since: Time!, $until: Time!) {
      viewer { accounts(filter: { accountTag: $account }) {
        byRequests: workersInvocationsAdaptive(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until, isPreview: 0 }
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { scriptName }
          sum { requests }
        }
        byCpu: workersInvocationsAdaptive(
          limit: 1000
          filter: { datetime_geq: $since, datetime_lt: $until, isPreview: 0 }
          orderBy: [sum_cpuTimeUs_DESC]
        ) {
          dimensions { scriptName }
          sum { cpuTimeUs }
        }
      } }
    }`;
		try {
			this.budget.charge("apiCalls");
			const response = await fetch(`${API$2}/graphql`, {
				method: "POST",
				headers: authHeaders(await this.token()),
				body: JSON.stringify({
					query,
					variables: {
						account: this.env.BROLLY_ACCOUNT_ID,
						since: new Date(since).toISOString(),
						until: new Date(until).toISOString()
					}
				}),
				signal: this.budget.signal
			});
			if (!response.ok) throw await cloudflareApiError(response);
			const payload = await response.json();
			if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
			const account = payload.data?.viewer?.accounts?.[0];
			const requestGroups = account?.byRequests ?? [];
			const cpuGroups = account?.byCpu ?? [];
			const truncated = requestGroups.length >= 1e3 || cpuGroups.length >= 1e3;
			const samples = [];
			for (const group of requestGroups) {
				if (group.sum.requests === void 0 || !group.dimensions.scriptName) continue;
				samples.push(workerMetric(this.env.BROLLY_ACCOUNT_ID, group.dimensions.scriptName, "requests", "requests", group.sum.requests, since, until, truncated));
			}
			for (const group of cpuGroups) {
				if (group.sum.cpuTimeUs === void 0 || !group.dimensions.scriptName) continue;
				samples.push(workerMetric(this.env.BROLLY_ACCOUNT_ID, group.dimensions.scriptName, "cpu_ms", "milliseconds", group.sum.cpuTimeUs / 1e3, since, until, truncated));
			}
			this.budget.charge("samples", samples.length);
			return {
				samples,
				coverage: [...coverageForMetrics("workers", ["requests", "cpu_ms"], truncated ? "delayed" : "healthy", truncated ? "Per-metric top-1000 response was truncated; highest-cost Workers are included" : void 0, "resource"), ...coverageForMetrics("workers", ["cache_requests"], "unavailable", "Brolly has the complete per-Worker data Cloudflare provides: requests and CPU time. Cloudflare reports cache charges only at the account level, so Brolly protects those costs with account and product limits instead of assigning them to individual Workers.", "resource")]
			};
		} catch (error) {
			return {
				samples: [],
				coverage: coverageForMetrics("workers", [
					"requests",
					"cpu_ms",
					"cache_requests"
				], error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable", error instanceof Error ? error.message : String(error), "resource")
			};
		}
	}
	async billingUsage(since, until) {
		const token = await configuredBillingToken(this.env);
		if (!token) return null;
		const date = (value) => new Date(value).toISOString().slice(0, 10);
		const params = new URLSearchParams({
			from: date(since),
			to: date(until)
		});
		return this.get(`/accounts/${this.env.BROLLY_ACCOUNT_ID}/billable/usage?${params}`, token);
	}
	async get(path, token) {
		return (await this.request(path, token)).result;
	}
	async listRows(path) {
		const rows = [];
		let page = 1;
		let totalPages = 1;
		let perPage;
		do {
			const pagePath = page === 1 ? path : withPage(path, page, perPage);
			const envelope = await this.request(pagePath);
			rows.push(...unwrapRows(envelope.result));
			totalPages = Math.max(1, envelope.result_info?.total_pages ?? 1);
			perPage ??= envelope.result_info?.per_page;
			page += 1;
		} while (page <= totalPages && page <= 10);
		return {
			rows,
			truncated: totalPages >= page
		};
	}
	async request(path, token) {
		this.budget.charge("apiCalls");
		const response = await fetch(`${API$2}${path}`, {
			headers: authHeaders(token ?? await this.token()),
			signal: AbortSignal.any([this.budget.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
		});
		if (!response.ok) throw await cloudflareApiError(response);
		const envelope = await response.json();
		if (!envelope.success) throw new Error(envelope.errors?.map((error) => error.message).join("; ") || "Cloudflare API error");
		return envelope;
	}
	token() {
		this.tokenPromise ??= operationalToken(this.env);
		return this.tokenPromise;
	}
};
var CloudflareApiError = class extends Error {
	status;
	code;
	constructor(status, message, code) {
		super(message);
		this.status = status;
		this.code = code;
	}
};
async function cloudflareApiError(response) {
	const raw = await response.text();
	try {
		const envelope = JSON.parse(raw);
		const first = envelope.errors?.[0];
		return new CloudflareApiError(response.status, first?.message ?? envelope.message ?? `Cloudflare API request failed (${response.status})`, first?.code);
	} catch {
		return new CloudflareApiError(response.status, raw || `Cloudflare API request failed (${response.status})`);
	}
}
function authHeaders(token) {
	return {
		authorization: `Bearer ${token}`,
		"content-type": "application/json"
	};
}
function stringValue(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function withPage(path, page, perPage) {
	const url = new URL(path, API$2);
	url.searchParams.set("page", String(page));
	if (perPage && !url.searchParams.has("per_page")) url.searchParams.set("per_page", String(perPage));
	return `${url.pathname}${url.search}`;
}
function unwrapRows(value) {
	if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
	if (!value || typeof value !== "object") return [];
	const object = value;
	for (const key of [
		"buckets",
		"queues",
		"result",
		"items"
	]) if (Array.isArray(object[key])) return object[key];
	return [];
}
function metric(asset, name, unit, value, start, end, sampled) {
	const unitPrice = name === "rows_read" ? .001 / 1e6 : name === "rows_written" ? 1 / 1e6 : name === "requests" ? .15 / 1e6 : name === "duration_gb_seconds" ? 12.5 / 1e6 : name === "incoming_websocket_messages" ? .15 / 1e6 / 20 : name === "kv_read_units" ? .2 / 1e6 : name === "kv_write_units" || name === "kv_delete_requests" ? 1 / 1e6 : 0;
	const storageCost = name === "sql_storage_bytes" || name === "kv_storage_bytes" ? value / 1e9 * .2 * ((end - start) / 2592e6) : 0;
	return {
		asset,
		metric: name,
		unit,
		value,
		start,
		end,
		source: "graphql",
		estimatedCostUsd: value * unitPrice + storageCost,
		sampled
	};
}
function workerMetric(accountId, scriptName, name, unit, value, start, end, sampled) {
	return {
		asset: {
			accountId,
			family: "workers",
			id: scriptName,
			name: scriptName,
			scope: "resource",
			tier: scriptName === "brolly-guard" ? "control_plane" : "unclassified"
		},
		metric: name,
		unit,
		value,
		start,
		end,
		source: "graphql",
		estimatedCostUsd: value * (name === "requests" ? .3 / 1e6 : .02 / 1e6),
		sampled
	};
}
function coverageForMetrics(family, metrics, state, detail, scope) {
	const definition = METRIC_CATALOG.find((item) => item.family === family);
	if (!definition) return [];
	return metrics.map((metric) => ({
		family,
		metric,
		finestScope: scope ?? definition.preferredScope,
		state,
		checkedAt: Date.now(),
		detail
	}));
}
function inventoryCoverage(family, scope, state, detail) {
	return {
		family,
		metric: "asset_inventory",
		finestScope: scope,
		state,
		checkedAt: Date.now(),
		detail
	};
}
//#endregion
//#region src/store.ts
var Store = class {
	db;
	chargeRows;
	constructor(db, chargeRows) {
		this.db = db;
		this.chargeRows = chargeRows;
	}
	async acquireLease(name, holder, ttlMs) {
		const now = Date.now();
		const result = await this.db.prepare(`INSERT INTO cron_lease(name, holder, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(name) DO UPDATE SET holder=excluded.holder, expires_at=excluded.expires_at
       WHERE cron_lease.expires_at < ?4 OR cron_lease.holder = ?2`).bind(name, holder, now + ttlMs, now).run();
		this.chargeMeta(result.meta);
		return (result.meta.changes ?? 0) > 0;
	}
	async loadPolicy() {
		const row = await this.db.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first();
		this.chargeRows(row ? 1 : 0);
		if (!row) return DEFAULT_POLICY;
		try {
			const policy = JSON.parse(row.value);
			return policy && [
				"observe",
				"approval",
				"automatic"
			].includes(policy.mode) && Array.isArray(policy.thresholds) ? policy : DEFAULT_POLICY;
		} catch {
			return DEFAULT_POLICY;
		}
	}
	async saveAssets(assets) {
		const now = Date.now();
		const statements = assets.map((asset) => this.db.prepare(`INSERT INTO assets(account_id,family,asset_id,parent_id,name,scope,tier,metadata_json,discovered_at,seen_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
         ON CONFLICT(account_id,family,asset_id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,scope=excluded.scope,
           tier=CASE WHEN excluded.tier='control_plane' THEN 'control_plane' ELSE assets.tier END,
           metadata_json=json_patch(assets.metadata_json,excluded.metadata_json),seen_at=excluded.seen_at
         WHERE (excluded.tier='control_plane' AND assets.tier!='control_plane')
            OR json_patch(assets.metadata_json,excluded.metadata_json) != assets.metadata_json
            OR assets.seen_at < excluded.seen_at - 3600000`).bind(asset.accountId, asset.family, asset.id, asset.parentId ?? null, asset.name ?? null, asset.scope, asset.tier, JSON.stringify(asset.tags ?? {}), now));
		await this.runBatches(statements);
	}
	async saveCoverage(items) {
		const statements = items.map((item) => this.db.prepare(`INSERT INTO metric_coverage(family,metric,finest_scope,state,detail,checked_at) VALUES(?1,?2,?3,?4,?5,?6)
         ON CONFLICT(family,metric) DO UPDATE SET finest_scope=excluded.finest_scope,state=excluded.state,detail=excluded.detail,checked_at=excluded.checked_at`).bind(item.family, item.metric, item.finestScope, item.state, item.detail ?? null, item.checkedAt));
		await this.runBatches(statements);
	}
	async saveSamples(samples) {
		const statements = samples.map((sample) => this.db.prepare(`INSERT OR IGNORE INTO metric_samples(account_id,family,asset_id,metric,unit,value,estimated_cost_usd,source,sampled,start_at,end_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`).bind(sample.asset.accountId, sample.asset.family, sample.asset.id, sample.metric, sample.unit, sample.value, sample.estimatedCostUsd ?? null, sample.source, sample.sampled ? 1 : 0, sample.start, sample.end));
		await this.runBatches(statements);
	}
	async baseline(sample, limit = 288) {
		const result = await this.db.prepare(`SELECT value FROM metric_samples WHERE account_id=?1 AND family=?2 AND asset_id=?3 AND metric=?4 AND end_at < ?5 ORDER BY end_at DESC LIMIT ?6`).bind(sample.asset.accountId, sample.asset.family, sample.asset.id, sample.metric, sample.end, limit).all();
		this.chargeMeta(result.meta);
		return result.results.map((row) => row.value);
	}
	async applyAssetPolicies(samples, family) {
		const result = await this.db.prepare(`SELECT asset_id,tier,name,metadata_json FROM assets WHERE account_id=?1 AND family=?2 LIMIT 5000`).bind(samples[0]?.asset.accountId ?? "", family).all();
		this.chargeMeta(result.meta);
		const policies = new Map(result.results.map((row) => [row.asset_id, row]));
		for (const sample of samples) {
			const direct = policies.get(sample.asset.id);
			const parent = sample.asset.parentId ? policies.get(sample.asset.parentId) : void 0;
			if (!direct && !parent) continue;
			const parentTags = parseTags$1(parent?.metadata_json);
			const directTags = parseTags$1(direct?.metadata_json);
			const tier = direct?.tier && direct.tier !== "unclassified" ? direct.tier : parent?.tier ?? direct?.tier ?? sample.asset.tier;
			sample.asset = {
				...sample.asset,
				tier,
				name: direct?.name ?? sample.asset.name,
				tags: {
					...parentTags,
					...directTags
				}
			};
		}
	}
	async claimDailySummary(day) {
		const result = await this.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('last_daily_summary',?1,?2)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
       WHERE settings.value != excluded.value`).bind(day, Date.now()).run();
		this.chargeMeta(result.meta);
		return (result.meta.changes ?? 0) > 0;
	}
	async recordEvaluation(evaluation) {
		const row = await this.db.prepare(`SELECT * FROM incidents WHERE incident_key=?1 LIMIT 1`).bind(evaluation.key).first();
		this.chargeRows(row ? 1 : 0);
		const previous = row ? fromIncidentRow(row, evaluation.asset) : void 0;
		const incident = upsertIncident(previous, evaluation);
		const lastNotifiedAt = row?.last_notified_at == null ? null : Number(row.last_notified_at);
		const notify = !previous || previous.severity !== incident.severity || lastNotifiedAt === null || incident.lastSeen - lastNotifiedAt >= 9e5;
		const written = await this.db.prepare(`INSERT INTO incidents(id,incident_key,account_id,family,asset_id,severity,metric,observed,threshold_value,expected,reason,proposed_action,status,first_seen,last_seen,occurrences,last_notified_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
       ON CONFLICT(incident_key) DO UPDATE SET severity=excluded.severity,observed=excluded.observed,threshold_value=excluded.threshold_value,expected=excluded.expected,reason=excluded.reason,proposed_action=excluded.proposed_action,status=excluded.status,last_seen=excluded.last_seen,occurrences=excluded.occurrences,last_notified_at=COALESCE(excluded.last_notified_at,incidents.last_notified_at)`).bind(incident.id, incident.key, incident.asset.accountId, incident.asset.family, incident.asset.id, incident.severity, incident.metric, incident.observed, incident.threshold ?? null, incident.expected ?? null, incident.reason, incident.action, incident.status, incident.firstSeen, incident.lastSeen, incident.occurrences, notify ? incident.lastSeen : null).run();
		this.chargeMeta(written.meta);
		return {
			previous,
			incident,
			notify
		};
	}
	async ensureRuntimeAction(incident) {
		const kind = incident.asset.family === "queues" ? "pause_consumer" : "runtime_quarantine";
		const idempotencyKey = `${incident.id}:${incident.severity}:${kind}`;
		const existing = await this.db.prepare(`SELECT * FROM actions WHERE idempotency_key=?1 LIMIT 1`).bind(idempotencyKey).first();
		this.chargeRows(existing ? 1 : 0);
		if (existing) return actionFromRow(existing, incident.asset);
		const id = crypto.randomUUID();
		const now = Date.now();
		const rollback = {
			workerScript: incident.asset.family === "workers" ? incident.asset.id : incident.asset.tags?.cloudflareWorkerScript,
			action: "resume"
		};
		const result = await this.db.prepare(`INSERT INTO actions(id,incident_id,idempotency_key,account_id,family,asset_id,kind,state,reason,observed_json,rollback_json,actor,created_at,updated_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,'prepared',?8,?9,?10,'brolly-policy',?11,?11)`).bind(id, incident.id, idempotencyKey, incident.asset.accountId, incident.asset.family, incident.asset.id, kind, incident.reason, JSON.stringify({ [incident.metric]: incident.observed }), JSON.stringify(rollback), now).run();
		this.chargeMeta(result.meta);
		await this.audit("brolly-policy", "action.prepare", id, {
			incidentId: incident.id,
			severity: incident.severity,
			rollback
		});
		return {
			id,
			incidentId: incident.id,
			asset: incident.asset,
			kind,
			state: "prepared",
			reason: incident.reason,
			observed: { [incident.metric]: incident.observed },
			rollback,
			actor: "brolly-policy",
			createdAt: now
		};
	}
	async resolveIncident(key) {
		const result = await this.db.prepare(`UPDATE incidents SET status='resolved',last_seen=?2 WHERE incident_key=?1 AND status!='resolved'`).bind(key, Date.now()).run();
		this.chargeMeta(result.meta);
	}
	async setActionState(actionId, state, error) {
		const result = await this.db.prepare(`UPDATE actions SET state=?2,error=?3,updated_at=?4 WHERE id=?1`).bind(actionId, state, error ?? null, Date.now()).run();
		this.chargeMeta(result.meta);
	}
	async claimActionState(actionId, expected, next) {
		const result = await this.db.prepare(`UPDATE actions SET state=?3,error=NULL,updated_at=?4 WHERE id=?1 AND state=?2`).bind(actionId, expected, next, Date.now()).run();
		this.chargeMeta(result.meta);
		return Number(result.meta.changes ?? 0) === 1;
	}
	async audit(actor, action, target, detail) {
		const result = await this.db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
		this.chargeMeta(result.meta);
	}
	async listNotificationTargets() {
		const result = await this.db.prepare(`SELECT * FROM notification_targets WHERE enabled=1 LIMIT 20`).all();
		this.chargeMeta(result.meta);
		return result.results;
	}
	async notificationAllowed(targetId, kind) {
		const now = Date.now();
		const result = await this.db.prepare(`SELECT
         SUM(CASE WHEN created_at>=?2 THEN 1 ELSE 0 END) AS hourly,
         SUM(CASE WHEN created_at>=?3 THEN 1 ELSE 0 END) AS daily
       FROM notification_deliveries WHERE target_id=?1 AND created_at>=?3`).bind(targetId, now - 36e5, now - 864e5).first();
		this.chargeRows(result ? 1 : 0);
		return Number(result?.hourly ?? 0) < 20 && (kind !== "twilio" || Number(result?.daily ?? 0) < 5);
	}
	async recordNotification(targetId, incidentId, kind, result) {
		const written = await this.db.prepare(`INSERT INTO notification_deliveries(id,target_id,incident_id,kind,ok,status_code,error,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(crypto.randomUUID(), targetId, incidentId, kind, result.ok ? 1 : 0, result.status ?? null, result.error?.slice(0, 2e3) ?? null, Date.now()).run();
		this.chargeMeta(written.meta);
	}
	chargeMeta(meta) {
		this.chargeRows((meta.rows_read ?? 0) + (meta.rows_written ?? meta.changes ?? 0));
	}
	async runBatches(statements, batchSize = 100) {
		for (let offset = 0; offset < statements.length; offset += batchSize) {
			const results = await this.db.batch(statements.slice(offset, offset + batchSize));
			for (const result of results) this.chargeMeta(result.meta);
		}
	}
};
function parseTags$1(value) {
	if (!value) return {};
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}
function actionFromRow(row, asset) {
	return {
		id: String(row.id),
		incidentId: String(row.incident_id),
		asset,
		kind: row.kind,
		state: row.state,
		reason: String(row.reason),
		observed: JSON.parse(String(row.observed_json)),
		rollback: JSON.parse(String(row.rollback_json)),
		actor: String(row.actor),
		createdAt: Number(row.created_at)
	};
}
function fromIncidentRow(row, asset) {
	return {
		id: String(row.id),
		key: String(row.incident_key),
		asset,
		metric: String(row.metric),
		severity: row.severity,
		observed: Number(row.observed),
		threshold: row.threshold_value == null ? void 0 : Number(row.threshold_value),
		expected: row.expected == null ? void 0 : Number(row.expected),
		reason: String(row.reason),
		action: row.proposed_action,
		status: row.status,
		firstSeen: Number(row.first_seen),
		lastSeen: Number(row.last_seen),
		occurrences: Number(row.occurrences)
	};
}
//#endregion
//#region ../../packages/runtime/dist/index.js
var BROLLY_FUSE_BINDING = "BROLLY_FUSE";
//#endregion
//#region src/control.ts
var FUSE_SETTING_PREFIX = "deployment_fuse:";
var MAX_FUSE_BYTES = 5e3;
var AUTOMATIC_WORKER_COOLDOWN_MS = 3e5;
var AUTOMATIC_ACCOUNT_WINDOW_MS = 36e5;
var MAX_AUTOMATIC_DEPLOYMENTS_PER_HOUR = 12;
var AutomaticDeploymentLimitError = class extends Error {};
/**
* Apply or clear a deployment-carried fuse. The only external operation is the
* one-time Cloudflare control-plane secret update; instrumented runtimes never
* call Brolly or any storage service while enforcing it.
*/
async function executeDeploymentFuseControl(env, action, workerScript, requestedAction = "quarantine", automatic = false) {
	return executeDeploymentFuseBatch(env, [action], workerScript, requestedAction, automatic);
}
async function executeDeploymentFuseBatch(env, actions, workerScript, requestedAction = "quarantine", automatic = false) {
	if (!actions.length) throw new Error("At least one fuse action is required");
	if (!/^[A-Za-z0-9_-]+$/.test(workerScript)) throw new Error("Owning Worker script name is invalid");
	await assertSafeDeploymentTarget(env, actions, workerScript, automatic);
	const holder = crypto.randomUUID();
	if (!await acquireControlLease(env.DB, `fuse:${workerScript}`, holder, 3e4)) throw new AutomaticDeploymentLimitError(`Another fuse update for ${workerScript} is already in progress`);
	try {
		if (automatic) await assertAutomaticDeploymentCapacity(env.DB, workerScript);
		const key = `${FUSE_SETTING_PREFIX}${workerScript}`;
		const current = parseStoredFuse((await env.DB.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`).bind(key).first())?.value);
		const manifest = {
			version: 1,
			generation: current.generation + 1,
			...current.worker ? { worker: current.worker } : {},
			...current.objects && Object.keys(current.objects).length ? { objects: { ...current.objects } } : {}
		};
		for (const action of actions) applyFuseAction(manifest, action, requestedAction);
		const encoded = JSON.stringify(manifest);
		if (new TextEncoder().encode(encoded).byteLength > MAX_FUSE_BYTES) throw new Error("BROLLY_FUSE would exceed Cloudflare's 5 KB binding limit; quarantine the Worker or clear inactive object quarantines first");
		await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(key, encoded, Date.now()).run();
		await cf(env, await operationalToken(env), `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerScript)}/secrets`, {
			method: "PUT",
			body: JSON.stringify({
				name: BROLLY_FUSE_BINDING,
				text: encoded,
				type: "secret_text"
			})
		});
		await env.DB.prepare(`INSERT INTO control_deployments(id,worker_script,generation,action_count,automatic,created_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), workerScript, manifest.generation, actions.length, automatic ? 1 : 0, Date.now()).run();
		return {
			workerScript,
			manifest
		};
	} finally {
		await releaseControlLease(env.DB, `fuse:${workerScript}`, holder);
	}
}
function applyFuseAction(manifest, action, requestedAction) {
	const quarantine = {
		actionId: action.id,
		incidentId: action.incidentId,
		reason: action.reason.slice(0, 500),
		appliedAt: Date.now()
	};
	if (action.asset.family === "workers") {
		if (requestedAction === "quarantine") manifest.worker = quarantine;
		else if (manifest.worker?.actionId === action.id) delete manifest.worker;
		else if (manifest.worker) throw new Error(`Worker quarantine belongs to newer action ${manifest.worker.actionId}; refusing to clear it with ${action.id}`);
	} else {
		manifest.objects ??= {};
		if (requestedAction === "quarantine") manifest.objects[action.asset.id] = quarantine;
		else if (manifest.objects[action.asset.id]?.actionId === action.id) delete manifest.objects[action.asset.id];
		else if (manifest.objects[action.asset.id]) throw new Error(`Object quarantine belongs to newer action ${manifest.objects[action.asset.id].actionId}; refusing to clear it with ${action.id}`);
		if (Object.keys(manifest.objects).length === 0) delete manifest.objects;
	}
}
function parseStoredFuse(value) {
	if (!value) return {
		version: 1,
		generation: 0
	};
	try {
		const parsed = JSON.parse(value);
		if (parsed.version === 1 && Number.isSafeInteger(parsed.generation) && parsed.generation >= 0) return parsed;
	} catch {}
	throw new Error("Stored BROLLY_FUSE state is corrupt; refusing to replace live quarantine state");
}
async function assertSafeDeploymentTarget(env, actions, workerScript, automatic) {
	if (workerScript === (env.BROLLY_SELF_WORKER_NAME ?? "brolly-guard") || workerScript === "brolly-guard" || workerScript.startsWith("brolly-guard-")) throw new Error("Brolly's control-plane Worker cannot be quarantined");
	const worker = await env.DB.prepare(`SELECT tier,metadata_json FROM assets WHERE account_id=?1 AND family='workers' AND asset_id=?2 AND scope='resource' LIMIT 1`).bind(env.BROLLY_ACCOUNT_ID, workerScript).first();
	if (!worker) throw new Error(`Worker ${workerScript} is not in the current Cloudflare inventory`);
	if ([
		"control_plane",
		"critical",
		"unclassified"
	].includes(worker.tier)) throw new Error(`Worker ${workerScript} is protected as ${worker.tier}`);
	for (const action of actions) {
		if (action.asset.accountId !== env.BROLLY_ACCOUNT_ID) throw new Error("Action account does not match this Brolly installation");
		if ([
			"control_plane",
			"critical",
			"unclassified"
		].includes(action.asset.tier)) throw new Error(`Asset tier ${action.asset.tier} cannot be stopped`);
		if (action.asset.tags?.brollyFuse !== "true") throw new Error("The current inventory no longer marks this target as deployment-fuse integrated");
		if (action.asset.family !== "workers" && (action.asset.family !== "durable_objects" || action.asset.scope !== "object")) throw new Error("Deployment fuses support Worker scripts and exact Durable Object IDs only");
		if (action.asset.family === "workers" && action.asset.id !== workerScript) throw new Error("Worker action target does not match the inventoried Worker");
		if (action.asset.family === "durable_objects") {
			if (!/^[a-f0-9]{64}$/i.test(action.asset.id)) throw new Error("Exact Durable Object quarantine requires a 64-character object ID");
			if (action.asset.tags?.cloudflareWorkerScript !== workerScript) throw new Error("Durable Object ownership does not match Cloudflare inventory");
		}
	}
	if (automatic) {
		const verification = await env.DB.prepare(`SELECT value,updated_at FROM settings WHERE key=?1 LIMIT 1`).bind(`configuration_verification:${workerScript}`).first();
		if (!verification || verification.updated_at < Date.now() - 864e5) throw new Error(`Automatic quarantine requires a successful verification of ${workerScript} within the last 24 hours`);
		let checks;
		try {
			checks = JSON.parse(verification.value).checks;
		} catch {
			throw new Error(`Automatic quarantine verification for ${workerScript} is corrupt`);
		}
		if (![
			"apiAccess",
			"fuseSecret",
			"runtimeBundle",
			"activeDeployment"
		].every((key) => checks[key]?.state === "pass")) throw new Error(`Automatic quarantine is disabled because ${workerScript} is not fully verified`);
	}
}
async function assertAutomaticDeploymentCapacity(db, workerScript) {
	const now = Date.now();
	const [worker, account] = await Promise.all([db.prepare(`SELECT created_at FROM control_deployments WHERE worker_script=?1 AND automatic=1 ORDER BY created_at DESC LIMIT 1`).bind(workerScript).first(), db.prepare(`SELECT COUNT(*) AS count FROM control_deployments WHERE automatic=1 AND created_at>=?1`).bind(now - AUTOMATIC_ACCOUNT_WINDOW_MS).first()]);
	if (worker && worker.created_at > now - AUTOMATIC_WORKER_COOLDOWN_MS) throw new AutomaticDeploymentLimitError(`Automatic deployment cooldown is active for ${workerScript}`);
	if (Number(account?.count ?? 0) >= MAX_AUTOMATIC_DEPLOYMENTS_PER_HOUR) throw new AutomaticDeploymentLimitError("Brolly's automatic deployment circuit breaker is open for one hour");
}
async function acquireControlLease(db, name, holder, ttlMs) {
	const now = Date.now();
	const result = await db.prepare(`INSERT INTO cron_lease(name,holder,expires_at) VALUES(?1,?2,?3)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?4 OR cron_lease.holder=?2`).bind(name, holder, now + ttlMs, now).run();
	return Number(result.meta.changes ?? 0) > 0;
}
async function releaseControlLease(db, name, holder) {
	await db.prepare(`DELETE FROM cron_lease WHERE name=?1 AND holder=?2`).bind(name, holder).run();
}
/** Capture the exact rollback state before any account-level mutation is attempted. */
async function prepareCloudflareControl(env, action) {
	const token = await operationalToken(env);
	if (action.kind === "pause_consumer") {
		const queue = await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/queues/${encodeURIComponent(action.asset.id)}`);
		return {
			kind: "pause_consumer",
			settings: queue.settings && typeof queue.settings === "object" ? queue.settings : {}
		};
	}
	if (action.kind === "disable_trigger") {
		const script = encodeURIComponent(action.asset.id);
		const schedules = await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/schedules`);
		const subdomain = await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/subdomain`);
		const zoneEnvelope = await cfEnvelope(token, `/zones?account.id=${encodeURIComponent(env.BROLLY_ACCOUNT_ID)}&per_page=50`);
		if ((zoneEnvelope.result_info?.total_pages ?? 1) > 1) throw new Error("Worker control refused: more than 50 zones would make the rollback snapshot incomplete");
		const zones = zoneEnvelope.result;
		const routes = [];
		for (const zone of zones.slice(0, 50)) {
			const routeEnvelope = await cfEnvelope(token, `/zones/${zone.id}/workers/routes`);
			if ((routeEnvelope.result_info?.total_pages ?? 1) > 1) throw new Error(`Worker control refused: route snapshot for zone ${zone.id} is incomplete`);
			const listed = routeEnvelope.result;
			for (const route of listed.filter((item) => item.script === action.asset.id).slice(0, 100)) routes.push({
				zoneId: zone.id,
				id: route.id,
				pattern: route.pattern
			});
		}
		const domainEnvelope = await cfEnvelope(token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/domains?service=${encodeURIComponent(action.asset.id)}&per_page=100`);
		if ((domainEnvelope.result_info?.total_pages ?? 1) > 1) throw new Error("Worker control refused: more than 100 custom domains would make the rollback snapshot incomplete");
		return {
			kind: "disable_trigger",
			schedules: schedules.schedules,
			subdomain,
			routes,
			domains: domainEnvelope.result
		};
	}
	throw new Error(`Unsupported Cloudflare control: ${action.kind}`);
}
/** Execute only after prepareCloudflareControl's snapshot is durably stored. */
async function executeCloudflareControl(env, action) {
	const token = await operationalToken(env);
	if (action.kind === "pause_consumer") {
		const settings = action.rollback.settings ?? {};
		await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/queues/${encodeURIComponent(action.asset.id)}`, {
			method: "PATCH",
			body: JSON.stringify({ settings: {
				...settings,
				delivery_paused: true
			} })
		});
		return;
	}
	if (action.kind === "disable_trigger") throw new Error("Route-deleting Worker shutdown is retired; install @standardagents/brolly-runtime for reversible Worker quarantine");
	throw new Error(`Unsupported Cloudflare control: ${action.kind}`);
}
async function rollbackCloudflareControl(env, action) {
	const token = await operationalToken(env);
	if (action.kind === "pause_consumer") {
		await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/queues/${encodeURIComponent(action.asset.id)}`, {
			method: "PATCH",
			body: JSON.stringify({ settings: action.rollback.settings ?? {} })
		});
		return;
	}
	if (action.kind === "disable_trigger") {
		const script = encodeURIComponent(action.asset.id);
		const schedules = (action.rollback.schedules ?? []).map((schedule) => ({ cron: schedule.cron }));
		await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/schedules`, {
			method: "PUT",
			body: JSON.stringify(schedules)
		});
		const subdomain = action.rollback.subdomain;
		if (subdomain?.enabled || subdomain?.previews_enabled) await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/subdomain`, {
			method: "POST",
			body: JSON.stringify(subdomain)
		});
		for (const route of action.rollback.routes ?? []) await cf(env, token, `/zones/${route.zoneId}/workers/routes`, {
			method: "POST",
			body: JSON.stringify({
				pattern: route.pattern,
				script: action.asset.id
			})
		});
		for (const domain of action.rollback.domains ?? []) await cf(env, token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/domains`, {
			method: "PUT",
			body: JSON.stringify({
				hostname: domain.hostname,
				service: domain.service,
				...domain.zone_id ? { zone_id: domain.zone_id } : {},
				...domain.zone_name ? { zone_name: domain.zone_name } : {}
			})
		});
	}
}
async function cf(env, token, path, init = {}) {
	return (await cfEnvelope(token, path, init)).result;
}
async function cfEnvelope(token, path, init = {}) {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		signal: init.signal ?? AbortSignal.timeout(1e4),
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...init.headers
		}
	});
	if (!response.ok) throw new Error(`Cloudflare control failed (${response.status}): ${await response.text()}`);
	const payload = await response.json();
	if (!payload.success) throw new Error(payload.errors?.map((error) => error.message).join("; ") ?? "Cloudflare control failed");
	return payload;
}
//#endregion
//#region src/monitor.ts
async function runMonitor(env) {
	const budget = new RunBudget();
	const store = new Store(env.DB, (amount) => budget.charge("databaseRows", amount));
	const holder = crypto.randomUUID();
	if (!await store.acquireLease("minute-monitor", holder, 55e3)) return;
	const automaticQueue = /* @__PURE__ */ new Map();
	try {
		const policy = await store.loadPolicy();
		const client = new CloudflareClient(env, budget);
		const now = Date.now();
		const utcMinute = new Date(now).getUTCMinutes();
		const since = now - 3e5;
		const inventory = await client.inventory();
		budget.charge("samples", inventory.assets.length);
		await store.saveAssets(inventory.assets);
		await store.saveCoverage(inventory.coverage);
		const [durableObjects, workers] = await Promise.all([client.durableObjectUsage(since, now), client.workerUsage(since, now)]);
		await store.saveCoverage([...durableObjects.coverage, ...workers.coverage]);
		await store.saveAssets(Array.from(new Map([...durableObjects.samples, ...workers.samples].map((sample) => [`${sample.asset.family}:${sample.asset.scope}:${sample.asset.id}`, sample.asset])).values()));
		await store.applyAssetPolicies(durableObjects.samples, "durable_objects");
		await store.applyAssetPolicies(workers.samples, "workers");
		let baselineQueries = 0;
		for (const sample of durableObjects.samples) {
			const threshold = policy.thresholds.find((item) => item.metric === sample.metric && item.windowMs === 3e5);
			if (!threshold) continue;
			let evaluation = evaluateSample(sample, threshold, [], policy);
			if (!evaluation && sample.value > 0 && baselineQueries < 50) {
				baselineQueries += 1;
				evaluation = evaluateSample(sample, threshold, await store.baseline(sample), policy);
			}
			if (evaluation) await handleEvaluation(store, evaluation, false, env, automaticQueue);
		}
		const objectCosts = /* @__PURE__ */ new Map();
		const namespaceCosts = /* @__PURE__ */ new Map();
		for (const sample of durableObjects.samples) if (sample.asset.scope === "object") {
			const current = objectCosts.get(sample.asset.id) ?? {
				asset: sample.asset,
				cost: 0
			};
			current.cost += sample.estimatedCostUsd ?? 0;
			objectCosts.set(sample.asset.id, current);
			if (sample.asset.parentId) {
				const namespace = namespaceCosts.get(sample.asset.parentId) ?? {
					asset: {
						accountId: env.BROLLY_ACCOUNT_ID,
						family: "durable_objects",
						id: sample.asset.parentId,
						scope: "namespace",
						tier: "unclassified"
					},
					cost: 0
				};
				namespace.cost += sample.estimatedCostUsd ?? 0;
				namespaceCosts.set(sample.asset.parentId, namespace);
			}
		} else if (sample.asset.scope === "namespace") {
			const namespace = namespaceCosts.get(sample.asset.id) ?? {
				asset: sample.asset,
				cost: 0
			};
			namespace.cost += sample.estimatedCostUsd ?? 0;
			namespaceCosts.set(sample.asset.id, namespace);
		}
		const objectCostThreshold = policy.thresholds.find((item) => item.metric === "projected_daily_cost_usd") ?? DEFAULT_POLICY.thresholds.find((item) => item.metric === "projected_daily_cost_usd");
		for (const value of objectCosts.values()) {
			const projected = value.cost * (864e5 / (now - since));
			const evaluation = evaluateSample({
				asset: value.asset,
				metric: "projected_daily_cost_usd",
				unit: "usd",
				value: projected,
				start: since,
				end: now,
				source: "graphql",
				estimatedCostUsd: projected
			}, objectCostThreshold, [], policy);
			if (evaluation) await handleEvaluation(store, evaluation, false, env, automaticQueue);
		}
		const namespaceProjectedSamples = [...namespaceCosts.values()].map((value) => ({
			asset: value.asset,
			metric: "projected_daily_cost_usd",
			unit: "usd",
			value: value.cost * (864e5 / (now - since)),
			start: since,
			end: now,
			source: "graphql",
			estimatedCostUsd: value.cost * (864e5 / (now - since))
		}));
		await store.applyAssetPolicies(namespaceProjectedSamples, "durable_objects");
		for (const sample of namespaceProjectedSamples) {
			const evaluation = evaluateProjectedDailySpend(sample.asset, sample.value, policy);
			if (evaluation) await handleEvaluation(store, evaluation, false, env, automaticQueue);
		}
		const workerCosts = /* @__PURE__ */ new Map();
		for (const sample of workers.samples) {
			const current = workerCosts.get(sample.asset.id) ?? {
				asset: sample.asset,
				cost: 0
			};
			current.cost += sample.estimatedCostUsd ?? 0;
			workerCosts.set(sample.asset.id, current);
		}
		for (const value of workerCosts.values()) {
			const projected = value.cost * (864e5 / (now - since));
			const evaluation = evaluateProjectedDailySpend(value.asset, projected, policy);
			if (evaluation) await handleEvaluation(store, evaluation, false, env, automaticQueue);
		}
		let rolling24hCost = null;
		if (utcMinute % 15 === 0) {
			const dailyObjects = await client.durableObjectUsage(now - 864e5, now);
			await store.saveCoverage(dailyObjects.coverage);
			await store.applyAssetPolicies(dailyObjects.samples, "durable_objects");
			rolling24hCost = dailyObjects.samples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0);
			for (const sample of dailyObjects.samples) {
				const threshold = policy.thresholds.find((item) => item.metric === sample.metric && item.windowMs === 864e5);
				if (!threshold) continue;
				const evaluation = evaluateSample(sample, threshold, [], policy);
				if (evaluation) await handleEvaluation(store, evaluation, false, env, automaticQueue);
			}
		}
		const projectedDailyCost = durableObjects.samples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0) * (864e5 / (now - since));
		const projectedWorkersDailyCost = workers.samples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0) * (864e5 / (now - since));
		const spendAsset = {
			accountId: env.BROLLY_ACCOUNT_ID,
			family: "durable_objects",
			id: env.BROLLY_ACCOUNT_ID,
			name: "all Durable Objects",
			scope: "account",
			tier: "control_plane"
		};
		const workersSpendAsset = {
			accountId: env.BROLLY_ACCOUNT_ID,
			family: "workers",
			id: env.BROLLY_ACCOUNT_ID,
			name: "all Workers",
			scope: "account",
			tier: "control_plane"
		};
		await store.saveSamples([
			{
				asset: spendAsset,
				metric: "projected_daily_cost_usd",
				unit: "usd",
				value: projectedDailyCost,
				start: since,
				end: now,
				source: "graphql",
				estimatedCostUsd: projectedDailyCost
			},
			...rolling24hCost === null ? [] : [{
				asset: spendAsset,
				metric: "rolling_24h_cost_usd",
				unit: "usd",
				value: rolling24hCost,
				start: now - 864e5,
				end: now,
				source: "graphql",
				estimatedCostUsd: rolling24hCost
			}],
			{
				asset: workersSpendAsset,
				metric: "projected_daily_cost_usd",
				unit: "usd",
				value: projectedWorkersDailyCost,
				start: since,
				end: now,
				source: "graphql",
				estimatedCostUsd: projectedWorkersDailyCost
			}
		]);
		const accountEvaluation = evaluateProjectedDailySpend(spendAsset, projectedDailyCost, policy);
		if (accountEvaluation) await handleEvaluation(store, accountEvaluation, false, env, automaticQueue);
		const workersAccountEvaluation = evaluateProjectedDailySpend(workersSpendAsset, projectedWorkersDailyCost, policy);
		if (workersAccountEvaluation) await handleEvaluation(store, workersAccountEvaluation, false, env, automaticQueue);
		if (utcMinute % 15 === 0) {
			const scores = /* @__PURE__ */ new Map();
			for (const sample of durableObjects.samples) scores.set(sample.asset.id, (scores.get(sample.asset.id) ?? 0) + (sample.estimatedCostUsd ?? 0));
			const retainedIds = new Set([...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 333).map(([id]) => id));
			await store.saveSamples(durableObjects.samples.filter((sample) => retainedIds.has(sample.asset.id)));
		}
		await coverageIncidents(store, [
			...inventory.coverage,
			...durableObjects.coverage,
			...workers.coverage
		], env, automaticQueue);
		await flushAutomaticFuses(store, env, automaticQueue);
		const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: env.BROLLY_TIMEZONE ?? "UTC" }).format(new Date(now));
		if (isDailySummaryHour(env) && await store.claimDailySummary(localDay)) {
			let billing = null;
			let authoritativeBilledCost = null;
			let billingState = "permission_denied";
			let billingDetail = "Add Billing Read access in Brolly setup or configure CLOUDFLARE_BILLING_TOKEN for authoritative reconciliation";
			try {
				billing = await client.billingUsage(now - 1728e5, now);
				if (billing) {
					billingState = "healthy";
					billingDetail = void 0;
				}
			} catch (error) {
				billingState = "unavailable";
				billingDetail = error instanceof Error ? error.message : String(error);
			}
			await store.saveCoverage([{
				family: "billing",
				metric: "authoritative_usage",
				finestScope: "account",
				state: billingState,
				checkedAt: now,
				detail: billingDetail
			}]);
			if (billingState !== "healthy") {
				const billingCoverageAsset = {
					accountId: env.BROLLY_ACCOUNT_ID,
					family: "billing",
					id: "authoritative_usage",
					scope: "account",
					tier: "control_plane"
				};
				await handleEvaluation(store, {
					key: `${env.BROLLY_ACCOUNT_ID}:coverage:billing:authoritative_usage`,
					asset: billingCoverageAsset,
					metric: "telemetry_coverage",
					severity: "critical",
					observed: 0,
					reason: `billing/authoritative_usage telemetry is ${billingState}${billingDetail ? `: ${billingDetail}` : ""}`,
					action: "notify"
				}, false, env, automaticQueue);
			}
			if (billing) {
				const billingSamples = billing.slice(0, 1e4).map((record) => {
					const family = record.x_ProductFamilyId ?? record.x_ProductFamilyName ?? "unknown";
					return {
						asset: {
							accountId: env.BROLLY_ACCOUNT_ID,
							family,
							id: record.x_ZoneId ?? family,
							name: record.x_ZoneName ?? record.x_ProductFamilyName,
							scope: record.x_ZoneId ? "zone" : "account",
							tier: "control_plane"
						},
						metric: record.x_BillableMetricId,
						unit: billingUnit(record.ConsumedUnit),
						value: record.ConsumedQuantity,
						start: Date.parse(record.ChargePeriodStart),
						end: Date.parse(record.ChargePeriodEnd),
						source: "billing",
						estimatedCostUsd: record.BilledCost ?? record.EffectiveCost ?? record.ListCost
					};
				});
				budget.charge("samples", billingSamples.length);
				await store.saveSamples(billingSamples);
				const currentBillingSamples = billingSamples.filter((sample) => sample.end >= now - 864e5);
				if (currentBillingSamples.some((sample) => sample.estimatedCostUsd !== void 0)) {
					const authoritativeCost = currentBillingSamples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0);
					authoritativeBilledCost = authoritativeCost;
					const billingEvaluation = evaluateSample({
						asset: {
							accountId: env.BROLLY_ACCOUNT_ID,
							family: "billing",
							id: env.BROLLY_ACCOUNT_ID,
							scope: "account",
							tier: "control_plane"
						},
						metric: "account_daily_billed_cost_usd",
						unit: "usd",
						value: authoritativeCost,
						start: now - 864e5,
						end: now,
						source: "billing",
						estimatedCostUsd: authoritativeCost
					}, {
						metric: "account_daily_billed_cost_usd",
						windowMs: 864e5,
						...policy.accountDailySpend
					}, [], policy);
					if (billingEvaluation) await handleEvaluation(store, billingEvaluation, false, env, automaticQueue);
				}
			}
			const dailyAsset = {
				accountId: env.BROLLY_ACCOUNT_ID,
				family: "billing",
				id: "daily-summary",
				scope: "account",
				tier: "control_plane"
			};
			const dailyKey = `${env.BROLLY_ACCOUNT_ID}:daily-summary:${localDay}`;
			await handleEvaluation(store, {
				key: dailyKey,
				asset: dailyAsset,
				metric: "daily_summary",
				severity: "info",
				observed: projectedDailyCost,
				reason: `Daily summary: ${objectCosts.size} active Durable Objects in the latest window; projected gross Durable Objects cost $${projectedDailyCost.toFixed(2)}${billingState === "permission_denied" ? "; authoritative billing token not configured" : billingState === "unavailable" ? "; authoritative billing API unavailable" : authoritativeBilledCost === null ? "; authoritative usage returned without cost fields" : `; latest authoritative billed/effective/list cost $${authoritativeBilledCost.toFixed(2)}`}`,
				action: "notify"
			}, true, env, automaticQueue);
			await store.resolveIncident(dailyKey);
		}
		const cleanup = await env.DB.prepare(`DELETE FROM metric_samples WHERE id IN (SELECT id FROM metric_samples WHERE end_at < ?1 ORDER BY end_at ASC LIMIT 500)`).bind(now - 3024e6).run();
		budget.charge("databaseRows", (cleanup.meta.rows_read ?? 0) + (cleanup.meta.rows_written ?? cleanup.meta.changes ?? 0));
		const notificationCleanup = await env.DB.prepare(`DELETE FROM notification_deliveries WHERE id IN (SELECT id FROM notification_deliveries WHERE created_at < ?1 ORDER BY created_at ASC LIMIT 500)`).bind(now - 3024e6).run();
		budget.charge("databaseRows", (notificationCleanup.meta.rows_read ?? 0) + (notificationCleanup.meta.rows_written ?? notificationCleanup.meta.changes ?? 0));
		if (utcMinute % 15 === 0) await cleanupControlPlaneHistory(env.DB, budget, now);
		await store.resolveIncident(`${env.BROLLY_ACCOUNT_ID}:brolly:monitor_health`);
	} catch (error) {
		if (error instanceof MonitoringBudgetExceededError) {
			console.error(JSON.stringify({
				event: "monitoring_budget_exhausted",
				kind: error.kind,
				message: error.message,
				usage: budget.usage
			}));
			await writeSentinelIncident(env.DB, env.BROLLY_ACCOUNT_ID, error.message);
			return;
		}
		console.error("[Brolly] monitor failed", error);
		await writeSentinelIncident(env.DB, env.BROLLY_ACCOUNT_ID, error instanceof Error ? error.message : String(error));
	}
}
async function cleanupControlPlaneHistory(db, budget, now) {
	const statements = [
		db.prepare(`DELETE FROM oauth_states WHERE state_hash IN (SELECT state_hash FROM oauth_states WHERE expires_at<?1 LIMIT 250)`).bind(now),
		db.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at<?1 LIMIT 250)`).bind(now),
		db.prepare(`DELETE FROM control_deployments WHERE id IN (SELECT id FROM control_deployments WHERE created_at<?1 ORDER BY created_at LIMIT 250)`).bind(now - 3024e6),
		db.prepare(`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE created_at<?1 ORDER BY created_at LIMIT 250)`).bind(now - 31536e6),
		db.prepare(`DELETE FROM actions WHERE id IN (SELECT id FROM actions WHERE updated_at<?1 AND state IN ('failed','rolled_back') ORDER BY updated_at LIMIT 250)`).bind(now - 15552e6),
		db.prepare(`DELETE FROM incidents WHERE id IN (SELECT id FROM incidents WHERE last_seen<?1 AND status='resolved' ORDER BY last_seen LIMIT 250)`).bind(now - 7776e6),
		db.prepare(`DELETE FROM settings WHERE key IN (SELECT key FROM settings WHERE key LIKE 'configuration_verification:%' AND updated_at<?1 LIMIT 250)`).bind(now - 3024e6)
	];
	for (const result of await db.batch(statements)) budget.charge("databaseRows", (result.meta.rows_read ?? 0) + (result.meta.rows_written ?? result.meta.changes ?? 0));
}
function billingUnit(unit) {
	const normalized = unit.toLowerCase();
	if (normalized.includes("gb-s") || normalized.includes("gb second")) return "gb_seconds";
	if (normalized.includes("byte") || normalized === "gb") return "bytes";
	if (normalized.includes("request")) return "requests";
	if (normalized.includes("row")) return "rows";
	if (normalized.includes("second") || normalized.includes("millisecond")) return "milliseconds";
	if (normalized === "usd") return "usd";
	return "count";
}
async function handleEvaluation(store, evaluation, dailySummary = false, env, automaticQueue) {
	const { previous, incident, notify: shouldSend } = await store.recordEvaluation(evaluation);
	if (evaluation.action !== "notify") {
		const action = await store.ensureRuntimeAction(incident);
		const workerScript = incident.asset.family === "workers" ? incident.asset.id : incident.asset.tags?.cloudflareWorkerScript;
		const deploymentFuseReady = incident.asset.tags?.brollyFuse === "true" && Boolean(workerScript);
		if (evaluation.action === "stop" && env && automaticQueue && action.kind === "runtime_quarantine" && deploymentFuseReady && action.state === "prepared" && confirmedAutomaticEmergency(previous, incident)) automaticQueue.set(workerScript, [...automaticQueue.get(workerScript) ?? [], action]);
	}
	if (!shouldSend) return;
	const targets = await store.listNotificationTargets();
	await Promise.allSettled(targets.slice(0, 10).map(async (row) => {
		const severityRank = {
			info: 0,
			warning: 1,
			critical: 2,
			emergency: 3
		};
		const minimum = String(row.minimum_severity ?? "warning");
		if (!dailySummary && severityRank[incident.severity] < (severityRank[minimum] ?? 1)) return;
		if (!await store.notificationAllowed(String(row.id), String(row.kind))) return;
		const result = await notify({
			...env?.BROLLY_CREDENTIAL_KEY ? await openJson(String(row.config_json), env.BROLLY_CREDENTIAL_KEY) : JSON.parse(String(row.config_json)),
			id: String(row.id),
			kind: row.kind,
			enabled: true
		}, incident);
		await store.recordNotification(String(row.id), incident.id, String(row.kind), result);
		return result;
	}));
}
async function coverageIncidents(store, coverage, env, automaticQueue) {
	const accountId = env.BROLLY_ACCOUNT_ID;
	for (const item of coverage) {
		const key = `${accountId}:coverage:${item.family}:${item.metric}`;
		if (item.state === "healthy") {
			await store.resolveIncident(key);
			continue;
		}
		await handleEvaluation(store, {
			key,
			asset: {
				accountId,
				family: item.family,
				id: item.metric,
				scope: "account",
				tier: "control_plane"
			},
			metric: "telemetry_coverage",
			severity: "critical",
			observed: 0,
			reason: `${item.family}/${item.metric} telemetry is ${item.state}${item.detail ? `: ${item.detail}` : ""}`,
			action: "notify"
		}, false, env, automaticQueue);
	}
	const seen = new Set(coverage.map((item) => `${item.family}:${item.metric}`));
	const missing = [];
	for (const definition of METRIC_CATALOG) for (const metric of definition.metrics) {
		if (seen.has(`${definition.family}:${metric}`)) continue;
		missing.push({
			family: definition.family,
			metric,
			finestScope: definition.preferredScope,
			state: "unavailable",
			checkedAt: Date.now(),
			detail: "No active fast-telemetry collector"
		});
		const asset = {
			accountId,
			family: definition.family,
			id: metric,
			scope: "account",
			tier: "control_plane"
		};
		await handleEvaluation(store, {
			key: `${accountId}:coverage:${definition.family}:${metric}`,
			asset,
			metric: "telemetry_coverage",
			severity: "warning",
			observed: 0,
			reason: `${definition.family}/${metric} has no active collector`,
			action: "notify"
		}, false, env, automaticQueue);
	}
	await store.saveCoverage(missing);
}
function confirmedAutomaticEmergency(previous, incident) {
	if (!previous || previous.status === "resolved" || previous.severity !== "emergency" || incident.severity !== "emergency") return false;
	if ([
		"projected_daily_cost_usd",
		"account_daily_billed_cost_usd",
		"daily_summary",
		"telemetry_coverage"
	].includes(incident.metric)) return false;
	if (!(incident.asset.family === "workers" && incident.asset.scope === "resource") && !(incident.asset.family === "durable_objects" && incident.asset.scope === "object")) return false;
	const encodedWindow = Number(incident.key.split(":").at(-1));
	const maximumGap = Number.isFinite(encodedWindow) && encodedWindow > 3e5 ? 12e5 : 42e4;
	return incident.lastSeen - previous.lastSeen <= maximumGap;
}
async function flushAutomaticFuses(store, env, queue) {
	for (const [workerScript, queued] of [...queue.entries()].slice(0, 5)) {
		const actions = [...new Map(queued.map((action) => [action.id, action])).values()].slice(0, 15);
		const claimed = [];
		for (const action of actions) if (await store.claimActionState(action.id, "prepared", "running")) claimed.push({
			...action,
			state: "running"
		});
		if (!claimed.length) continue;
		await store.audit("brolly-policy", "action.quarantine.batch.start", workerScript, { actionIds: claimed.map((action) => action.id) });
		try {
			const result = await executeDeploymentFuseBatch(env, claimed, workerScript, "quarantine", true);
			for (const action of claimed) await store.setActionState(action.id, "succeeded");
			await store.audit("brolly-policy", "action.quarantine.batch.succeeded", workerScript, {
				actionIds: claimed.map((action) => action.id),
				generation: result.manifest.generation
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const retryable = error instanceof AutomaticDeploymentLimitError;
			for (const action of claimed) await store.setActionState(action.id, retryable ? "prepared" : "failed", message);
			await store.audit("brolly-policy", retryable ? "action.quarantine.batch.deferred" : "action.quarantine.batch.failed", workerScript, {
				actionIds: claimed.map((action) => action.id),
				error: message
			});
		}
	}
}
async function writeSentinelIncident(db, accountId, reason) {
	const now = Date.now();
	await db.prepare(`INSERT INTO incidents(id,incident_key,account_id,family,asset_id,severity,metric,observed,reason,proposed_action,status,first_seen,last_seen,occurrences)
     VALUES(?1,?2,?3,'brolly','monitor','emergency','monitor_health',0,?4,'notify','open',?5,?5,1)
     ON CONFLICT(incident_key) DO UPDATE SET reason=excluded.reason,last_seen=excluded.last_seen,occurrences=incidents.occurrences+1`).bind(crypto.randomUUID(), `${accountId}:brolly:monitor_health`, accountId, reason.slice(0, 2e3), now).run();
}
function isDailySummaryHour(env) {
	const hour = Number(env.BROLLY_DAILY_SUMMARY_HOUR ?? "9");
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: env.BROLLY_TIMEZONE ?? "UTC",
		hour: "numeric",
		minute: "numeric",
		hourCycle: "h23"
	}).formatToParts(/* @__PURE__ */ new Date());
	const currentHour = Number(parts.find((part) => part.type === "hour")?.value);
	const currentMinute = Number(parts.find((part) => part.type === "minute")?.value);
	return currentHour === hour && currentMinute < 5;
}
//#endregion
//#region src/dashboard-api.ts
async function dashboardData(env) {
	const now = Date.now();
	const [policyRow, incidentResult, coverageResult, assetFamilyResult, tierResult, spendResult, actionResult] = await Promise.all([
		env.DB.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first(),
		env.DB.prepare(`SELECT i.*,a.name AS asset_name,a.parent_id,a.scope,a.tier,a.metadata_json,
        p.tier AS parent_tier,p.metadata_json AS parent_metadata_json,
        (SELECT unit FROM metric_samples s WHERE s.account_id=i.account_id AND s.family=i.family AND s.asset_id=i.asset_id AND s.metric=i.metric ORDER BY s.end_at DESC LIMIT 1) AS unit,
        (SELECT id FROM actions x WHERE x.incident_id=i.id ORDER BY x.updated_at DESC LIMIT 1) AS action_id,
        (SELECT state FROM actions x WHERE x.incident_id=i.id ORDER BY x.updated_at DESC LIMIT 1) AS action_state,
        (SELECT kind FROM actions x WHERE x.incident_id=i.id ORDER BY x.updated_at DESC LIMIT 1) AS action_kind
       FROM incidents i
       LEFT JOIN assets a ON a.account_id=i.account_id AND a.family=i.family AND a.asset_id=i.asset_id
       LEFT JOIN assets p ON p.account_id=a.account_id AND p.family=a.family AND p.asset_id=a.parent_id
       WHERE i.status!='resolved' AND i.metric!='telemetry_coverage'
       ORDER BY CASE i.severity WHEN 'emergency' THEN 0 WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,i.last_seen DESC LIMIT 250`).all(),
		env.DB.prepare(`SELECT family,metric,finest_scope,state,detail,checked_at FROM metric_coverage ORDER BY CASE state WHEN 'permission_denied' THEN 0 WHEN 'unavailable' THEN 1 WHEN 'delayed' THEN 2 ELSE 3 END,family,metric`).all(),
		env.DB.prepare(`SELECT family,COUNT(*) AS asset_count,MAX(seen_at) AS last_seen FROM assets GROUP BY family ORDER BY asset_count DESC,family`).all(),
		env.DB.prepare(`SELECT tier,COUNT(*) AS asset_count FROM assets GROUP BY tier`).all(),
		env.DB.prepare(`SELECT family,metric,value,estimated_cost_usd,source,start_at,end_at FROM metric_samples
       WHERE metric IN ('rolling_24h_cost_usd','projected_daily_cost_usd','account_daily_billed_cost_usd')
         AND end_at>=?1 ORDER BY end_at ASC LIMIT 2500`).bind(now - 864e5).all(),
		env.DB.prepare(`SELECT id,incident_id,family,asset_id,kind,state,reason,error,created_at,updated_at FROM actions ORDER BY updated_at DESC LIMIT 20`).all()
	]);
	const policy = readPolicy(policyRow?.value);
	const incidents = incidentResult.results.map(incidentView);
	const coverage = coverageResult.results.map((row) => ({
		family: String(row.family),
		metric: String(row.metric),
		scope: String(row.finest_scope),
		state: String(row.state),
		detail: row.detail == null ? null : String(row.detail),
		checkedAt: Number(row.checked_at)
	}));
	const coverageGaps = coverage.filter((item) => item.state !== "healthy");
	const spend = spendView(spendResult.results, coverage, now);
	const familyDefinitions = new Map(METRIC_CATALOG.map((item) => [item.family, item]));
	const assetFamilies = assetFamilyResult.results.map((row) => {
		const family = String(row.family);
		const definition = familyDefinitions.get(family);
		return {
			family,
			label: familyLabel(family),
			assets: Number(row.asset_count),
			lastSeen: Number(row.last_seen),
			cloudflareUrl: cloudflareUrl(env.BROLLY_ACCOUNT_ID, family),
			expectedMetrics: definition?.metrics.length ?? 0,
			healthyMetrics: coverage.filter((item) => item.family === family && item.state === "healthy").length,
			gaps: coverageGaps.filter((item) => item.family === family).length
		};
	});
	const severityCounts = countBy(incidents, (item) => String(item.severity));
	const statusCounts = countBy(incidents, (item) => String(item.status));
	return {
		generatedAt: now,
		account: {
			id: env.BROLLY_ACCOUNT_ID,
			timezone: env.BROLLY_TIMEZONE ?? "UTC"
		},
		policy: {
			mode: policy.mode,
			version: policy.version,
			accountDailySpend: policy.accountDailySpend,
			familyDailySpend: policy.familyDailySpend ?? DEFAULT_FAMILY_DAILY_SPEND,
			assetDailySpend: policy.assetDailySpend ?? {}
		},
		summary: {
			openIncidents: incidents.filter((item) => item.status === "open").length,
			acknowledgedIncidents: statusCounts.acknowledged ?? 0,
			emergencyIncidents: severityCounts.emergency ?? 0,
			criticalIncidents: severityCounts.critical ?? 0,
			coverageGaps: coverageGaps.length,
			assets: assetFamilies.reduce((sum, item) => sum + item.assets, 0),
			lastCheckAt: coverage.reduce((latest, item) => Math.max(latest, item.checkedAt), 0) || null
		},
		spend,
		incidents,
		coverage: {
			gaps: coverageGaps,
			all: coverage
		},
		assets: {
			families: assetFamilies,
			tiers: Object.fromEntries(tierResult.results.map((row) => [String(row.tier), Number(row.asset_count)]))
		},
		actions: actionResult.results.map((row) => ({
			id: String(row.id),
			incidentId: String(row.incident_id),
			family: String(row.family),
			assetId: String(row.asset_id),
			kind: String(row.kind),
			state: String(row.state),
			reason: String(row.reason),
			error: row.error == null ? null : String(row.error),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at)
		}))
	};
}
async function onboardingData(env) {
	const [completeRow, policyRow, coverageResult, scopedAssetResult] = await Promise.all([
		env.DB.prepare(`SELECT value FROM settings WHERE key='onboarding_complete' LIMIT 1`).first(),
		env.DB.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first(),
		env.DB.prepare(`SELECT family,metric,state FROM metric_coverage`).all(),
		env.DB.prepare(`SELECT family,asset_id,name,scope,metadata_json FROM assets WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace') ORDER BY family,name,asset_id LIMIT 2500`).all()
	]);
	const policy = readPolicy(policyRow?.value);
	const coverage = coverageResult.results;
	return {
		accountId: env.BROLLY_ACCOUNT_ID,
		complete: completeRow?.value === "true",
		policy: {
			...policy,
			familyDailySpend: {
				...DEFAULT_FAMILY_DAILY_SPEND,
				...policy.familyDailySpend
			},
			assetDailySpend: policy.assetDailySpend ?? {}
		},
		families: METRIC_CATALOG.map((definition) => ({
			family: definition.family,
			label: familyLabel(definition.family),
			metrics: definition.metrics,
			protection: coverage.some((item) => item.family === definition.family && item.state === "healthy") ? "active" : "coverage_gap"
		})),
		scopedAssets: scopedAssetResult.results.map((asset) => {
			const definition = METRIC_CATALOG.find((item) => item.family === asset.family);
			const protectedMetrics = coverage.filter((item) => item.family === asset.family && definition?.metrics.includes(item.metric));
			return {
				key: assetBudgetKey({
					family: asset.family,
					scope: asset.scope,
					id: asset.asset_id
				}),
				family: asset.family,
				id: asset.asset_id,
				name: asset.name ?? asset.asset_id,
				scope: asset.scope,
				tags: parseJson(asset.metadata_json ?? "{}"),
				protection: definition && definition.metrics.every((metric) => protectedMetrics.some((item) => item.metric === metric && item.state === "healthy")) ? "active" : "coverage_gap"
			};
		})
	};
}
async function assetList(request, env) {
	const url = new URL(request.url);
	const clauses = ["account_id=?1"];
	const values = [env.BROLLY_ACCOUNT_ID];
	const family = url.searchParams.get("family");
	const tier = url.searchParams.get("tier");
	const search = url.searchParams.get("search")?.trim();
	if (family) {
		values.push(family);
		clauses.push(`family=?${values.length}`);
	}
	if (tier) {
		values.push(tier);
		clauses.push(`tier=?${values.length}`);
	}
	if (search) {
		values.push(`%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
		clauses.push(`(name LIKE ?${values.length} ESCAPE '\\' OR asset_id LIKE ?${values.length} ESCAPE '\\')`);
	}
	const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
	const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(250, Math.floor(requestedLimit))) : 100;
	values.push(limit);
	return { assets: (await env.DB.prepare(`SELECT a.*,
      (SELECT COUNT(*) FROM incidents i WHERE i.account_id=a.account_id AND i.family=a.family AND i.asset_id=a.asset_id AND i.status!='resolved' AND i.metric!='telemetry_coverage') AS incident_count,
      (SELECT MAX(end_at) FROM metric_samples s WHERE s.account_id=a.account_id AND s.family=a.family AND s.asset_id=a.asset_id) AS last_signal_at
     FROM assets a WHERE ${clauses.join(" AND ")}
     ORDER BY incident_count DESC,seen_at DESC LIMIT ?${values.length}`).bind(...values).all()).results.map((row) => ({
		accountId: String(row.account_id),
		family: String(row.family),
		id: String(row.asset_id),
		parentId: row.parent_id == null ? null : String(row.parent_id),
		name: row.name == null ? null : String(row.name),
		scope: String(row.scope),
		tier: String(row.tier),
		tags: parseJson(String(row.metadata_json ?? "{}")),
		discoveredAt: Number(row.discovered_at),
		seenAt: Number(row.seen_at),
		incidentCount: Number(row.incident_count),
		lastSignalAt: row.last_signal_at == null ? null : Number(row.last_signal_at)
	})) };
}
function incidentView(row) {
	const metric = String(row.metric);
	const windowMs = incidentWindow(String(row.incident_key));
	const unit = row.unit == null ? inferredUnit(metric) : String(row.unit);
	const tags = {
		...parseJson(String(row.parent_metadata_json ?? "{}")),
		...parseJson(String(row.metadata_json ?? "{}"))
	};
	const directTier = row.tier == null ? "unclassified" : String(row.tier);
	const tier = directTier !== "unclassified" ? directTier : row.parent_tier == null ? directTier : String(row.parent_tier);
	return {
		id: String(row.id),
		key: String(row.incident_key),
		status: String(row.status),
		severity: String(row.severity),
		family: String(row.family),
		familyLabel: familyLabel(String(row.family)),
		assetId: String(row.asset_id),
		assetName: row.asset_name == null ? null : String(row.asset_name),
		parentId: row.parent_id == null ? null : String(row.parent_id),
		scope: row.scope == null ? row.family === "durable_objects" ? "object" : "resource" : String(row.scope),
		tier,
		tags,
		metric,
		metricLabel: metricLabel(metric),
		unit,
		windowMs,
		observed: Number(row.observed),
		threshold: row.threshold_value == null ? null : Number(row.threshold_value),
		expected: row.expected == null ? null : Number(row.expected),
		reason: String(row.reason),
		proposedAction: String(row.proposed_action),
		firstSeen: Number(row.first_seen),
		lastSeen: Number(row.last_seen),
		occurrences: Number(row.occurrences),
		action: row.action_id == null ? null : {
			id: String(row.action_id),
			state: String(row.action_state),
			kind: String(row.action_kind)
		},
		cloudflareUrl: cloudflareUrl(String(row.account_id), String(row.family))
	};
}
function spendView(rows, coverage, now) {
	const rolling = rows.filter((row) => row.metric === "rolling_24h_cost_usd");
	const projected = rows.filter((row) => row.metric === "projected_daily_cost_usd");
	const preferred = rolling.length > 0 ? rolling : projected;
	const latestByFamily = /* @__PURE__ */ new Map();
	for (const row of preferred) {
		const current = latestByFamily.get(String(row.family));
		if (!current || Number(row.end_at) > Number(current.end_at)) latestByFamily.set(String(row.family), row);
	}
	const categories = [...latestByFamily.entries()].map(([family, row]) => ({
		family,
		label: familyLabel(family),
		estimatedUsd: Number(row.value),
		updatedAt: Number(row.end_at),
		coverage: coverage.some((item) => item.family === family && item.state === "healthy") ? "healthy" : "partial"
	})).sort((a, b) => b.estimatedUsd - a.estimatedUsd);
	const bucketMap = /* @__PURE__ */ new Map();
	for (const row of preferred) {
		const bucket = Math.floor(Number(row.end_at) / 9e5) * 9e5;
		const family = String(row.family);
		const values = bucketMap.get(bucket) ?? /* @__PURE__ */ new Map();
		values.set(family, Number(row.value));
		bucketMap.set(bucket, values);
	}
	const history = [...bucketMap.entries()].sort((a, b) => a[0] - b[0]).slice(-96).map(([at, values]) => ({
		at,
		totalUsd: [...values.values()].reduce((sum, value) => sum + value, 0),
		categories: Object.fromEntries(values)
	}));
	const latestAt = categories.reduce((latest, item) => Math.max(latest, item.updatedAt), 0) || null;
	return {
		label: rolling.length > 0 ? "Estimated usage · rolling 24 hours" : "Projected daily usage at current rate",
		estimatedTotalUsd: categories.reduce((sum, item) => sum + item.estimatedUsd, 0),
		categories,
		history,
		updatedAt: latestAt,
		authoritative: false,
		stale: latestAt === null || now - latestAt > 12e5,
		note: "Gross estimate from fast telemetry. Included usage, discounts, and invoice adjustments are not applied."
	};
}
function readPolicy(value) {
	if (!value) return DEFAULT_POLICY;
	try {
		return JSON.parse(value);
	} catch {
		return DEFAULT_POLICY;
	}
}
function parseJson(value) {
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}
function countBy(items, key) {
	const result = {};
	for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
	return result;
}
function incidentWindow(key) {
	const value = Number(key.split(":").at(-1));
	return Number.isFinite(value) && value >= 6e4 ? value : null;
}
function inferredUnit(metric) {
	if (metric.includes("cost") || metric.includes("spend")) return "usd";
	if (metric.includes("rows")) return "rows";
	if (metric.includes("request")) return "requests";
	if (metric.includes("bytes")) return "bytes";
	return "count";
}
function metricLabel(metric) {
	return {
		rows_read: "Rows read",
		rows_written: "Rows written",
		requests: "Requests",
		duration_gb_seconds: "Compute duration",
		incoming_websocket_messages: "Incoming WebSocket messages",
		kv_read_units: "Legacy storage read units",
		kv_write_units: "Legacy storage write units",
		kv_delete_requests: "Legacy storage deletes",
		sql_storage_bytes: "SQLite stored data",
		kv_storage_bytes: "Legacy stored data",
		projected_daily_cost_usd: "Projected daily cost",
		account_daily_billed_cost_usd: "Daily billed cost"
	}[metric] ?? metric.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}
function familyLabel(family) {
	return {
		durable_objects: "Durable Objects",
		workers: "Workers",
		workers_ai: "Workers AI",
		ai_gateway: "AI Gateway",
		d1: "D1",
		r2: "R2",
		kv: "Workers KV",
		queues: "Queues",
		vectorize: "Vectorize",
		hyperdrive: "Hyperdrive",
		pages: "Pages",
		zones: "Zones",
		images: "Images",
		stream: "Stream",
		billing: "Billing"
	}[family] ?? family.replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase());
}
function cloudflareUrl(accountId, family) {
	return `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/${{
		durable_objects: "workers/durable-objects",
		workers: "workers-and-pages",
		queues: "workers/queues",
		d1: "workers/d1",
		r2: "r2/overview",
		kv: "workers/kv/namespaces",
		vectorize: "vectorize",
		hyperdrive: "workers/hyperdrive",
		pages: "workers-and-pages",
		ai_gateway: "ai/ai-gateway"
	}[family] ?? "home"}`;
}
//#endregion
//#region src/configuration.ts
var API$1 = "https://api.cloudflare.com/client/v4";
var VERIFICATION_PREFIX = "configuration_verification:";
var MAX_WORKERS_PER_REFRESH = 5;
var MAX_BUNDLE_SCAN_BYTES = 1e6;
var RUNTIME_MARKER = "BROLLY_QUARANTINED";
async function configurationData(env) {
	const [assetResult, verificationResult] = await Promise.all([env.DB.prepare(`SELECT family,asset_id,name,scope,tier,metadata_json,seen_at FROM assets
       WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace')
       ORDER BY family,name,asset_id LIMIT 2500`).all(), env.DB.prepare(`SELECT key,value FROM settings WHERE key LIKE 'configuration_verification:%' LIMIT 2500`).all()]);
	const verifications = /* @__PURE__ */ new Map();
	for (const row of verificationResult.results) try {
		verifications.set(row.key.slice(27), JSON.parse(row.value));
	} catch {}
	const workerRows = assetResult.results.filter((row) => row.family === "workers");
	const namespaceRows = assetResult.results.filter((row) => row.family === "durable_objects");
	const namespacesByWorker = /* @__PURE__ */ new Map();
	for (const namespace of namespaceRows) {
		const owner = parseTags(namespace.metadata_json).cloudflareWorkerScript;
		if (owner) namespacesByWorker.set(owner, [...namespacesByWorker.get(owner) ?? [], namespace]);
	}
	const workers = workerRows.map((row) => {
		const tags = parseTags(row.metadata_json);
		const verification = verifications.get(row.asset_id);
		const declaredInstalled = tags.brollyFuse === "true";
		const mappedNamespaces = namespacesByWorker.get(row.asset_id) ?? [];
		const checks = {
			inventory: pass("Discovered", "Worker script is present in the latest Brolly inventory."),
			declared: declaredInstalled ? pass("Guard confirmed", "An operator confirmed that brollyWorker(env) is placed before application work.") : unknown("Guard not confirmed", "Monitoring works, but precise Worker shutdown is not enabled until the ingress guard is confirmed."),
			apiAccess: verification?.checks.apiAccess ?? unknown("Not refreshed", "Refresh this Worker to test Cloudflare API access."),
			fuseSecret: verification?.checks.fuseSecret ?? unknown("Not refreshed", "Refresh this Worker to check for BROLLY_FUSE."),
			runtimeBundle: verification?.checks.runtimeBundle ?? unknown("Not refreshed", "Refresh this Worker to inspect the deployed bundle for the Brolly runtime marker."),
			activeDeployment: verification?.checks.activeDeployment ?? unknown("Not refreshed", "Refresh this Worker to identify the active deployment.")
		};
		return {
			id: row.asset_id,
			name: row.name ?? row.asset_id,
			tier: row.tier,
			tags,
			seenAt: row.seen_at,
			declaredInstalled,
			namespaceCount: mappedNamespaces.length,
			checkedAt: verification?.checkedAt ?? null,
			deploymentId: verification?.deploymentId ?? null,
			versionId: verification?.versionId ?? null,
			status: overallWorkerStatus(declaredInstalled, checks),
			checks
		};
	});
	const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
	const namespaces = namespaceRows.map((row) => {
		const tags = parseTags(row.metadata_json);
		const discoveredOwner = tags.cloudflareWorkerScript;
		const owner = discoveredOwner;
		const ownerWorker = owner ? workerMap.get(owner) : void 0;
		const constructorConfirmed = tags.brollyFuse === "true";
		const checks = {
			inventory: pass("Discovered", "Durable Object namespace is present in Cloudflare inventory."),
			owner: owner ? pass("Owner mapped", `Cloudflare associates this namespace with ${owner}.`) : unknown("Owner unknown", "Cloudflare did not return an owning Worker. Brolly will not accept a manual override."),
			constructor: constructorConfirmed ? pass("Constructor confirmed", "An operator confirmed brollyDurableObject(ctx, env) is installed for this namespace.") : unknown("Constructor not confirmed", "The namespace remains alert-only until the constructor guard is confirmed."),
			worker: ownerWorker?.status === "configured" ? pass("Owning Worker configured", `${owner} has live fuse and runtime evidence.`) : ownerWorker ? unknown("Owning Worker incomplete", `${owner} is ${ownerWorker.status.replaceAll("_", " ")}.`) : unknown("Worker not inventoried", owner ? `${owner} was not found in the Worker inventory.` : "Map an owning Worker first.")
		};
		const status = constructorConfirmed && ownerWorker?.status === "configured" ? "configured" : constructorConfirmed || Boolean(owner) || ownerWorker?.status === "partial" ? "partial" : "not_configured";
		return {
			id: row.asset_id,
			name: row.name ?? row.asset_id,
			tier: row.tier,
			tags,
			seenAt: row.seen_at,
			className: tags.durableObjectClass ?? null,
			storage: tags.durableObjectStorage ?? null,
			ownerWorker: owner ?? null,
			declaredOwner: null,
			discoveredOwner: discoveredOwner ?? null,
			status,
			checks
		};
	});
	const configuredWorkers = workers.filter((item) => item.status === "configured").length;
	const configuredNamespaces = namespaces.filter((item) => item.status === "configured").length;
	return {
		generatedAt: Date.now(),
		connected: !env.BROLLY_ACCOUNT_ID.startsWith("REPLACE_"),
		summary: {
			workers: workers.length,
			configuredWorkers,
			namespaces: namespaces.length,
			configuredNamespaces,
			partial: [...workers, ...namespaces].filter((item) => item.status === "partial").length,
			needsAttention: [...workers, ...namespaces].filter((item) => item.status === "error").length,
			lastVerifiedAt: workers.reduce((latest, item) => item.checkedAt && (!latest || item.checkedAt > latest) ? item.checkedAt : latest, null)
		},
		workers,
		namespaces
	};
}
async function refreshConfiguration(env, workerScripts) {
	const scripts = [...new Set(workerScripts.map((value) => value.trim()).filter(Boolean))];
	if (!scripts.length) throw new Error("Choose at least one Worker to refresh");
	if (scripts.length > MAX_WORKERS_PER_REFRESH) throw new Error(`Refresh at most ${MAX_WORKERS_PER_REFRESH} Workers per request`);
	for (const script of scripts) if (!/^[A-Za-z0-9_-]+$/.test(script)) throw new Error(`Invalid Worker script name: ${script}`);
	const now = Date.now();
	const lease = await env.DB.prepare(`INSERT INTO cron_lease(name,holder,expires_at) VALUES('configuration-refresh',?1,?2)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?3`).bind(crypto.randomUUID(), now + 55e3, now).run();
	if (Number(lease.meta.changes ?? 0) !== 1) throw new Error("A configuration refresh already ran in the last minute. Cached evidence is shown until the cooldown ends.");
	const known = await env.DB.prepare(`SELECT asset_id FROM assets WHERE account_id=?1 AND family='workers' AND scope='resource' LIMIT 2500`).bind(env.BROLLY_ACCOUNT_ID).all();
	const knownScripts = new Set(known.results.map((row) => row.asset_id));
	for (const script of scripts) if (!knownScripts.has(script)) throw new Error(`Worker is not in Brolly inventory: ${script}`);
	let token;
	try {
		token = await operationalToken(env);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		for (const script of scripts) await saveVerification(env, unavailableVerification(script, detail));
		return configurationData(env);
	}
	for (let index = 0; index < scripts.length; index += 3) await Promise.all(scripts.slice(index, index + 3).map(async (script) => {
		await saveVerification(env, await verifyWorker(env, token, script));
	}));
	return configurationData(env);
}
async function verifyWorker(env, token, workerScript) {
	const script = encodeURIComponent(workerScript);
	const [secretResult, deploymentResult, bundleResult] = await Promise.allSettled([
		api(token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/secrets`),
		api(token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}/deployments`),
		scanWorkerBundle(token, `/accounts/${env.BROLLY_ACCOUNT_ID}/workers/scripts/${script}`)
	]);
	const firstError = [
		secretResult,
		deploymentResult,
		bundleResult
	].find((result) => result.status === "rejected");
	const apiAccess = firstError ? errorCheck("Cloudflare check failed", firstError.reason) : pass("API access verified", "Brolly read secrets, deployments, and the deployed Worker bundle.");
	const hasFuse = (secretResult.status === "fulfilled" ? secretResult.value : []).some((secret) => secret.name === "BROLLY_FUSE" && secret.type === "secret_text");
	const active = (deploymentResult.status === "fulfilled" ? deploymentResult.value.deployments ?? [] : [])[0];
	const version = active?.versions?.find((item) => item.percentage === 100)?.version_id ?? active?.versions?.[0]?.version_id;
	const bundle = bundleResult.status === "fulfilled" ? bundleResult.value : null;
	return {
		workerScript,
		checkedAt: Date.now(),
		deploymentId: active?.id,
		versionId: version,
		checks: {
			apiAccess,
			fuseSecret: secretResult.status === "rejected" ? errorCheck("Secret check failed", secretResult.reason) : hasFuse ? pass("Fuse secret present", "The deployed Worker has a secret_text binding named BROLLY_FUSE.") : fail("Fuse secret missing", "Initialize BROLLY_FUSE before enabling shutdown controls."),
			runtimeBundle: bundleResult.status === "rejected" ? errorCheck("Bundle check failed", bundleResult.reason) : bundle?.found ? pass("Runtime detected", "The deployed Worker bundle contains the Brolly quarantine marker.") : bundle?.truncated ? unknown("Bundle scan bounded", `No marker was found in the first ${MAX_BUNDLE_SCAN_BYTES.toLocaleString()} bytes.`) : fail("Runtime not detected", "The active Worker bundle does not contain the Brolly runtime marker."),
			activeDeployment: deploymentResult.status === "rejected" ? errorCheck("Deployment check failed", deploymentResult.reason) : active ? pass("Active deployment found", version ? `Deployment ${active.id} is serving version ${version}.` : `Deployment ${active.id} is active.`) : fail("No active deployment", "Cloudflare returned no active deployment for this Worker.")
		}
	};
}
async function scanWorkerBundle(token, path) {
	const response = await fetch(`${API$1}${path}`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(1e4)
	});
	if (!response.ok) throw new Error(`Cloudflare bundle check failed (${response.status}): ${await response.text()}`);
	if (!response.body) return {
		found: (await response.text()).includes(RUNTIME_MARKER),
		truncated: false
	};
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let scanned = 0;
	let tail = "";
	while (scanned < MAX_BUNDLE_SCAN_BYTES) {
		const { done, value } = await reader.read();
		if (done) return {
			found: tail.includes(RUNTIME_MARKER),
			truncated: false
		};
		scanned += value.byteLength;
		const text = tail + decoder.decode(value, { stream: true });
		if (text.includes(RUNTIME_MARKER)) {
			await reader.cancel();
			return {
				found: true,
				truncated: false
			};
		}
		tail = text.slice(-17);
	}
	await reader.cancel();
	return {
		found: false,
		truncated: true
	};
}
async function api(token, path) {
	const response = await fetch(`${API$1}${path}`, {
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json"
		},
		signal: AbortSignal.timeout(1e4)
	});
	if (!response.ok) throw new Error(`Cloudflare returned ${response.status}: ${await response.text()}`);
	const payload = await response.json();
	if (!payload.success) throw new Error(payload.errors?.map((item) => item.message).join("; ") ?? "Cloudflare verification failed");
	return payload.result;
}
async function saveVerification(env, verification) {
	await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(`${VERIFICATION_PREFIX}${verification.workerScript}`, JSON.stringify(verification), verification.checkedAt).run();
}
function unavailableVerification(workerScript, detail) {
	const check = error("Cloudflare unavailable", detail);
	return {
		workerScript,
		checkedAt: Date.now(),
		checks: {
			apiAccess: check,
			fuseSecret: check,
			runtimeBundle: check,
			activeDeployment: check
		}
	};
}
function overallWorkerStatus(declaredInstalled, checks) {
	if (Object.values(checks).some((check) => check.state === "error")) return "error";
	if (declaredInstalled && checks.fuseSecret?.state === "pass" && checks.runtimeBundle?.state === "pass" && checks.activeDeployment?.state === "pass") return "configured";
	if (declaredInstalled || Object.values(checks).some((check) => check.state === "pass" && check.label !== "Discovered")) return "partial";
	return "not_configured";
}
function parseTags(value) {
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}
function pass(label, detail) {
	return {
		state: "pass",
		label,
		detail
	};
}
function fail(label, detail) {
	return {
		state: "fail",
		label,
		detail
	};
}
function unknown(label, detail) {
	return {
		state: "unknown",
		label,
		detail
	};
}
function error(label, detail) {
	return {
		state: "error",
		label,
		detail
	};
}
function errorCheck(label, cause) {
	return error(label, cause instanceof Error ? cause.message : String(cause));
}
//#endregion
//#region src/auth.ts
var AUTHORIZATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
var TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
var USERINFO_ENDPOINT = "https://dash.cloudflare.com/oauth2/userinfo";
var API = "https://api.cloudflare.com/client/v4";
var OAUTH_STATE_TTL_MS = 6e5;
var SESSION_TTL_MS = 432e5;
var SESSION_COOKIE = "brolly_session";
var STATE_COOKIE = "brolly_oauth_state";
var BROLLY_OAUTH_SCOPES = [
	"offline_access",
	"user-details.read",
	"memberships.read",
	"account-settings.read",
	"account-analytics.read",
	"workers-scripts.read",
	"workers-scripts.write",
	"workers-kv-storage.read",
	"workers-r2.read",
	"d1.read",
	"queues.read",
	"queues.write",
	"vectorize.read",
	"query-cache.read",
	"page.read",
	"aig.read",
	"zone.read"
];
async function authRoute(request, env) {
	const url = new URL(request.url);
	if (url.pathname === "/api/auth/login" && request.method === "GET") return beginLogin(request, env);
	if (url.pathname === "/api/auth/callback" && request.method === "GET") return finishLogin(request, env);
	if (url.pathname === "/api/auth/relay/verify" && request.method === "GET") return verifyRelay(request, env);
	if (url.pathname === "/api/auth/session" && request.method === "GET") return sessionStatus(request, env);
	if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout(request, env);
	return null;
}
async function authenticate(request, env) {
	const authorization = request.headers.get("authorization");
	if (env.BROLLY_ADMIN_TOKEN && authorization === `Bearer ${env.BROLLY_ADMIN_TOKEN}`) return {
		kind: "break_glass",
		actor: "break-glass-token"
	};
	const token = cookie(request, SESSION_COOKIE);
	if (!token) return null;
	const tokenHash = await sha256(token);
	const now = Date.now();
	const row = await env.DB.prepare(`SELECT user_id,email,display_name,account_id,expires_at FROM auth_sessions WHERE token_hash=?1 LIMIT 1`).bind(tokenHash).first();
	if (!row || row.expires_at <= now) return null;
	if (!safeMutationOrigin(request)) return null;
	if (now % 3e5 < 1e4) await env.DB.prepare(`UPDATE auth_sessions SET last_seen_at=?2 WHERE token_hash=?1`).bind(tokenHash, now).run();
	return {
		kind: "session",
		actor: row.email ?? row.display_name ?? row.user_id,
		accountId: row.account_id
	};
}
async function configuredEnv(env, actor) {
	const accountId = actor?.accountId ?? await configuredAccountId(env);
	return accountId ? {
		...env,
		BROLLY_ACCOUNT_ID: accountId
	} : null;
}
async function configuredAccountId(env) {
	const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='account_id' LIMIT 1`).first();
	if (row?.value) return row.value;
	if (env.BROLLY_ACCOUNT_ID && !env.BROLLY_ACCOUNT_ID.startsWith("REPLACE_")) return env.BROLLY_ACCOUNT_ID;
	return null;
}
async function beginLogin(request, env) {
	if (!oauthReady(env)) return oauthConfigurationError(env);
	const origin = new URL(request.url).origin;
	const state = `${randomToken(32)}.${encodeText(origin)}`;
	const verifier = randomToken(48);
	const challenge = encodeBytes(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	const redirectUri = oauthRedirectUri(env);
	const now = Date.now();
	await env.DB.batch([env.DB.prepare(`DELETE FROM oauth_states WHERE expires_at < ?1`).bind(now), env.DB.prepare(`INSERT INTO oauth_states(state_hash,verifier,redirect_uri,created_at,expires_at) VALUES(?1,?2,?3,?4,?5)`).bind(await sha256(state), verifier, redirectUri, now, now + OAUTH_STATE_TTL_MS)]);
	const authorization = new URL(AUTHORIZATION_ENDPOINT);
	authorization.search = new URLSearchParams({
		response_type: "code",
		client_id: oauthClientId(env),
		redirect_uri: redirectUri,
		scope: BROLLY_OAUTH_SCOPES.join(" "),
		state,
		code_challenge: challenge,
		code_challenge_method: "S256"
	}).toString();
	return new Response(null, {
		status: 302,
		headers: {
			location: authorization.toString(),
			"set-cookie": serializeCookie(STATE_COOKIE, state, request, OAUTH_STATE_TTL_MS),
			"cache-control": "no-store"
		}
	});
}
async function verifyRelay(request, env) {
	const url = new URL(request.url);
	const state = url.searchParams.get("state") ?? "";
	if (decodeStateOrigin(state) !== url.origin) return Response.json({ error: "Invalid OAuth origin" }, { status: 400 });
	const row = await env.DB.prepare(`SELECT expires_at FROM oauth_states WHERE state_hash=?1 LIMIT 1`).bind(await sha256(state)).first();
	if (!row || row.expires_at <= Date.now()) return Response.json({ error: "Unknown or expired OAuth state" }, { status: 404 });
	return Response.json({ callbackUrl: new URL("/api/auth/callback", url.origin).toString() }, { headers: { "cache-control": "no-store" } });
}
async function finishLogin(request, env) {
	if (!oauthReady(env)) return oauthConfigurationError(env);
	if (!env.BROLLY_CREDENTIAL_KEY) return htmlError("BROLLY_CREDENTIAL_KEY is missing. Add it as a Worker secret before connecting Cloudflare.", 503);
	const url = new URL(request.url);
	const state = url.searchParams.get("state") ?? "";
	const stateCookie = cookie(request, STATE_COOKIE);
	if (!state || !stateCookie || !constantTimeEqual(state, stateCookie)) return htmlError("Cloudflare login state did not match this browser. Start again from Brolly.", 400);
	const stateHash = await sha256(state);
	const row = await env.DB.prepare(`SELECT verifier,redirect_uri,expires_at FROM oauth_states WHERE state_hash=?1 LIMIT 1`).bind(stateHash).first();
	await env.DB.prepare(`DELETE FROM oauth_states WHERE state_hash=?1`).bind(stateHash).run();
	if (!row || row.expires_at <= Date.now()) return htmlError("Cloudflare login expired. Start again from Brolly.", 400);
	const oauthError = url.searchParams.get("error");
	const code = url.searchParams.get("code");
	if (oauthError || !code) return htmlError(oauthError || "Cloudflare did not return an authorization code.", 400);
	const tokenResponse = await fetch(TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: oauthClientId(env),
			code,
			redirect_uri: row.redirect_uri,
			code_verifier: row.verifier
		}),
		signal: AbortSignal.timeout(1e4)
	});
	if (!tokenResponse.ok) return htmlError(`Cloudflare token exchange failed (${tokenResponse.status}).`, 502);
	const oauth = await tokenResponse.json();
	if (!hasRenewableAccess(oauth)) return htmlError("Cloudflare did not grant Brolly ongoing access. Return to Brolly and reconnect, making sure ongoing access is approved.", 502);
	const [user, accounts] = await Promise.all([fetchJson(USERINFO_ENDPOINT, oauth.access_token), cloudflare(oauth.access_token, "/accounts")]);
	if (!user.sub) return htmlError("Cloudflare did not return a stable user identity.", 502);
	if (accounts.length !== 1) return htmlError(accounts.length === 0 ? "No Cloudflare account was authorized. Start again and choose the account Brolly should protect." : "Brolly requires one account per installation. Start again and authorize exactly one Cloudflare account.", 409);
	const account = accounts[0];
	const configured = await configuredAccountId(env);
	if (configured && configured !== account.id) return htmlError(`This Brolly instance protects a different Cloudflare account.`, 403);
	const now = Date.now();
	const credentials = await sealJson({
		accessToken: oauth.access_token,
		refreshToken: oauth.refresh_token,
		expiresAt: oauth.expires_in ? now + oauth.expires_in * 1e3 : void 0
	}, env.BROLLY_CREDENTIAL_KEY);
	const sessionToken = randomToken(32);
	const sessionHash = await sha256(sessionToken);
	await env.DB.prepare(`INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('account_id',?1,?2)`).bind(account.id, now).run();
	if (await configuredAccountId(env) !== account.id) return htmlError("Another administrator connected this Brolly instance to a different account while you were signing in.", 409);
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('account_name',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(account.name, now),
		env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('oauth_credentials',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(credentials, now),
		env.DB.prepare(`DELETE FROM settings WHERE key='onboarding_budget_estimates'`),
		env.DB.prepare(`INSERT INTO auth_sessions(token_hash,user_id,email,display_name,account_id,created_at,last_seen_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?6,?7)`).bind(sessionHash, user.sub, user.email ?? null, user.name ?? user.preferred_username ?? null, account.id, now, now + SESSION_TTL_MS),
		env.DB.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?1`).bind(now)
	]);
	const headers = new Headers({
		location: "/",
		"cache-control": "no-store"
	});
	headers.append("set-cookie", serializeCookie(SESSION_COOKIE, sessionToken, request, SESSION_TTL_MS));
	headers.append("set-cookie", serializeCookie(STATE_COOKIE, "", request, 0));
	return new Response(null, {
		status: 302,
		headers
	});
}
function hasRenewableAccess(oauth) {
	return Boolean(oauth.refresh_token?.trim());
}
async function sessionStatus(request, env) {
	const actor = await authenticate(request, env);
	const accountId = actor?.accountId ?? await configuredAccountId(env);
	const accountName = await env.DB.prepare(`SELECT value FROM settings WHERE key='account_name' LIMIT 1`).first();
	return Response.json({
		authenticated: Boolean(actor),
		oauthConfigured: oauthReady(env),
		credentialStorageReady: Boolean(env.BROLLY_CREDENTIAL_KEY),
		actor: actor ? {
			name: actor.actor,
			kind: actor.kind
		} : null,
		account: accountId ? {
			id: accountId,
			name: accountName?.value ?? accountId
		} : null
	}, { headers: { "cache-control": "no-store" } });
}
async function logout(request, env) {
	if (!safeMutationOrigin(request)) return Response.json({ error: "Invalid request origin" }, {
		status: 403,
		headers: { "cache-control": "no-store" }
	});
	const token = cookie(request, SESSION_COOKIE);
	if (token) await env.DB.prepare(`DELETE FROM auth_sessions WHERE token_hash=?1`).bind(await sha256(token)).run();
	return Response.json({ ok: true }, { headers: {
		"set-cookie": serializeCookie(SESSION_COOKIE, "", request, 0),
		"cache-control": "no-store"
	} });
}
function oauthReady(env) {
	return Boolean(oauthClientId(env) && oauthRedirectUri(env));
}
function oauthConfigurationError(_env) {
	return Response.json({
		error: "Cloudflare OAuth is not configured for this Brolly release.",
		detail: "This build does not contain Brolly's public OAuth client configuration."
	}, {
		status: 503,
		headers: { "cache-control": "no-store" }
	});
}
function safeMutationOrigin(request) {
	if ([
		"GET",
		"HEAD",
		"OPTIONS"
	].includes(request.method)) return true;
	return request.headers.get("origin") === new URL(request.url).origin;
}
function decodeStateOrigin(state) {
	const encoded = state.split(".")[1];
	if (!encoded) return null;
	try {
		const origin = new URL(decodeText(encoded));
		if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return null;
		if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname))) return null;
		return origin.origin;
	} catch {
		return null;
	}
}
function cookie(request, name) {
	const value = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
	return value ? decodeURIComponent(value.slice(name.length + 1)) : null;
}
function serializeCookie(name, value, request, ttlMs) {
	const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
	return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(ttlMs / 1e3))}${secure}`;
}
function constantTimeEqual(left, right) {
	const a = new TextEncoder().encode(left);
	const b = new TextEncoder().encode(right);
	if (a.length !== b.length) return false;
	let result = 0;
	for (let index = 0; index < a.length; index += 1) result |= a[index] ^ b[index];
	return result === 0;
}
async function sha256(value) {
	return encodeBytes(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
function randomToken(bytes) {
	return encodeBytes(crypto.getRandomValues(new Uint8Array(bytes)));
}
function encodeText(value) {
	return encodeBytes(new TextEncoder().encode(value));
}
function decodeText(value) {
	const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
	return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
function encodeBytes(value) {
	const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function fetchJson(url, token) {
	const response = await fetch(url, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(1e4)
	});
	if (!response.ok) throw new Error(`Cloudflare identity request failed (${response.status})`);
	return response.json();
}
async function cloudflare(token, path) {
	const response = await fetch(`${API}${path}`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(1e4)
	});
	const payload = await response.json();
	if (!response.ok || !payload.success) throw new Error(payload.errors?.map((error) => error.message).join("; ") ?? `Cloudflare returned ${response.status}`);
	return payload.result;
}
function htmlError(message, status) {
	const escaped = message.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;"
	})[character]);
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>Brolly sign-in</title><link rel="stylesheet" href="/assets/index.css"></head><body class="grid min-h-screen place-items-center bg-slate-50 p-6 text-slate-950 dark:bg-slate-950 dark:text-slate-100"><main class="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900"><p class="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-orange-700 dark:text-orange-400">Brolly · Cloudflare sign-in</p><h1 class="m-0 text-3xl font-bold tracking-tight">Cloudflare sign-in could not finish</h1><p class="mt-5 leading-7 text-slate-600 dark:text-slate-300">${escaped}</p><p class="mt-6"><a class="font-semibold text-orange-700 underline decoration-orange-300 underline-offset-4 hover:text-orange-800 dark:text-orange-400 dark:hover:text-orange-300" href="/">Return to Brolly</a></p></main></body></html>`, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff"
		}
	});
}
//#endregion
//#region src/budget-estimates.ts
var DAY_MS = 864e5;
var CACHE_MS$1 = 9e5;
var CACHE_KEY$1 = "onboarding_budget_estimates";
var LEASE_NAME$1 = "onboarding-budget-estimates";
var ESTIMATE_HEADROOM = {
	warning: 1.25,
	critical: 1.75,
	emergency: 2.5
};
var BudgetEstimateInProgressError = class extends Error {
	constructor() {
		super("A recent-usage estimate is already running. Try again in a few seconds.");
		this.name = "BudgetEstimateInProgressError";
	}
};
async function configureOnboardingBillingAccess(env, token) {
	const normalized = token.trim();
	const validationError = billingTokenValidationError(normalized);
	if (validationError) throw new Error(validationError);
	if (!env.BROLLY_CREDENTIAL_KEY) throw new Error("Brolly's credential-encryption key is unavailable");
	const budget = new RunBudget({
		apiCalls: 1,
		databaseRows: 10,
		samples: 1e4,
		wallMs: 1e4
	});
	const records = await new CloudflareClient({
		...env,
		CLOUDFLARE_BILLING_TOKEN: normalized
	}, budget).billingUsage(Date.now() - 2 * DAY_MS, Date.now()).catch((error) => {
		const detail = error instanceof Error ? error.message : String(error);
		if (/insufficient_permissions|permission|forbidden|unauthorized/i.test(detail)) throw new Error("Cloudflare rejected this token for billable usage. Create a user API token scoped to this account with Billing Read, then try again.");
		throw error;
	});
	if (!records) throw new Error("Cloudflare Billing Read access could not be verified");
	const now = Date.now();
	await env.DB.batch([env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('billing_credentials',?1,?2)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(await sealJson({ token: normalized }, env.BROLLY_CREDENTIAL_KEY), now), env.DB.prepare(`DELETE FROM settings WHERE key=?1`).bind(CACHE_KEY$1)]);
	return { records: records.length };
}
async function removeOnboardingBillingAccess(env) {
	await env.DB.batch([env.DB.prepare(`DELETE FROM settings WHERE key='billing_credentials'`), env.DB.prepare(`DELETE FROM settings WHERE key=?1`).bind(CACHE_KEY$1)]);
}
function validBillingToken(value) {
	return value.length >= 20 && value.length <= 256 && !/\s/.test(value);
}
function billingTokenValidationError(value) {
	if (value.startsWith("cfat_")) return "Cloudflare created an account-owned token, but its billable-usage API requires a user API token. Delete that token, click Create billing token again, and paste the new token that starts with cfut_.";
	return validBillingToken(value) ? null : "Enter a valid Cloudflare API token without spaces";
}
async function onboardingBudgetEstimates(env) {
	const now = Date.now();
	const cached = await env.DB.prepare(`SELECT value,updated_at FROM settings WHERE key=?1 LIMIT 1`).bind(CACHE_KEY$1).first();
	if (cached && cached.updated_at >= now - CACHE_MS$1) return {
		...JSON.parse(cached.value),
		cached: true
	};
	const holder = crypto.randomUUID();
	const lease = await env.DB.prepare(`INSERT INTO cron_lease(name,holder,expires_at) VALUES(?1,?2,?3)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?4`).bind(LEASE_NAME$1, holder, now + 3e4, now).run();
	if (Number(lease.meta.changes ?? 0) !== 1) throw new BudgetEstimateInProgressError();
	try {
		const windowEndAt = Date.now();
		const windowStartAt = windowEndAt - DAY_MS;
		const budget = new RunBudget({
			apiCalls: 4,
			databaseRows: 100,
			samples: 2e4,
			wallMs: 2e4
		});
		const client = new CloudflareClient(env, budget);
		const [durableObjects, workers, billingResult] = await Promise.all([
			client.durableObjectUsage(windowStartAt, windowEndAt),
			client.workerUsage(windowStartAt, windowEndAt),
			client.billingUsage(windowStartAt - DAY_MS, windowEndAt).then((records) => ({
				records,
				error: null
			})).catch((error) => ({
				records: null,
				error: error instanceof Error ? error.message : String(error)
			}))
		]);
		const result = buildOnboardingBudgetEstimates({
			generatedAt: Date.now(),
			windowStartAt,
			windowEndAt,
			samples: [...durableObjects.samples, ...workers.samples],
			billing: billingResult.records ?? [],
			coverage: [...durableObjects.coverage, ...workers.coverage],
			billingAccess: billingResult.error ? {
				state: "blocked",
				detail: `Cloudflare rejected the Billing Read check. Add or replace the read-only billing token below. Technical detail: ${billingResult.error}`
			} : billingResult.records ? {
				state: "connected",
				detail: "Brolly can compare its fast usage estimates with Cloudflare's daily billed charges for this account."
			} : {
				state: "not_configured",
				detail: "Brolly can monitor live activity, but it cannot yet compare those estimates with the charges on your Cloudflare bill. Add the read-only Billing token below."
			},
			apiCalls: budget.usage.apiCalls
		});
		await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(CACHE_KEY$1, JSON.stringify(result), result.generatedAt).run();
		return result;
	} finally {
		await env.DB.prepare(`DELETE FROM cron_lease WHERE name=?1 AND holder=?2`).bind(LEASE_NAME$1, holder).run();
	}
}
function buildOnboardingBudgetEstimates(input) {
	const analyticsFamilies = costBy(input.samples, (sample) => sample.asset.family);
	const analyticsAssets = costBy(input.samples, (sample) => {
		if (sample.asset.family === "workers" && sample.asset.scope === "resource") return assetBudgetKey(sample.asset);
		if (sample.asset.family === "durable_objects") {
			const namespaceId = sample.asset.scope === "namespace" ? sample.asset.id : sample.asset.parentId;
			if (namespaceId) return assetBudgetKey({
				family: "durable_objects",
				scope: "namespace",
				id: namespaceId
			});
		}
		return null;
	});
	const billingFamilies = /* @__PURE__ */ new Map();
	let billingAccountUsd = 0;
	const billingRows = input.billing ?? [];
	const latestBillingDay = Math.max(...billingRows.map((row) => Date.parse(row.ChargePeriodStart)).filter(Number.isFinite));
	for (const row of billingRows) {
		if (Date.parse(row.ChargePeriodStart) !== latestBillingDay) continue;
		const family = billingFamily(row);
		const cost = row.BilledCost ?? row.EffectiveCost ?? row.ListCost;
		if (!Number.isFinite(cost) || cost <= 0) continue;
		billingAccountUsd += cost;
		if (!family) continue;
		billingFamilies.set(family, (billingFamilies.get(family) ?? 0) + cost);
	}
	const families = {};
	for (const definition of METRIC_CATALOG) {
		const analytics = analyticsFamilies.get(definition.family) ?? 0;
		const billed = billingFamilies.get(definition.family) ?? 0;
		if (analytics > 0) families[definition.family] = suggestion(analytics, "analytics", input.samples.some((sample) => sample.asset.family === definition.family && sample.sampled));
		else if (billed > 0) families[definition.family] = suggestion(billed, "billing", false);
	}
	const assets = Object.fromEntries([...analyticsAssets.entries()].filter(([, observed]) => observed > 0).map(([key, observed]) => [key, suggestion(observed, "analytics", false)]));
	const observedAnalyticsAccountUsd = Object.values(families).reduce((sum, item) => sum + item.observedUsd, 0);
	const hasCompleteBilling = input.billingAccess?.state === "connected" && billingAccountUsd > 0;
	const observedAccountUsd = hasCompleteBilling ? billingAccountUsd : observedAnalyticsAccountUsd;
	const account = observedAccountUsd > 0 ? suggestion(observedAccountUsd, hasCompleteBilling ? "billing" : "analytics", !hasCompleteBilling) : null;
	return {
		generatedAt: input.generatedAt,
		windowStartAt: input.windowStartAt,
		windowEndAt: input.windowEndAt,
		cached: false,
		apiCalls: input.apiCalls ?? 0,
		headroom: ESTIMATE_HEADROOM,
		account,
		families,
		assets,
		unchangedFamilies: METRIC_CATALOG.map((item) => item.family).filter((family) => !families[family]),
		access: {
			workers: accessFor("workers", input.coverage ?? []),
			durable_objects: accessFor("durable_objects", input.coverage ?? []),
			billing: input.billingAccess ?? {
				state: "unknown",
				detail: "Billing access was not checked."
			}
		}
	};
}
function accessFor(family, coverage) {
	const relevant = coverage.filter((item) => item.family === family);
	if (!relevant.length) return {
		state: "unknown",
		detail: "No usage response was returned."
	};
	const healthy = relevant.filter((item) => item.state === "healthy").length;
	const delayed = relevant.filter((item) => item.state === "delayed").length;
	const failures = relevant.filter((item) => item.state === "unavailable" || item.state === "permission_denied");
	const detail = [...new Set(failures.map((item) => item.detail).filter((value) => Boolean(value)))].slice(0, 2).join(" ");
	if (healthy === relevant.length) return {
		state: "connected",
		detail: family === "durable_objects" ? "Brolly can monitor requests, compute time, WebSocket messages, SQL rows, and storage for individual Durable Objects and namespaces. Nothing else is needed." : "Brolly can monitor this service at the most detailed level Cloudflare provides. Nothing else is needed."
	};
	if (healthy > 0 || delayed > 0) return {
		state: "limited",
		detail: detail || "Some usage signals are available, but one or more are delayed or unavailable."
	};
	return {
		state: "blocked",
		detail: detail || "Cloudflare did not return the requested usage signals. Reconnect Brolly and verify account permissions."
	};
}
function costBy(samples, keyFor) {
	const costs = /* @__PURE__ */ new Map();
	for (const sample of samples) {
		const key = keyFor(sample);
		const cost = sample.estimatedCostUsd;
		if (!key || !Number.isFinite(cost) || cost <= 0) continue;
		costs.set(key, (costs.get(key) ?? 0) + cost);
	}
	return costs;
}
function suggestion(observedUsd, source, partial) {
	const warning = roundBudget(observedUsd * ESTIMATE_HEADROOM.warning);
	const critical = roundBudget(Math.max(observedUsd * ESTIMATE_HEADROOM.critical, warning + budgetStep(warning)));
	return {
		observedUsd,
		limits: {
			warning,
			critical,
			emergency: roundBudget(Math.max(observedUsd * ESTIMATE_HEADROOM.emergency, critical + budgetStep(critical)))
		},
		source,
		partial
	};
}
function roundBudget(value) {
	const step = budgetStep(value);
	return Number((Math.ceil(value / step) * step).toFixed(2));
}
function budgetStep(value) {
	if (value < 1) return .01;
	if (value < 10) return .1;
	if (value < 100) return 1;
	if (value < 1e3) return 5;
	return 25;
}
function billingFamily(row) {
	const value = `${row.x_ProductFamilyId ?? ""} ${row.x_ProductFamilyName ?? ""} ${row.x_BillableMetricId ?? ""} ${row.x_BillableMetricName ?? ""}`.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ");
	return [
		["durable_objects", /durable object/],
		["workers_ai", /workers ai|ai inference/],
		["ai_gateway", /ai gateway/],
		["kv", /workers kv|key value/],
		["d1", /\bd1\b/],
		["r2", /\br2\b/],
		["queues", /\bqueue/],
		["vectorize", /vectorize/],
		["hyperdrive", /hyperdrive/],
		["pages", /cloudflare pages|pages build/],
		["images", /cloudflare images|image transformation/],
		["stream", /cloudflare stream|stream video/],
		["workers", /\bworkers?\b/]
	].find(([, pattern]) => pattern.test(value))?.[0] ?? null;
}
//#endregion
//#region src/release.ts
var BROLLY_RELEASE = "7ca18094b332cd2c50ec37fdaa44745997682aed";
//#endregion
//#region src/updates.ts
var RELEASE_URL = "https://raw.githubusercontent.com/standardagents/brolly/deploy-template/brolly-release.json";
var CACHE_KEY = "brolly_release_cache";
var REPOSITORY_KEY = "update_repository";
var LEASE_NAME = "release-check";
var CACHE_MS = 36e5;
var FETCH_TIMEOUT_MS = 5e3;
var MAX_MANIFEST_BYTES = 8192;
async function releaseStatus(env) {
	const now = Date.now();
	const [cacheRow, repositoryRow] = await Promise.all([env.DB.prepare(`SELECT value,updated_at FROM settings WHERE key=?1 LIMIT 1`).bind(CACHE_KEY).first(), env.DB.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`).bind(REPOSITORY_KEY).first()]);
	const repository = repositoryRow?.value && validRepository(repositoryRow.value) ? repositoryRow.value : null;
	const cached = parseCache(cacheRow?.value);
	if (cached && now - cached.checkedAt < CACHE_MS) return toStatus(cached, repository, Boolean(cached.error), false);
	const holder = crypto.randomUUID();
	if (((await env.DB.prepare(`INSERT INTO cron_lease(name,holder,expires_at) VALUES(?1,?2,?3)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?4`).bind(LEASE_NAME, holder, now + 2e4, now).run()).meta.changes ?? 0) === 0) return cached ? toStatus(cached, repository, true, true) : emptyStatus(repository, {
		checking: true,
		stale: true
	});
	try {
		const next = {
			manifest: await fetchReleaseManifest(),
			checkedAt: Date.now()
		};
		await saveCache(env.DB, next);
		return toStatus(next, repository, false, false);
	} catch (cause) {
		const error = cause instanceof Error ? cause.message : String(cause);
		const failed = {
			manifest: cached?.manifest,
			checkedAt: Date.now(),
			error
		};
		await saveCache(env.DB, failed);
		return toStatus(failed, repository, true, false);
	} finally {
		await env.DB.prepare(`DELETE FROM cron_lease WHERE name=?1 AND holder=?2`).bind(LEASE_NAME, holder).run();
	}
}
async function saveUpdateRepository(env, repository) {
	const normalized = repository.trim();
	if (normalized && !validRepository(normalized)) throw new Error("Use a GitHub repository in owner/repository format");
	if (!normalized) {
		await env.DB.prepare(`DELETE FROM settings WHERE key=?1`).bind(REPOSITORY_KEY).run();
		return null;
	}
	await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(REPOSITORY_KEY, normalized, Date.now()).run();
	return normalized;
}
function parseReleaseManifest(value) {
	if (!value || typeof value !== "object") throw new Error("Brolly release manifest is not an object");
	const manifest = value;
	if (manifest.schemaVersion !== 1 || manifest.configVersion !== 1 || manifest.workflowFile !== "brolly-update.yml") throw new Error("Brolly release manifest uses an unsupported format");
	if (typeof manifest.release !== "string" || !/^[a-f0-9]{40}$/.test(manifest.release)) throw new Error("Brolly release identifier is invalid");
	if (typeof manifest.displayVersion !== "string" || !/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-f0-9]{7}$/.test(manifest.displayVersion)) throw new Error("Brolly release version is invalid");
	if (typeof manifest.publishedAt !== "string" || !Number.isFinite(Date.parse(manifest.publishedAt))) throw new Error("Brolly release date is invalid");
	if (typeof manifest.notesUrl !== "string") throw new Error("Brolly release notes URL is missing");
	const notesUrl = new URL(manifest.notesUrl);
	if (notesUrl.protocol !== "https:" || notesUrl.hostname !== "github.com" || !notesUrl.pathname.startsWith("/standardagents/brolly/")) throw new Error("Brolly release notes URL is not trusted");
	return manifest;
}
function validRepository(value) {
	if (value.length > 200 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return false;
	return value.split("/").every((segment) => segment !== "." && segment !== "..");
}
async function fetchReleaseManifest() {
	const response = await fetch(RELEASE_URL, {
		headers: {
			accept: "application/json",
			"user-agent": "brolly-release-check"
		},
		redirect: "manual",
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!response.ok) throw new Error(`Release check returned HTTP ${response.status}`);
	if (response.type === "opaqueredirect" || response.status >= 300) throw new Error("Release check refused an unexpected redirect");
	if (Number(response.headers.get("content-length") ?? "0") > MAX_MANIFEST_BYTES) throw new Error("Release manifest is unexpectedly large");
	const text = await response.text();
	if (new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) throw new Error("Release manifest is unexpectedly large");
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Release manifest is not valid JSON");
	}
	return parseReleaseManifest(value);
}
function parseCache(value) {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		if (typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt)) return null;
		const manifest = parsed.manifest === void 0 ? void 0 : parseReleaseManifest(parsed.manifest);
		const error = typeof parsed.error === "string" ? parsed.error : void 0;
		return {
			checkedAt: parsed.checkedAt,
			manifest,
			error
		};
	} catch {
		return null;
	}
}
function toStatus(cache, repository, stale, checking) {
	if (!cache.manifest) return emptyStatus(repository, {
		checkedAt: cache.checkedAt,
		stale,
		checking,
		...cache.error ? { error: cache.error } : {}
	});
	return {
		currentRelease: BROLLY_RELEASE,
		latestRelease: cache.manifest.release,
		displayVersion: cache.manifest.displayVersion,
		publishedAt: cache.manifest.publishedAt,
		notesUrl: cache.manifest.notesUrl,
		available: cache.manifest.release !== BROLLY_RELEASE,
		checkedAt: cache.checkedAt,
		stale,
		checking,
		repository,
		updateUrl: repository ? `https://github.com/${repository}/actions/workflows/${cache.manifest.workflowFile}` : null,
		...cache.error ? { error: cache.error } : {}
	};
}
async function saveCache(db, cache) {
	await db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(CACHE_KEY, JSON.stringify(cache), cache.checkedAt).run();
}
function emptyStatus(repository, extra) {
	return {
		currentRelease: BROLLY_RELEASE,
		latestRelease: null,
		displayVersion: null,
		publishedAt: null,
		notesUrl: null,
		available: false,
		checkedAt: null,
		stale: false,
		checking: false,
		repository,
		updateUrl: repository ? `https://github.com/${repository}/actions/workflows/brolly-update.yml` : null,
		...extra
	};
}
//#endregion
//#region src/index.ts
var src_default = {
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil((async () => {
			const activeEnv = await configuredEnv(env);
			if (activeEnv) await runMonitor(activeEnv);
		})());
	},
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/health") return Response.json({
			ok: true,
			service: "brolly-guard"
		});
		const authResponse = await authRoute(request, env);
		if (authResponse) return authResponse;
		const actor = await authenticate(request, env);
		if (!actor) return Response.json({ error: "Sign in with Cloudflare" }, { status: 401 });
		const activeEnv = await configuredEnv(env, actor);
		if (!activeEnv) return Response.json({ error: "Choose one Cloudflare account during sign-in before using Brolly" }, { status: 409 });
		env = activeEnv;
		if (url.pathname === "/api/dashboard" && request.method === "GET") return Response.json(await dashboardData(env));
		if (url.pathname === "/api/releases" && request.method === "GET") return Response.json(await releaseStatus(env), { headers: { "cache-control": "no-store" } });
		if (url.pathname === "/api/update-settings" && request.method === "PUT") {
			const body = await request.json();
			try {
				const repository = await saveUpdateRepository(env, body.repository ?? "");
				await audit(env.DB, actor.actor, "updates.repository", repository ?? "", { repository });
				return Response.json({
					ok: true,
					repository
				});
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
			}
		}
		if (url.pathname === "/api/assets" && request.method === "GET") return Response.json(await assetList(request, env));
		if (url.pathname === "/api/configuration" && request.method === "GET") return Response.json(await configurationData(env));
		if (url.pathname === "/api/configuration/verify" && request.method === "POST") {
			const body = await request.json();
			try {
				const result = await refreshConfiguration(env, body.workerScripts ?? []);
				await audit(env.DB, "admin", "configuration.verify", body.workerScripts?.join(",") ?? "", { workers: body.workerScripts?.length ?? 0 });
				return Response.json(result);
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
			}
		}
		if (url.pathname === "/api/onboarding" && request.method === "GET") return Response.json(await onboardingData(env));
		if (url.pathname === "/api/onboarding/estimates" && request.method === "POST") try {
			return Response.json(await onboardingBudgetEstimates(env), { headers: { "cache-control": "no-store" } });
		} catch (error) {
			return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof BudgetEstimateInProgressError ? 429 : 400 });
		}
		if (url.pathname === "/api/onboarding/billing-access" && request.method === "PUT") {
			const body = await request.json();
			try {
				const result = await configureOnboardingBillingAccess(env, body.token ?? "");
				await audit(env.DB, actor.actor, "billing_access.configure", env.BROLLY_ACCOUNT_ID, {
					verified: true,
					records: result.records
				});
				return Response.json({
					ok: true,
					...result
				});
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
			}
		}
		if (url.pathname === "/api/onboarding/billing-access" && request.method === "DELETE") {
			if (env.CLOUDFLARE_BILLING_TOKEN) return Response.json({ error: "Billing access is supplied as a Worker secret and must be removed in Cloudflare" }, { status: 409 });
			await removeOnboardingBillingAccess(env);
			await audit(env.DB, actor.actor, "billing_access.remove", env.BROLLY_ACCOUNT_ID, {});
			return Response.json({ ok: true });
		}
		if (url.pathname === "/api/onboarding" && request.method === "POST") {
			const body = await request.json();
			if (!validPolicy(body.policy, true)) return Response.json({ error: "Every account, product, resource, and object limit must be finite, nonnegative, and ordered warning ≤ critical ≤ emergency" }, { status: 400 });
			const scopedAssets = await env.DB.prepare(`SELECT family,asset_id,scope,metadata_json FROM assets WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace') LIMIT 2500`).all();
			const missingScopedBudgets = scopedAssets.results.filter((asset) => !body.policy.assetDailySpend?.[assetBudgetKey({
				family: asset.family,
				scope: asset.scope,
				id: asset.asset_id
			})]);
			if (missingScopedBudgets.length) return Response.json({ error: `Set limits for every discovered Worker and Durable Object namespace (${missingScopedBudgets.length} missing)` }, { status: 400 });
			const now = Date.now();
			const knownAssets = new Map(scopedAssets.results.map((asset) => [`${asset.family}:${asset.asset_id}`, asset]));
			const integrationStatements = [];
			for (const integration of body.integrations ?? []) {
				const asset = knownAssets.get(`${integration.family}:${integration.id}`);
				if (!asset) return Response.json({ error: `Unknown runtime integration target ${integration.family}/${integration.id}` }, { status: 400 });
				const workerScript = integration.workerScript?.trim();
				if (workerScript && !/^[A-Za-z0-9_-]+$/.test(workerScript)) return Response.json({ error: `Invalid Worker script name for ${integration.id}` }, { status: 400 });
				let tags;
				try {
					tags = JSON.parse(asset.metadata_json || "{}");
				} catch {
					tags = {};
				}
				const discoveredWorker = integration.family === "workers" ? integration.id : tags.cloudflareWorkerScript;
				if (workerScript && discoveredWorker && workerScript !== discoveredWorker) return Response.json({ error: `Cloudflare maps ${integration.id} to ${discoveredWorker}, not ${workerScript}` }, { status: 409 });
				delete tags.workerScript;
				if (integration.installed && discoveredWorker) tags.brollyFuse = "true";
				else delete tags.brollyFuse;
				integrationStatements.push(env.DB.prepare(`UPDATE assets SET metadata_json=?3,seen_at=?4 WHERE family=?1 AND asset_id=?2 AND account_id=?5`).bind(integration.family, integration.id, JSON.stringify(tags), now, env.BROLLY_ACCOUNT_ID));
			}
			await env.DB.batch([env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('policy',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(JSON.stringify(body.policy), now), env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('onboarding_complete','true',?1) ON CONFLICT(key) DO UPDATE SET value='true',updated_at=excluded.updated_at`).bind(now)]);
			for (let index = 0; index < integrationStatements.length; index += 100) await env.DB.batch(integrationStatements.slice(index, index + 100));
			await audit(env.DB, "admin", "onboarding.complete", body.policy.version, {
				mode: body.policy.mode,
				families: Object.keys(body.policy.familyDailySpend ?? {}).length,
				scopedAssets: Object.keys(body.policy.assetDailySpend ?? {}).length,
				runtimeIntegrations: body.integrations?.filter((item) => item.installed).length ?? 0,
				thresholds: body.policy.thresholds.length
			});
			return Response.json({
				ok: true,
				policy: body.policy
			});
		}
		if (url.pathname === "/api/status" && request.method === "GET") {
			const [incidentRows, coverageRow, assetRow, sampleRow] = await Promise.all([
				env.DB.prepare(`SELECT severity,family,asset_id,reason,observed,last_seen FROM incidents WHERE status='open' AND metric!='telemetry_coverage' ORDER BY CASE severity WHEN 'emergency' THEN 0 WHEN 'critical' THEN 1 ELSE 2 END,last_seen DESC LIMIT 100`).all(),
				env.DB.prepare(`SELECT SUM(CASE WHEN state!='healthy' THEN 1 ELSE 0 END) AS c,MAX(checked_at) AS at FROM metric_coverage`).first(),
				env.DB.prepare(`SELECT COUNT(*) AS c FROM assets`).first(),
				env.DB.prepare(`SELECT MAX(end_at) AS at FROM metric_samples`).first()
			]);
			return Response.json({
				openIncidents: incidentRows.results.length,
				coverageGaps: coverageRow?.c ?? 0,
				assets: assetRow?.c ?? 0,
				lastCheckAt: coverageRow?.at ?? null,
				lastSampleAt: sampleRow?.at ?? null,
				incidents: incidentRows.results
			});
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
			const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first();
			return Response.json(row ? JSON.parse(row.value) : DEFAULT_POLICY);
		}
		if (url.pathname === "/api/policy" && request.method === "PUT") {
			const policy = await request.json();
			if (!validPolicy(policy)) return Response.json({ error: "Invalid policy" }, { status: 400 });
			await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('policy',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(JSON.stringify(policy), Date.now()).run();
			await audit(env.DB, "admin", "policy.update", policy.version, {
				mode: policy.mode,
				thresholds: policy.thresholds.length
			});
			return Response.json({
				ok: true,
				policy
			});
		}
		if (url.pathname === "/api/actions" && request.method === "POST") {
			const body = await request.json();
			const incident = await env.DB.prepare(`SELECT * FROM incidents WHERE id=?1 LIMIT 1`).bind(body.incidentId).first();
			if (!incident) return Response.json({ error: "Incident not found" }, { status: 404 });
			const incidentError = executableIncidentError(incident);
			if (incidentError) return Response.json({ error: incidentError }, { status: 409 });
			const existingAction = await env.DB.prepare(`SELECT id,state FROM actions WHERE incident_id=?1 AND state IN ('prepared','running','succeeded','failed') ORDER BY created_at DESC LIMIT 1`).bind(body.incidentId).first();
			if (existingAction) return Response.json({
				error: `This incident already has an active ${existingAction.state} action`,
				actionId: existingAction.id
			}, { status: 409 });
			const assetRow = await env.DB.prepare(`SELECT * FROM assets WHERE account_id=?1 AND family=?2 AND asset_id=?3 LIMIT 1`).bind(incident.account_id, incident.family, incident.asset_id).first();
			const asset = await assetFromRows(env, incident, assetRow);
			if (asset.tier === "control_plane" || asset.tier === "critical" || asset.tier === "unclassified") return Response.json({ error: `Asset tier ${asset.tier} requires classification/override before a stop can be prepared` }, { status: 409 });
			const now = Date.now();
			const id = crypto.randomUUID();
			const configuredWorkerScript = asset.tags?.brollyFuse === "true" ? authoritativeWorkerScript(asset) : void 0;
			const kind = asset.family === "queues" ? "pause_consumer" : "runtime_quarantine";
			if (!(asset.family === "queues" ? kind === "pause_consumer" : asset.family === "workers" ? kind === "runtime_quarantine" : asset.family === "durable_objects" ? kind === "runtime_quarantine" : false)) return Response.json({ error: `Control ${kind} is not valid for ${asset.family}` }, { status: 400 });
			if (kind === "runtime_quarantine" && !configuredWorkerScript) return Response.json({ error: "A verified Cloudflare-owned Worker mapping and Brolly fuse are required" }, { status: 409 });
			const action = {
				id,
				incidentId: body.incidentId,
				asset,
				kind,
				state: "prepared",
				reason: String(incident.reason),
				observed: { [String(incident.metric)]: Number(incident.observed) },
				rollback: {
					...configuredWorkerScript ? { workerScript: configuredWorkerScript } : {},
					action: "resume"
				},
				actor: actor.actor,
				createdAt: now
			};
			await env.DB.prepare(`INSERT INTO actions(id,incident_id,idempotency_key,account_id,family,asset_id,kind,state,reason,observed_json,rollback_json,actor,created_at,updated_at)
         VALUES(?1,?2,?1,?3,?4,?5,?6,'prepared',?7,?8,?9,?10,?11,?11)`).bind(id, body.incidentId, asset.accountId, asset.family, asset.id, action.kind, action.reason, JSON.stringify(action.observed), JSON.stringify(action.rollback), actor.actor, now).run();
			await audit(env.DB, actor.actor, "action.prepare", id, action);
			if (!body.execute) return Response.json({
				ok: true,
				action
			}, { status: 201 });
			return runAction(env, action, { workerScript: configuredWorkerScript }, "quarantine");
		}
		const actionMatch = url.pathname.match(/^\/api\/actions\/([^/]+)\/(execute|resume)$/);
		if (actionMatch && request.method === "POST") {
			const id = actionMatch[1];
			const row = await env.DB.prepare(`SELECT * FROM actions WHERE id=?1 LIMIT 1`).bind(id).first();
			if (!row) return Response.json({ error: "Action not found" }, { status: 404 });
			const rollback = JSON.parse(String(row.rollback_json));
			const assetRow = await env.DB.prepare(`SELECT * FROM assets WHERE account_id=?1 AND family=?2 AND asset_id=?3 LIMIT 1`).bind(row.account_id, row.family, row.asset_id).first();
			const action = {
				id: String(row.id),
				incidentId: String(row.incident_id),
				asset: await assetFromRows(env, row, assetRow),
				kind: row.kind,
				state: row.state,
				reason: String(row.reason),
				observed: JSON.parse(String(row.observed_json)),
				rollback,
				actor: actor.actor,
				createdAt: Number(row.created_at)
			};
			if (action.kind === "disable_trigger") return Response.json({ error: "Legacy route controls are retired and cannot be executed or restored by Brolly" }, { status: 409 });
			const workerScript = authoritativeWorkerScript(action.asset);
			if (row.kind === "runtime_quarantine" && !workerScript) return Response.json({ error: "An authoritative owning Worker and deployment fuse are required; legacy callback controls are retired" }, { status: 409 });
			if (rollback.workerScript && workerScript !== rollback.workerScript) return Response.json({ error: "The authoritative Worker mapping changed after this action was prepared; prepare a new action" }, { status: 409 });
			return runAction(env, action, { workerScript }, actionMatch[2] === "resume" ? "resume" : "quarantine");
		}
		if (url.pathname === "/api/targets" && request.method === "GET") {
			const result = await env.DB.prepare(`SELECT t.id,t.kind,t.enabled,t.minimum_severity,t.created_at,t.updated_at,
          (SELECT d.created_at FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY d.created_at DESC LIMIT 1) AS last_delivery_at,
          (SELECT d.ok FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY d.created_at DESC LIMIT 1) AS last_delivery_ok,
          (SELECT d.error FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY d.created_at DESC LIMIT 1) AS last_delivery_error
         FROM notification_targets t ORDER BY t.created_at ASC LIMIT 50`).all();
			return Response.json({
				targets: result.results.map((row) => ({
					id: String(row.id),
					kind: String(row.kind),
					enabled: Number(row.enabled) === 1,
					minimumSeverity: String(row.minimum_severity),
					createdAt: Number(row.created_at),
					updatedAt: Number(row.updated_at),
					lastDeliveryAt: row.last_delivery_at == null ? null : Number(row.last_delivery_at),
					lastDeliveryOk: row.last_delivery_ok == null ? null : Number(row.last_delivery_ok) === 1,
					lastDeliveryError: row.last_delivery_error == null ? null : String(row.last_delivery_error)
				})),
				credentialStorageReady: Boolean(env.BROLLY_CREDENTIAL_KEY)
			});
		}
		if (url.pathname === "/api/targets" && request.method === "POST") {
			const body = await request.json();
			if (![
				"discord",
				"slack",
				"resend",
				"postmark",
				"twilio"
			].includes(body.kind)) return Response.json({ error: "Invalid notification target kind" }, { status: 400 });
			if (![
				"info",
				"warning",
				"critical",
				"emergency"
			].includes(body.minimumSeverity ?? "warning")) return Response.json({ error: "Invalid minimum severity" }, { status: 400 });
			const configError = validateNotificationConfig(body.kind, body.config);
			if (configError) return Response.json({ error: configError }, { status: 400 });
			if (!env.BROLLY_CREDENTIAL_KEY) return Response.json({ error: "BROLLY_CREDENTIAL_KEY is required; target credentials will never be stored in plaintext" }, { status: 503 });
			const id = body.id ?? crypto.randomUUID();
			const now = Date.now();
			await env.DB.prepare(`INSERT INTO notification_targets(id,kind,config_json,enabled,minimum_severity,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,config_json=excluded.config_json,enabled=excluded.enabled,minimum_severity=excluded.minimum_severity,updated_at=excluded.updated_at`).bind(id, body.kind, await sealJson(body.config, env.BROLLY_CREDENTIAL_KEY), body.enabled === false ? 0 : 1, body.minimumSeverity ?? "warning", now).run();
			await audit(env.DB, "admin", "notification_target.upsert", id, { kind: body.kind });
			return Response.json({
				ok: true,
				id
			});
		}
		const targetMatch = url.pathname.match(/^\/api\/targets\/([^/]+)$/);
		if (targetMatch && request.method === "PATCH") {
			const body = await request.json();
			if (body.minimumSeverity !== void 0 && ![
				"info",
				"warning",
				"critical",
				"emergency"
			].includes(body.minimumSeverity)) return Response.json({ error: "Invalid minimum severity" }, { status: 400 });
			if (body.enabled === void 0 && body.minimumSeverity === void 0) return Response.json({ error: "No target change supplied" }, { status: 400 });
			const id = decodeURIComponent(targetMatch[1]);
			if (((await env.DB.prepare(`UPDATE notification_targets SET enabled=COALESCE(?2,enabled),minimum_severity=COALESCE(?3,minimum_severity),updated_at=?4 WHERE id=?1`).bind(id, body.enabled === void 0 ? null : body.enabled ? 1 : 0, body.minimumSeverity ?? null, Date.now()).run()).meta.changes ?? 0) === 0) return Response.json({ error: "Notification target not found" }, { status: 404 });
			await audit(env.DB, "admin", "notification_target.update", id, body);
			return Response.json({
				ok: true,
				id
			});
		}
		const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/([^/]+)$/);
		if (assetMatch && request.method === "PATCH") {
			const body = await request.json();
			if (![
				"control_plane",
				"critical",
				"standard",
				"disposable",
				"unclassified"
			].includes(body.tier)) return Response.json({ error: "Invalid asset tier" }, { status: 400 });
			const family = decodeURIComponent(assetMatch[1]);
			const id = decodeURIComponent(assetMatch[2]);
			const current = await env.DB.prepare(`SELECT tier,metadata_json FROM assets WHERE account_id=?1 AND family=?2 AND asset_id=?3 LIMIT 1`).bind(env.BROLLY_ACCOUNT_ID, family, id).first();
			if (!current) return Response.json({ error: "Asset not found" }, { status: 404 });
			if (current.tier === "control_plane" && body.tier !== "control_plane") return Response.json({ error: "Control-plane protection is immutable" }, { status: 409 });
			if (isBrollyWorker(env, family, id) && body.tier !== "control_plane") return Response.json({ error: "Brolly cannot remove protection from its own Worker" }, { status: 409 });
			if (body.tags && (Object.hasOwn(body.tags, "workerScript") || Object.hasOwn(body.tags, "cloudflareWorkerScript"))) return Response.json({ error: "Worker ownership is discovered from Cloudflare and cannot be overridden" }, { status: 400 });
			if (((await env.DB.prepare(`UPDATE assets SET tier=?4,metadata_json=json_patch(metadata_json,?5),name=COALESCE(?6,name),seen_at=?7 WHERE account_id=?1 AND family=?2 AND asset_id=?3`).bind(env.BROLLY_ACCOUNT_ID, family, id, body.tier, JSON.stringify(body.tags ?? {}), body.name ?? null, Date.now()).run()).meta.changes ?? 0) === 0) return Response.json({ error: "Asset not found" }, { status: 404 });
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
	}
};
async function runAction(env, action, control, requested) {
	if (requested === "quarantine") {
		const incidentError = executableIncidentError(await env.DB.prepare(`SELECT severity,status,last_seen FROM incidents WHERE id=?1 LIMIT 1`).bind(action.incidentId).first());
		if (incidentError) return Response.json({ error: incidentError }, { status: 409 });
		if ([
			"control_plane",
			"critical",
			"unclassified"
		].includes(action.asset.tier)) return Response.json({ error: `Asset is now protected as ${action.asset.tier}; prepare a new action after reviewing its classification` }, { status: 409 });
	}
	const expectedState = requested === "resume" ? "succeeded" : "prepared or failed";
	const claimed = requested === "resume" ? await env.DB.prepare(`UPDATE actions SET state='running',error=NULL,updated_at=?3 WHERE id=?1 AND state=?2`).bind(action.id, "succeeded", Date.now()).run() : await env.DB.prepare(`UPDATE actions SET state='running',error=NULL,updated_at=?2 WHERE id=?1 AND state IN ('prepared','failed')`).bind(action.id, Date.now()).run();
	if (Number(claimed.meta.changes ?? 0) !== 1) return Response.json({ error: `Action is ${action.state}; ${requested} requires ${expectedState}` }, { status: 409 });
	await audit(env.DB, action.actor, `action.${requested}.start`, action.id, {
		...control,
		kind: action.kind
	});
	try {
		let detail = JSON.stringify({ ok: true });
		if (action.kind === "runtime_quarantine") {
			if (!control.workerScript) throw new Error("A deployment-fuse Worker mapping is required");
			detail = JSON.stringify(await executeDeploymentFuseControl(env, action, control.workerScript, requested));
		} else if (requested === "resume") await rollbackCloudflareControl(env, action);
		else {
			const rollback = await prepareCloudflareControl(env, action);
			action.rollback = rollback;
			await env.DB.prepare(`UPDATE actions SET rollback_json=?2,updated_at=?3 WHERE id=?1`).bind(action.id, JSON.stringify(rollback), Date.now()).run();
			await audit(env.DB, "admin", "action.rollback_snapshot", action.id, rollback);
			await executeCloudflareControl(env, action);
			detail = JSON.stringify({
				ok: true,
				rollback
			});
		}
		await env.DB.prepare(`UPDATE actions SET state=?2,error=NULL,updated_at=?3 WHERE id=?1`).bind(action.id, requested === "resume" ? "rolled_back" : "succeeded", Date.now()).run();
		await audit(env.DB, action.actor, `action.${requested}.succeeded`, action.id, { response: detail.slice(0, 4e3) });
		return new Response(detail, {
			status: 200,
			headers: { "content-type": "application/json" }
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await env.DB.prepare(`UPDATE actions SET state=?2,error=?3,updated_at=?4 WHERE id=?1`).bind(action.id, requested === "resume" ? "succeeded" : "failed", message.slice(0, 2e3), Date.now()).run();
		await audit(env.DB, action.actor, `action.${requested}.failed`, action.id, { error: message.slice(0, 2e3) });
		return Response.json({
			error: message,
			actionId: action.id
		}, { status: 502 });
	}
}
var ACTION_INCIDENT_MAX_AGE_MS = 18e5;
function executableIncidentError(incident) {
	if (!incident) return "The source incident no longer exists; no control was applied";
	if (String(incident.severity) !== "emergency") return "Only an active emergency incident can authorize a shutdown action";
	if (!["open", "acknowledged"].includes(String(incident.status))) return "The source incident is resolved; no control was applied";
	const lastSeen = Number(incident.last_seen);
	if (!Number.isFinite(lastSeen) || lastSeen < Date.now() - ACTION_INCIDENT_MAX_AGE_MS) return "The source incident is stale; run a fresh scan and prepare a new action";
	return null;
}
async function assetFromRows(env, primary, asset) {
	let tags = {};
	try {
		tags = JSON.parse(String(asset?.metadata_json ?? "{}"));
	} catch {}
	let parentTier;
	if (asset?.parent_id != null && String(primary.family) === "durable_objects") {
		const parent = await env.DB.prepare(`SELECT tier,metadata_json FROM assets WHERE account_id=?1 AND family='durable_objects' AND asset_id=?2 LIMIT 1`).bind(String(primary.account_id), String(asset.parent_id)).first();
		if (parent) {
			let parentTags = {};
			try {
				parentTags = JSON.parse(parent.metadata_json || "{}");
			} catch {}
			tags = {
				...parentTags,
				...tags
			};
			parentTier = parent.tier;
		}
	}
	const directTier = asset?.tier ?? "unclassified";
	return {
		accountId: String(primary.account_id),
		family: String(primary.family),
		id: String(primary.asset_id),
		parentId: asset?.parent_id == null ? void 0 : String(asset.parent_id),
		name: asset?.name == null ? void 0 : String(asset.name),
		scope: asset?.scope ?? (primary.family === "durable_objects" ? "object" : "resource"),
		tier: directTier !== "unclassified" ? directTier : parentTier ?? directTier,
		tags
	};
}
function authoritativeWorkerScript(asset) {
	if (asset.family === "workers" && asset.scope === "resource") return asset.id;
	if (asset.family === "durable_objects" && asset.scope === "object") return asset.tags?.cloudflareWorkerScript;
}
function isBrollyWorker(env, family, id) {
	if (family !== "workers") return false;
	return id === (env.BROLLY_SELF_WORKER_NAME ?? "brolly-guard") || id === "brolly-guard" || id.startsWith("brolly-guard-");
}
function validateNotificationConfig(kind, config) {
	if (!config || typeof config !== "object") return "Notification configuration is required";
	const present = (key) => typeof config[key] === "string" && String(config[key]).trim().length > 0;
	if ((kind === "discord" || kind === "slack") && !present("url")) return `${kind} webhook URL is required`;
	if (kind === "discord" || kind === "slack") {
		let url;
		try {
			url = new URL(String(config.url));
		} catch {
			return `${kind} webhook URL is invalid`;
		}
		if (url.protocol !== "https:" || url.username || url.password || url.port) return `${kind} webhook must use a standard HTTPS URL`;
		if (kind === "discord" && !["discord.com", "discordapp.com"].includes(url.hostname)) return "Discord webhooks must use discord.com";
		if (kind === "discord" && !url.pathname.startsWith("/api/webhooks/")) return "Discord webhook path is invalid";
		if (kind === "slack" && url.hostname !== "hooks.slack.com") return "Slack webhooks must use hooks.slack.com";
		if (kind === "slack" && !url.pathname.startsWith("/services/")) return "Slack webhook path is invalid";
	}
	if (kind === "twilio" && ![
		"accountSid",
		"token",
		"from",
		"to"
	].every(present)) return "Twilio account SID, auth token, from number, and destination number are required";
	if (kind === "resend" && ![
		"apiKey",
		"from",
		"to"
	].every(present)) return "Resend API key, from address, and destination address are required";
	if (kind === "postmark" && ![
		"token",
		"from",
		"to"
	].every(present)) return "Postmark token, from address, and destination address are required";
	return null;
}
async function audit(db, actor, action, target, detail) {
	await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
}
function validPolicy(policy, requireEveryFamily = false) {
	const finiteNonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
	if (![
		"observe",
		"approval",
		"automatic"
	].includes(policy?.mode) || typeof policy?.version !== "string" || !policy.version || !Array.isArray(policy.thresholds)) return false;
	const spend = policy.accountDailySpend;
	if (!spend || !finiteNonnegative(spend.warning) || !finiteNonnegative(spend.critical) || !finiteNonnegative(spend.emergency) || spend.warning > spend.critical || spend.critical > spend.emergency) return false;
	const familySpend = policy.familyDailySpend ?? {};
	if (requireEveryFamily && METRIC_CATALOG.some((definition) => !familySpend[definition.family])) return false;
	if (Object.values(familySpend).some((limit) => !finiteNonnegative(limit?.warning) || !finiteNonnegative(limit?.critical) || !finiteNonnegative(limit?.emergency) || limit.warning > limit.critical || limit.critical > limit.emergency)) return false;
	if (Object.values(policy.assetDailySpend ?? {}).some((limit) => !finiteNonnegative(limit?.warning) || !finiteNonnegative(limit?.critical) || !finiteNonnegative(limit?.emergency) || limit.warning > limit.critical || limit.critical > limit.emergency)) return false;
	return policy.thresholds.every((threshold) => typeof threshold.metric === "string" && !!threshold.metric && finiteNonnegative(threshold.windowMs) && threshold.windowMs > 0 && [
		threshold.warning,
		threshold.critical,
		threshold.emergency,
		threshold.minimumBaselineSamples,
		threshold.anomalyMultiplier
	].every((value) => value === void 0 || finiteNonnegative(value)) && (threshold.warning === void 0 || threshold.critical === void 0 || threshold.warning <= threshold.critical) && (threshold.critical === void 0 || threshold.emergency === void 0 || threshold.critical <= threshold.emergency) && (threshold.warning === void 0 || threshold.emergency === void 0 || threshold.warning <= threshold.emergency));
}
//#endregion
//#region \0virtual:cloudflare/worker-entry
var worker_entry_default = src_default ?? {};
//#endregion
export { worker_entry_default as default, executableIncidentError, validateNotificationConfig };
