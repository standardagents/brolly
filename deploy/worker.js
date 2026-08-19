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
	databaseRows: 1e5,
	samples: 1e5,
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
var METRIC_CATALOG_VERSION = "2026-08-17";
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
		fastSource: "graphql",
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
		fastSource: "graphql",
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
		family: "containers",
		metrics: [
			"vcpu_seconds",
			"memory_gb_seconds",
			"disk_gb_seconds",
			"egress_bytes"
		],
		preferredScope: "resource",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "browser_rendering",
		metrics: ["sessions", "session_minutes"],
		preferredScope: "account",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "workflows",
		metrics: [
			"requests",
			"cpu_ms",
			"steps",
			"storage_bytes"
		],
		preferredScope: "resource",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "worker_builds",
		metrics: ["build_minutes"],
		preferredScope: "account",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "analytics_engine",
		metrics: [
			"data_points_written",
			"data_points_read",
			"queries",
			"storage_bytes"
		],
		preferredScope: "resource",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "log_explorer",
		metrics: [
			"ingested_bytes",
			"queries",
			"storage_bytes"
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
	},
	{
		family: "email",
		metrics: ["sent", "routed"],
		preferredScope: "zone",
		fastSource: "graphql",
		billingSource: true
	},
	{
		family: "unknown",
		metrics: ["authoritative_usage", "authoritative_cost_usd"],
		preferredScope: "account",
		fastSource: null,
		billingSource: true
	}
];
var DISPLAY_NAMES = {
	cpu_ms: "CPU time",
	duration_gb_seconds: "Duration",
	incoming_websocket_messages: "Incoming WebSocket messages",
	rows_read: "Rows read",
	rows_written: "Rows written",
	storage_bytes: "Storage",
	egress_bytes: "Egress",
	cost_usd: "Provider cost",
	authoritative_cost_usd: "Authoritative cost"
};
var MAXIMUM_METRICS = /* @__PURE__ */ new Set([
	"storage_bytes",
	"sql_storage_bytes",
	"kv_storage_bytes",
	"stored_dimensions"
]);
var USAGE_METRIC_DEFINITIONS = METRIC_CATALOG.flatMap((product) => product.metrics.map((metricKey) => ({
	id: `${product.family}:${metricKey}`,
	productFamily: product.family,
	metricKey,
	displayName: DISPLAY_NAMES[metricKey] ?? metricKey.replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase()),
	unit: metricUnit(metricKey),
	aggregationKind: MAXIMUM_METRICS.has(metricKey) ? "maximum" : "sum",
	billingMapping: product.billingSource ? metricKey : null,
	collectorKey: product.fastSource ? `${product.fastSource}:${product.family}` : "billing:catchall",
	finestScope: product.preferredScope,
	active: true
})));
var COST_METRIC_DEFINITIONS = [
	{
		id: "account:estimated_cost_usd",
		productFamily: "account",
		metricKey: "estimated_cost_usd",
		displayName: "Estimated cost",
		unit: "usd",
		aggregationKind: "sum",
		billingMapping: null,
		collectorKey: "ledger:cost",
		finestScope: "account",
		active: true
	},
	{
		id: "account:billed_cost_usd",
		productFamily: "account",
		metricKey: "billed_cost_usd",
		displayName: "Billed cost",
		unit: "usd",
		aggregationKind: "sum",
		billingMapping: "billed_cost",
		collectorKey: "billing:billable-usage",
		finestScope: "account",
		active: true
	},
	...METRIC_CATALOG.flatMap((product) => [{
		id: `${product.family}:estimated_cost_usd`,
		productFamily: product.family,
		metricKey: "estimated_cost_usd",
		displayName: "Estimated cost",
		unit: "usd",
		aggregationKind: "sum",
		billingMapping: null,
		collectorKey: "ledger:cost",
		finestScope: product.preferredScope,
		active: true
	}, {
		id: `${product.family}:billed_cost_usd`,
		productFamily: product.family,
		metricKey: "billed_cost_usd",
		displayName: "Billed cost",
		unit: "usd",
		aggregationKind: "sum",
		billingMapping: "billed_cost",
		collectorKey: "billing:billable-usage",
		finestScope: "product",
		active: true
	}])
];
var METRIC_DEFINITIONS = [...USAGE_METRIC_DEFINITIONS, ...COST_METRIC_DEFINITIONS];
function metricUnit(metric) {
	if (metric.includes("cost")) return "usd";
	if (metric.includes("gb_seconds")) return "gb_seconds";
	if (metric.includes("byte") || metric.includes("storage") || metric.includes("egress")) return "bytes";
	if (metric.includes("row")) return "rows";
	if (metric.includes("request")) return "requests";
	if (metric.includes("duration_gb")) return "gb_seconds";
	if (metric.includes("cpu") || metric.includes("minute") || metric.includes("second")) return "milliseconds";
	return "count";
}
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
	"containers",
	"browser_rendering",
	"workflows",
	"worker_builds",
	"analytics_engine",
	"log_explorer",
	"zones",
	"email",
	"unknown"
].map((family) => [family, {
	warning: 1,
	critical: 5,
	emergency: 10
}]));
var DEFAULT_POLICY = {
	version: "2026-08-09.1",
	accountDailySpend: {
		warning: 5,
		critical: 12.5,
		emergency: 25
	},
	familyDailySpend: DEFAULT_FAMILY_DAILY_SPEND,
	assetDailySpend: {},
	riskTolerance: {
		preset: "balanced",
		percentOfTypical: {
			warning: 150,
			critical: 350,
			emergency: 800
		},
		baseline: {
			computedAt: 0,
			windowDays: 90
		}
	},
	limits: {
		day: {},
		cycle: {}
	},
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
function assetBudgetKey(asset) {
	return `${asset.family}:${asset.scope}:${asset.id}`;
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
//#region ../../packages/core/dist/ledger.js
var QUALITY_RANK = {
	complete: 0,
	sampled: 1,
	partial: 2,
	stale: 3,
	missing: 4
};
function resourceId(accountId, productFamily, resourceType, cloudflareId) {
	return `${encodeURIComponent(accountId)}:${encodeURIComponent(productFamily)}:${encodeURIComponent(resourceType)}:${encodeURIComponent(cloudflareId)}`;
}
function resourceHashBucket(id) {
	return resourceHash(id) >>> 24;
}
function resourceHashSegment(id, bits = 4) {
	if (!Number.isInteger(bits) || bits < 1 || bits > 16) throw new TypeError("Shard segment bits must be between 1 and 16");
	return resourceHash(id) & (1 << bits) - 1;
}
function resourceHash(id) {
	let hash = 2166136261;
	for (let index = 0; index < id.length; index += 1) {
		hash ^= id.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}
function worstQuality(values) {
	return values.reduce((worst, value) => QUALITY_RANK[value] > QUALITY_RANK[worst] ? value : worst, "complete");
}
function localDayAt(timestamp, timeZone) {
	const parts = dateParts(timestamp, timeZone);
	return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}
function localDayBounds(localDay, timeZone) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDay);
	if (!match) throw new Error(`Invalid local day: ${localDay}`);
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const next = new Date(Date.UTC(year, month - 1, day + 1));
	return {
		start: zonedDateTimeToUtc({
			year,
			month,
			day,
			hour: 0,
			minute: 0,
			second: 0
		}, timeZone),
		end: zonedDateTimeToUtc({
			year: next.getUTCFullYear(),
			month: next.getUTCMonth() + 1,
			day: next.getUTCDate(),
			hour: 0,
			minute: 0,
			second: 0
		}, timeZone)
	};
}
function exactAutomaticActionEligible(evidence) {
	return evidence.ruleOptIn && evidence.quality === "complete" && evidence.sampleInterval === 1 && evidence.measurement === "usage" && evidence.fresh && !evidence.resource.excluded && evidence.resource.tier !== "control_plane" && evidence.resource.tier !== "critical" && evidence.resource.tier !== "unclassified" && evidence.resource.autoQuarantinePolicy !== "deny" && !evidence.parentDenied && !evidence.alreadyQuarantined && evidence.resource.controlCapability !== "none" && evidence.resource.runtimeFuseStatus === "verified" && evidence.confirmationSatisfied;
}
function selectAggregateContributor(candidates) {
	const eligible = candidates.filter((candidate) => candidate.eligible && candidate.latestIntervalValue >= 0 && candidate.periodValue >= 0 && candidate.rollingBaseline > 0 && (candidate.latestIntervalValue >= candidate.aggregateExcess * .5 || candidate.latestIntervalValue >= sumLatest(candidates) * .5) && candidate.latestIntervalValue >= candidate.rollingBaseline * 4);
	eligible.sort((left, right) => {
		if (left.crossedOwnEmergency !== right.crossedOwnEmergency) return left.crossedOwnEmergency ? -1 : 1;
		if (left.latestIntervalValue !== right.latestIntervalValue) return right.latestIntervalValue - left.latestIntervalValue;
		if (left.periodValue !== right.periodValue) return right.periodValue - left.periodValue;
		return left.resourceId.localeCompare(right.resourceId);
	});
	return eligible[0] ?? null;
}
function capacityDecision(usedBytes, capacityBytes) {
	if (!Number.isFinite(usedBytes) || usedBytes < 0 || !Number.isFinite(capacityBytes) || capacityBytes <= 0) throw new TypeError("Capacity inputs must be finite and nonnegative");
	const pressure = usedBytes / capacityBytes;
	return {
		pressure,
		warn: pressure >= .7,
		pauseBackfill: pressure >= .8,
		pruneIndividualHistory: pressure >= .9,
		targetBytes: Math.floor(capacityBytes * .8)
	};
}
function sumLatest(candidates) {
	return candidates.reduce((total, candidate) => total + Math.max(0, candidate.latestIntervalValue), 0);
}
function dateParts(timestamp, timeZone) {
	const formatted = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23"
	}).formatToParts(new Date(timestamp));
	const value = (type) => Number(formatted.find((part) => part.type === type)?.value ?? 0);
	return {
		year: value("year"),
		month: value("month"),
		day: value("day"),
		hour: value("hour"),
		minute: value("minute"),
		second: value("second")
	};
}
function zonedDateTimeToUtc(parts, timeZone) {
	const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	let candidate = desired;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const actual = dateParts(candidate, timeZone);
		const correction = desired - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
		candidate += correction;
		if (correction === 0) break;
	}
	return candidate;
}
function pad(value) {
	return String(value).padStart(2, "0");
}
//#endregion
//#region ../../packages/core/dist/ledger-budget.js
var DEFAULT_LEDGER_RUN_LIMITS = {
	graphqlQueries: 300,
	restRequests: 50,
	d1RowsRead: 1e5,
	d1RowsWritten: 5e4,
	pagesPerDataset: 30,
	resourcesPerTransaction: 500,
	retries: 3,
	backfillSlices: 4,
	wallMs: 45e3
};
var MAX_LEDGER_RUN_LIMITS = {
	graphqlQueries: 500,
	restRequests: 100,
	d1RowsRead: 25e4,
	d1RowsWritten: 1e5,
	pagesPerDataset: 50,
	resourcesPerTransaction: 1e3,
	retries: 5,
	backfillSlices: 12,
	wallMs: 55e3
};
/**
* Per-request budget for the one-shot onboarding import.  The import has a
* smaller Cloudflare request allowance than the recurring monitor so a fresh
* install cannot crowd out normal monitoring work.
*/
var INITIAL_INGESTION_LIMITS = {
	...MAX_LEDGER_RUN_LIMITS,
	graphqlQueries: 40,
	restRequests: 5,
	wallMs: 25e3
};
var LedgerBudgetExceededError = class extends Error {
	kind;
	used;
	limit;
	constructor(kind, used, limit) {
		super(`Ledger ${kind} budget exceeded (${used}/${limit})`);
		this.kind = kind;
		this.used = used;
		this.limit = limit;
		this.name = "LedgerBudgetExceededError";
	}
};
var LedgerRunBudget = class {
	usage = {
		graphqlQueries: 0,
		restRequests: 0,
		d1RowsRead: 0,
		d1RowsWritten: 0,
		pagesPerDataset: 0,
		resourcesPerTransaction: 0,
		retries: 0,
		backfillSlices: 0,
		wallMs: 0
	};
	limits;
	signal;
	startedAt = Date.now();
	controller = new AbortController();
	constructor(requested = {}) {
		this.limits = boundedLimits(requested);
		this.signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.limits.wallMs)]);
	}
	charge(kind, amount = 1) {
		if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`Invalid ${kind} charge`);
		this.checkpoint();
		this.usage[kind] += amount;
		if (this.usage[kind] > this.limits[kind]) this.trip(kind);
	}
	observePeak(kind, amount) {
		if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`Invalid ${kind} observation`);
		this.checkpoint();
		this.usage[kind] = Math.max(this.usage[kind], amount);
		if (this.usage[kind] > this.limits[kind]) this.trip(kind);
	}
	remaining(kind) {
		if (kind === "wallMs") return Math.max(0, this.limits.wallMs - (Date.now() - this.startedAt));
		return Math.max(0, this.limits[kind] - this.usage[kind]);
	}
	checkpoint() {
		this.usage.wallMs = Date.now() - this.startedAt;
		if (this.usage.wallMs > this.limits.wallMs || this.signal.aborted) this.trip("wallMs");
	}
	trip(kind) {
		this.controller.abort(`${kind} budget exceeded`);
		throw new LedgerBudgetExceededError(kind, this.usage[kind], this.limits[kind]);
	}
};
function boundedLimits(requested) {
	return Object.fromEntries(Object.entries(DEFAULT_LEDGER_RUN_LIMITS).map(([key, fallback]) => {
		const kind = key;
		const value = requested[kind] ?? fallback;
		if (!Number.isFinite(value) || value <= 0) throw new TypeError(`Invalid ${kind} limit`);
		return [kind, Math.min(value, MAX_LEDGER_RUN_LIMITS[kind])];
	}));
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
		if (!response.ok) return {
			targetId: target.id,
			ok: false,
			status: response.status,
			error: await response.text()
		};
		if (target.kind === "cloudflare_email") return cloudflareEmailResult(target, response);
		return {
			targetId: target.id,
			ok: true,
			status: response.status
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
		redirect: "error",
		headers: {
			"content-type": "application/json",
			...headers
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(1e4)
	});
	switch (target.kind) {
		case "discord": return {
			url: notificationWebhookUrl("discord", target.url).toString(),
			init: json({ content: summary })
		};
		case "slack": return {
			url: notificationWebhookUrl("slack", target.url).toString(),
			init: json({ text: summary })
		};
		case "webhook": return {
			url: notificationWebhookUrl("webhook", target.url).toString(),
			init: json({
				type: "brolly.incident",
				incident
			}, target.token ? { authorization: `Bearer ${target.token}` } : {})
		};
		case "resend": return {
			url: "https://api.resend.com/emails",
			init: json({
				from: required(target.from, "Resend from"),
				to: recipients(target.to, "Resend to"),
				subject: summary.slice(0, 150),
				text: summary
			}, { authorization: `Bearer ${required(target.token, "Resend token")}` })
		};
		case "postmark": return {
			url: "https://api.postmarkapp.com/email",
			init: json({
				From: required(target.from, "Postmark from"),
				To: recipients(target.to, "Postmark to").join(","),
				Subject: summary.slice(0, 150),
				TextBody: summary
			}, { "x-postmark-server-token": required(target.token, "Postmark token") })
		};
		case "cloudflare_email": return {
			url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(required(target.accountId, "Cloudflare Email account ID"))}/email/sending/send`,
			init: json({
				from: required(target.from, "Cloudflare Email from"),
				to: recipients(target.to, "Cloudflare Email to"),
				subject: summary.slice(0, 150),
				text: summary
			}, { authorization: `Bearer ${required(target.token, "Cloudflare Email token")}` })
		};
		case "twilio": {
			const sid = required(target.accountSid, "Twilio account SID");
			const form = new URLSearchParams({
				From: required(target.from, "Twilio from"),
				To: singleRecipient(target.to, "Twilio to"),
				Body: summary
			});
			return {
				url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
				init: {
					method: "POST",
					redirect: "error",
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
async function cloudflareEmailResult(target, response) {
	const expected = recipients(target.to, "Cloudflare Email to");
	const expectedKeys = expected.map((recipient) => recipient.toLowerCase());
	let payload;
	try {
		payload = await response.json();
	} catch (error) {
		return {
			targetId: target.id,
			ok: false,
			status: response.status,
			error: error instanceof Error ? `Cloudflare Email response was not valid JSON: ${error.message}` : "Cloudflare Email response was not valid JSON"
		};
	}
	const result = isRecord(payload) && isRecord(payload.result) ? payload.result : payload;
	const bounced = stringArray(isRecord(result) ? result.permanent_bounces : void 0).filter((address) => expectedKeys.includes(address.trim().toLowerCase()));
	if (bounced.length) return {
		targetId: target.id,
		ok: false,
		status: response.status,
		error: `Cloudflare Email permanently bounced ${bounced.join(", ")}`
	};
	const delivered = stringArray(isRecord(result) ? result.delivered : void 0);
	const queued = stringArray(isRecord(result) ? result.queued : void 0);
	const accepted = new Set([...delivered, ...queued].map((address) => address.trim().toLowerCase()));
	const missing = expected.filter((_, index) => !accepted.has(expectedKeys[index]));
	if (!missing.length) return {
		targetId: target.id,
		ok: true,
		status: response.status
	};
	return {
		targetId: target.id,
		ok: false,
		status: response.status,
		error: `Cloudflare Email did not deliver or queue ${missing.join(", ")}`
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function stringArray(value) {
	return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
function notificationWebhookUrl(kind, value) {
	let url;
	try {
		url = new URL(required(value, `${kind} webhook URL`));
	} catch (error) {
		if (error instanceof Error && error.message.endsWith("is required")) throw error;
		throw new Error(`${kind} webhook URL is invalid`);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error(`${kind} webhook must use a standard HTTPS URL`);
	if (kind === "discord" && !["discord.com", "discordapp.com"].includes(url.hostname)) throw new Error("Discord webhooks must use discord.com");
	if (kind === "discord" && !url.pathname.startsWith("/api/webhooks/")) throw new Error("Discord webhook path is invalid");
	if (kind === "slack" && url.hostname !== "hooks.slack.com") throw new Error("Slack webhooks must use hooks.slack.com");
	if (kind === "slack" && !url.pathname.startsWith("/services/")) throw new Error("Slack webhook path is invalid");
	if (kind === "webhook" && blockedWebhookHost(url.hostname)) throw new Error("Generic webhooks cannot target local or private network addresses");
	return url;
}
function blockedWebhookHost(hostname) {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const ipv6 = host.includes(":");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || ipv6 && (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host))) return true;
	const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped ?? host);
	if (!match) return false;
	const octets = match.slice(1).map(Number);
	return octets.some((value) => value > 255) || octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168 || octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 || octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}
function required(value, label) {
	if (!value) throw new Error(`${label} is required`);
	return value;
}
function singleRecipient(value, label) {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
	return value.trim();
}
function recipients(value, label) {
	const normalized = (Array.isArray(value) ? value : typeof value === "string" ? [value] : []).map((recipient) => recipient.trim()).filter(Boolean);
	if (!normalized.length) throw new Error(`${label} is required`);
	return [...new Map(normalized.map((recipient) => [recipient.toLowerCase(), recipient])).values()];
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
//#region src/product-usage.ts
var metric$1 = (name, unit, aggregate, fields = [], extras = {}) => ({
	metric: name,
	unit,
	aggregate,
	fields,
	...extras
});
var dataset = (name, timeKind, timeField, metrics, options = {}) => ({
	dataset: name,
	alias: name.replace(/[^A-Za-z0-9_]/g, "_"),
	timeKind,
	timeField,
	metrics,
	...options
});
var R2_CLASS_A_ACTIONS = [
	"PutObject",
	"CopyObject",
	"ListBuckets",
	"ListObjects",
	"CreateMultipartUpload",
	"UploadPart",
	"CompleteMultipartUpload",
	"AbortMultipartUpload",
	"DeleteObject"
];
/**
* Explicit billable-usage adapters for Cloudflare product datasets. Settings
* discovery decides whether each dataset is enabled for the connected account.
*/
var PRODUCT_USAGE_DEFINITIONS = [
	definition("workers_ai", "Workers AI", 32, "resource", [dataset("aiInferenceAdaptiveGroups", "time", "datetime", [metric$1("requests", "requests", "count"), metric$1("neurons", "count", "sum", ["totalNeurons"])], {
		dimensions: ["modelId"],
		resourceDimension: "modelId"
	})]),
	definition("queues", "Queues", 90, "resource", [dataset("queueMessageOperationsAdaptiveGroups", "time", "datetime", [
		metric$1("operations", "count", "sum", ["billableOperations"]),
		metric$1("messages", "count", "count"),
		metric$1("bytes", "bytes", "sum", ["bytes"])
	], {
		dimensions: ["queueId"],
		resourceDimension: "queueId"
	})]),
	definition("d1", "D1", 90, "resource", [dataset("d1AnalyticsAdaptiveGroups", "date", "date", [metric$1("rows_read", "rows", "sum", ["rowsRead"]), metric$1("rows_written", "rows", "sum", ["rowsWritten"])], {
		dimensions: ["databaseId"],
		resourceDimension: "databaseId"
	}), dataset("d1StorageAdaptiveGroups", "date", "date", [metric$1("storage_bytes", "bytes", "max", ["databaseSizeBytes"])], {
		dimensions: ["databaseId"],
		resourceDimension: "databaseId"
	})]),
	definition("r2", "R2", 90, "resource", [dataset("r2OperationsAdaptiveGroups", "time", "datetime", [
		metric$1("class_a", "count", "sum", ["requests"], { actions: R2_CLASS_A_ACTIONS }),
		metric$1("class_b", "count", "sum", ["requests"], { actions: R2_CLASS_A_ACTIONS }),
		metric$1("egress_bytes", "bytes", "sum", ["responseBytes"])
	], {
		dimensions: ["bucketName", "actionType"],
		resourceDimension: "bucketName"
	}), dataset("r2StorageAdaptiveGroups", "time", "datetime", [metric$1("storage_bytes", "bytes", "max", ["payloadSize", "metadataSize"])], {
		dimensions: ["bucketName"],
		resourceDimension: "bucketName"
	})]),
	definition("kv", "Workers KV", 90, "namespace", [dataset("kvOperationsAdaptiveGroups", "date", "date", [
		metric$1("reads", "count", "sum", ["requests"], { actions: ["read"] }),
		metric$1("writes", "count", "sum", ["requests"], { actions: ["write"] }),
		metric$1("deletes", "count", "sum", ["requests"], { actions: ["delete"] }),
		metric$1("lists", "count", "sum", ["requests"], { actions: ["list"] })
	], {
		dimensions: ["namespaceId", "actionType"],
		resourceDimension: "namespaceId"
	}), dataset("kvStorageAdaptiveGroups", "date", "date", [metric$1("storage_bytes", "bytes", "max", ["byteCount"])], {
		dimensions: ["namespaceId"],
		resourceDimension: "namespaceId"
	})]),
	definition("pages", "Pages Functions", 90, "resource", [dataset("pagesFunctionsInvocationsAdaptiveGroups", "time", "datetime", [metric$1("requests", "requests", "sum", ["requests"])], {
		dimensions: ["scriptName"],
		resourceDimension: "scriptName"
	})], ["builds"]),
	definition("images", "Images", 31, "account", [dataset("imagesRequestsAdaptiveGroups", "date", "date", [metric$1("delivery", "requests", "sum", ["requests"])]), dataset("imagesTransformationsAdaptiveGroups", "date", "date", [metric$1("transformations", "count", "sum", ["billableEventCount"])])], ["stored_images"]),
	definition("stream", "Stream", 90, "resource", [dataset("streamMinutesViewedAdaptiveGroups", "date", "date", [metric$1("minutes_delivered", "milliseconds", "sum", ["minutesViewed"], { factor: 6e4 })], {
		dimensions: ["uid"],
		resourceDimension: "uid"
	})], ["minutes_stored"]),
	definition("vectorize", "Vectorize", 32, "resource", [dataset("vectorizeV2QueriesAdaptiveGroups", "time", "datetime", [metric$1("queried_dimensions", "count", "sum", ["queriedVectorDimensions"])], {
		dimensions: ["indexName"],
		resourceDimension: "indexName"
	}), dataset("vectorizeV2StorageAdaptiveGroups", "time", "datetime", [metric$1("stored_dimensions", "count", "max", ["storedVectorDimensions"])], {
		dimensions: ["indexName"],
		resourceDimension: "indexName"
	})]),
	definition("hyperdrive", "Hyperdrive", 32, "resource", [dataset("hyperdriveQueriesAdaptiveGroups", "time", "datetime", [metric$1("database_queries", "count", "count")], {
		dimensions: ["configId"],
		resourceDimension: "configId"
	})]),
	definition("ai_gateway", "AI Gateway", 62, "resource", [dataset("aiGatewayRequestsAdaptiveGroups", "time", "datetimeHour", [
		metric$1("requests", "requests", "count"),
		metric$1("tokens", "count", "sum", [
			"cachedTokensIn",
			"cachedTokensOut",
			"uncachedTokensIn",
			"uncachedTokensOut"
		]),
		metric$1("cost_usd", "usd", "sum", ["cost"])
	], {
		dimensions: ["gateway"],
		resourceDimension: "gateway"
	})]),
	definition("containers", "Containers", 32, "resource", [dataset("containersUsageAdaptiveGroups", "date", "date", [
		metric$1("vcpu_seconds", "milliseconds", "sum", ["cpuTimeSec"], { factor: 1e3 }),
		metric$1("memory_gb_seconds", "gb_seconds", "sum", ["allocatedMemory"], { factor: 1 / 1e9 }),
		metric$1("disk_gb_seconds", "gb_seconds", "sum", ["allocatedDisk"], { factor: 1 / 1e9 }),
		metric$1("egress_bytes", "bytes", "sum", ["txBytes"])
	], {
		dimensions: ["instanceId", "applicationId"],
		resourceDimension: "instanceId",
		parentDimension: "applicationId"
	})]),
	definition("browser_rendering", "Browser Rendering", 32, "account", [dataset("browserRenderingBrowserTimeUsageAdaptiveGroups", "time", "datetime", [metric$1("sessions", "count", "count"), metric$1("session_minutes", "milliseconds", "sum", ["totalSessionDurationMs"])])]),
	definition("workflows", "Workflows", 32, "resource", [dataset("workflowsAdaptiveGroups", "time", "datetimeHour", [metric$1("requests", "requests", "count")], {
		dimensions: ["workflowName"],
		resourceDimension: "workflowName"
	})], [
		"cpu_ms",
		"steps",
		"storage_bytes"
	]),
	definition("worker_builds", "Worker Builds", 32, "account", [dataset("workersBuildsBuildMinutesAdaptiveGroups", "date", "date", [metric$1("build_minutes", "milliseconds", "sum", ["buildMinutes"], { factor: 6e4 })])]),
	definition("analytics_engine", "Analytics Engine", 31, "resource", [dataset("workersAnalyticsEngineAdaptiveGroups", "time", "datetime", [metric$1("data_points_written", "count", "count")], {
		dimensions: ["dataset"],
		resourceDimension: "dataset"
	})], [
		"data_points_read",
		"queries",
		"storage_bytes"
	]),
	definition("log_explorer", "Log Explorer", 32, "resource", [dataset("logExplorerIngestionAdaptiveGroups", "time", "datetime", [metric$1("ingested_bytes", "bytes", "sum", ["billableBytes"])], {
		dimensions: ["dataset", "zoneTag"],
		resourceDimension: "dataset",
		parentDimension: "zoneTag"
	})], ["queries", "storage_bytes"]),
	definition("zones", "Zones", 30, "zone", [dataset("httpRequestsAdaptiveGroups", "time", "datetime", [metric$1("requests", "requests", "count"), metric$1("bandwidth_bytes", "bytes", "sum", ["edgeResponseBytes"])], { root: "zone" })]),
	definition("email", "Email", 30, "zone", [dataset("emailSendingAdaptiveGroups", "time", "datetime", [metric$1("sent", "count", "count")], { root: "zone" }), dataset("emailRoutingAdaptiveGroups", "time", "datetime", [metric$1("routed", "count", "count")], { root: "zone" })])
];
var BY_COLLECTOR = new Map(PRODUCT_USAGE_DEFINITIONS.map((item) => [item.collector, item]));
new Map(PRODUCT_USAGE_DEFINITIONS.flatMap((item) => item.datasets.map((value) => [value.dataset, item])));
function productUsageDefinition(collector) {
	return BY_COLLECTOR.get(collector);
}
function buildProductDatasetQuery(definition, source) {
	const variableType = source.timeKind === "date" ? "Date" : "Time";
	const filter = source.timeKind === "date" ? `${source.timeField}_geq: $start, ${source.timeField}_leq: $end` : `${source.timeField}_geq: $start, ${source.timeField}_lt: $end`;
	const aggregates = [...new Set(source.metrics.map((item) => item.aggregate))];
	const body = [
		source.dimensions?.length ? `dimensions { ${source.dimensions.join(" ")} }` : "",
		aggregates.includes("count") ? "count" : "",
		...["sum", "max"].map((aggregate) => {
			const fields = [...new Set(source.metrics.filter((item) => item.aggregate === aggregate).flatMap((item) => item.fields ?? []))];
			return fields.length ? `${aggregate} { ${fields.join(" ")} }` : "";
		})
	].filter(Boolean).join("\n");
	const selection = `${source.alias}: ${source.dataset}(limit: 10000, filter: { ${filter} }) { ${body} }`;
	if ((source.root ?? "account") === "zone") return `query BrollyProductUsage($zones: [string!]!, $start: ${variableType}!, $end: ${variableType}!) { viewer { zones(filter: { zoneTag_in: $zones }) { zoneTag ${selection} } } }`;
	return `query BrollyProductUsage($account: String!, $start: ${variableType}!, $end: ${variableType}!) { viewer { accounts(filter: { accountTag: $account }) { ${selection} } } }`;
}
function productDatasetVariables(source, accountId, startsAt, endsAt, zoneIds = []) {
	const scope = (source.root ?? "account") === "zone" ? { zones: zoneIds } : { account: accountId };
	if (source.timeKind === "date") {
		const day = new Date(startsAt).toISOString().slice(0, 10);
		return {
			...scope,
			start: day,
			end: day
		};
	}
	return {
		...scope,
		start: new Date(startsAt).toISOString(),
		end: new Date(endsAt).toISOString()
	};
}
function normalizeProductDataset(definition, source, roots, accountId, startsAt, endsAt) {
	const samples = /* @__PURE__ */ new Map();
	for (const root of roots) {
		const zoneTag = stringValue$1(root.zoneTag);
		const rows = Array.isArray(root[source.alias]) ? root[source.alias] : [];
		for (const row of rows) {
			const dimensions = recordValue(row.dimensions);
			const action = stringValue$1(dimensions.actionType)?.toLowerCase();
			const resource = source.resourceDimension ? stringValue$1(dimensions[source.resourceDimension]) : void 0;
			const parent = source.parentDimension ? stringValue$1(dimensions[source.parentDimension]) : void 0;
			const scope = zoneTag ? "zone" : resource ? definition.scope : "account";
			const id = zoneTag ?? resource ?? definition.family;
			const asset = {
				accountId,
				family: definition.family,
				id,
				name: id,
				scope,
				...parent ? { parentId: parent } : {},
				tier: "unclassified"
			};
			for (const item of source.metrics) {
				if (item.actions?.length) {
					const actions = item.actions.map((value) => value.toLowerCase());
					const matches = action ? actions.includes(action) : false;
					if (item.metric === "class_b" ? matches : !matches) continue;
				}
				const aggregate = item.aggregate === "count" ? row : recordValue(row[item.aggregate]);
				const value = (item.aggregate === "count" ? numberValue(row.count) : (item.fields ?? []).reduce((sum, field) => sum + numberValue(aggregate[field]), 0)) * (item.factor ?? 1);
				if (!Number.isFinite(value)) continue;
				const key = `${asset.scope}:${asset.id}:${item.metric}`;
				const existing = samples.get(key);
				if (existing) existing.value = item.aggregate === "max" ? Math.max(existing.value, value) : existing.value + value;
				else samples.set(key, {
					asset,
					metric: item.metric,
					unit: item.unit,
					value,
					start: startsAt,
					end: endsAt,
					source: "graphql",
					sampled: false
				});
			}
		}
	}
	return [...samples.values()];
}
function definition(family, label, retentionDays, scope, datasets, billingOnlyMetrics = []) {
	return {
		collector: `graphql:${family}`,
		family,
		label,
		retentionDays,
		scope,
		datasets,
		billingOnlyMetrics
	};
}
function recordValue(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringValue$1(value) {
	return typeof value === "string" && value.length ? value : void 0;
}
function numberValue(value) {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}
//#endregion
//#region src/cloudflare.ts
var API$2 = "https://api.cloudflare.com/client/v4";
var REQUEST_TIMEOUT_MS = 8e3;
var BILLING_USAGE_MAX_RANGE_MS = 26784e5;
var CloudflareClient = class {
	env;
	budget;
	ledgerBudget;
	tokenPromise = null;
	zoneIdsPromise = null;
	constructor(env, budget, ledgerBudget) {
		this.env = env;
		this.budget = budget;
		this.ledgerBudget = ledgerBudget;
	}
	async zones() {
		return (await this.listRows(`/zones?account.id=${encodeURIComponent(this.env.BROLLY_ACCOUNT_ID)}&per_page=50`)).rows.flatMap((row) => {
			const id = stringValue(row.id);
			const name = stringValue(row.name);
			return id && name ? [{
				id,
				name
			}] : [];
		});
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
						tier: family === "workers" && (isBrollyScript(id, this.env.BROLLY_SELF_WORKER_NAME) || isBrollyScript(name, this.env.BROLLY_SELF_WORKER_NAME)) ? "control_plane" : "unclassified",
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
	async analyticsCapabilities() {
		const datasets = [
			{
				dataset: "durableObjectsInvocationsAdaptiveGroups",
				collectorKey: "graphql:durable-objects",
				family: "durable_objects",
				scope: "object",
				root: "account"
			},
			{
				dataset: "durableObjectsPeriodicGroups",
				collectorKey: "graphql:durable-objects",
				family: "durable_objects",
				scope: "object",
				root: "account"
			},
			{
				dataset: "durableObjectsSqlStorageGroups",
				collectorKey: "graphql:durable-objects",
				family: "durable_objects",
				scope: "namespace",
				root: "account"
			},
			{
				dataset: "durableObjectsStorageGroups",
				collectorKey: "graphql:durable-objects",
				family: "durable_objects",
				scope: "account",
				root: "account"
			},
			{
				dataset: "workersInvocationsAdaptive",
				collectorKey: "graphql:workers",
				family: "workers",
				scope: "resource",
				root: "account"
			},
			...PRODUCT_USAGE_DEFINITIONS.flatMap((definition) => definition.datasets.map((source) => ({
				dataset: source.dataset,
				collectorKey: definition.collector,
				family: definition.family,
				scope: source.root === "zone" ? "zone" : source.resourceDimension ? definition.scope : "account",
				root: source.root ?? "account"
			})))
		];
		const fields = "enabled availableFields maxDuration maxNumberOfFields maxPageSize notOlderThan";
		const accountDatasets = datasets.filter((item) => item.root === "account");
		const zoneDatasets = datasets.filter((item) => item.root === "zone");
		const query = `query BrollyAnalyticsCapabilities($account: String!, $zones: [string!]!) {
      viewer { accounts(filter: { accountTag: $account }) { settings {
        ${accountDatasets.map((item) => `${item.dataset} { ${fields} }`).join("\n")}
      } } zones(filter: { zoneTag_in: $zones }) { settings {
        ${zoneDatasets.map((item) => `${item.dataset} { ${fields} }`).join("\n")}
      } } }
    }`;
		const checkedAt = Date.now();
		try {
			this.budget.charge("apiCalls");
			this.ledgerBudget?.charge("graphqlQueries", datasets.length);
			const zoneIds = await this.zoneIds();
			const response = await fetch(`${API$2}/graphql`, {
				method: "POST",
				headers: authHeaders(await this.token()),
				body: JSON.stringify({
					query,
					variables: {
						account: this.env.BROLLY_ACCOUNT_ID,
						zones: zoneIds
					}
				}),
				signal: this.budget.signal
			});
			if (!response.ok) throw await cloudflareApiError(response);
			const payload = await response.json();
			if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
			const accountSettings = payload.data?.viewer?.accounts?.[0]?.settings ?? {};
			const zoneSettings = payload.data?.viewer?.zones?.map((zone) => zone.settings ?? {}) ?? [];
			return [...datasets.map((item) => {
				const candidates = item.root === "account" ? [accountSettings[item.dataset]] : zoneSettings.map((setting) => setting[item.dataset]);
				const setting = candidates.find((value) => value?.enabled === true) ?? candidates.find(Boolean);
				const available = setting?.enabled === true;
				return {
					accountId: this.env.BROLLY_ACCOUNT_ID,
					collectorKey: item.collectorKey,
					dataset: item.dataset,
					available,
					retentionDays: setting?.notOlderThan ? Math.floor(setting.notOlderThan / 86400) : null,
					samplingBehavior: setting?.availableFields?.some((field) => field.toLowerCase().includes("sampleinterval")) ? "Adaptive sampling; sampleInterval is recorded per result" : "Dataset sampling follows Cloudflare Analytics settings",
					finestScope: item.scope,
					lastVerifiedAt: checkedAt,
					errorCode: available ? null : "dataset_disabled",
					humanExplanation: available ? `Available with page size ${setting?.maxPageSize ?? "unknown"} and duration limit ${setting?.maxDuration ?? "unknown"} seconds` : "Cloudflare reports this Analytics dataset as unavailable for the current token or plan",
					state: available ? "healthy" : "unavailable",
					watermarkAt: null
				};
			}), ...catalogCapabilityGaps(this.env.BROLLY_ACCOUNT_ID, checkedAt, new Set(datasets.map((item) => item.family)))];
		} catch (error) {
			const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
			const detail = error instanceof Error ? error.message : String(error);
			return [...datasets.map((item) => ({
				accountId: this.env.BROLLY_ACCOUNT_ID,
				collectorKey: item.collectorKey,
				dataset: item.dataset,
				available: false,
				retentionDays: null,
				samplingBehavior: null,
				finestScope: item.scope,
				lastVerifiedAt: checkedAt,
				errorCode: state,
				humanExplanation: detail,
				state,
				watermarkAt: null
			})), ...catalogCapabilityGaps(this.env.BROLLY_ACCOUNT_ID, checkedAt, new Set(datasets.map((item) => item.family)))];
		}
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
	async durableObjectUsagePaged(since, until, options = {}) {
		const pageSize = 1e4;
		const maxPages = Math.max(1, Math.min(options.maxPages ?? 30, 30));
		const query = `query BrollyDurableObjectLedger(
      $account: String!, $since: Time!, $until: Time!,
      $requestsCursor: String!, $durationCursor: String!, $websocketCursor: String!,
      $rowsReadCursor: String!, $rowsWrittenCursor: String!,
      $storageReadsCursor: String!, $storageWritesCursor: String!, $storageDeletesCursor: String!,
      $requestsMore: Boolean!, $durationMore: Boolean!, $websocketMore: Boolean!,
      $rowsReadMore: Boolean!, $rowsWrittenMore: Boolean!,
      $storageReadsMore: Boolean!, $storageWritesMore: Boolean!, $storageDeletesMore: Boolean!,
      $firstPage: Boolean!
    ) {
      viewer { accounts(filter: { accountTag: $account }) {
        requests: durableObjectsInvocationsAdaptiveGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $requestsCursor }
        ) @include(if: $requestsMore) { dimensions { namespaceId objectId type } sum { requests } }
        duration: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $durationCursor }
        ) @include(if: $durationMore) { dimensions { namespaceId objectId } sum { duration } }
        websocket: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $websocketCursor }
        ) @include(if: $websocketMore) { dimensions { namespaceId objectId } sum { inboundWebsocketMsgCount } }
        rowsRead: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $rowsReadCursor }
        ) @include(if: $rowsReadMore) { dimensions { namespaceId objectId } sum { rowsRead } }
        rowsWritten: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $rowsWrittenCursor }
        ) @include(if: $rowsWrittenMore) { dimensions { namespaceId objectId } sum { rowsWritten } }
        storageReads: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $storageReadsCursor }
        ) @include(if: $storageReadsMore) { dimensions { namespaceId objectId } sum { storageReadUnits } }
        storageWrites: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $storageWritesCursor }
        ) @include(if: $storageWritesMore) { dimensions { namespaceId objectId } sum { storageWriteUnits } }
        storageDeletes: durableObjectsPeriodicGroups(
          limit: 10000, orderBy: [dimensions_objectId_ASC],
          filter: { datetime_geq: $since, datetime_lt: $until, objectId_gt: $storageDeletesCursor }
        ) @include(if: $storageDeletesMore) { dimensions { namespaceId objectId } sum { storageDeletes } }
        sqlStorage: durableObjectsSqlStorageGroups(
          limit: 10000, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [dimensions_namespaceId_ASC]
        ) @include(if: $firstPage) { dimensions { namespaceId } max { storedBytes } }
        kvStorage: durableObjectsStorageGroups(
          limit: 1, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [max_storedBytes_DESC]
        ) @include(if: $firstPage) { max { storedBytes } }
      } }
    }`;
		const names = [
			"requests",
			"duration",
			"websocket",
			"rowsRead",
			"rowsWritten",
			"storageReads",
			"storageWrites",
			"storageDeletes"
		];
		const cursors = {
			requests: options.cursor?.requests ?? "",
			duration: options.cursor?.duration ?? "",
			websocket: options.cursor?.websocket ?? "",
			rowsRead: options.cursor?.rowsRead ?? "",
			rowsWritten: options.cursor?.rowsWritten ?? "",
			storageReads: options.cursor?.storageReads ?? "",
			storageWrites: options.cursor?.storageWrites ?? "",
			storageDeletes: options.cursor?.storageDeletes ?? ""
		};
		const more = Object.fromEntries(names.map((name) => [name, true]));
		const seen = Object.fromEntries(names.map((name) => [name, 0]));
		const samples = /* @__PURE__ */ new Map();
		let pages = 0;
		let sqlStorage = [];
		let kvStorage = [];
		try {
			while (pages < maxPages && names.some((name) => more[name])) {
				this.budget.charge("apiCalls");
				this.ledgerBudget?.charge("pagesPerDataset");
				this.ledgerBudget?.charge("graphqlQueries", names.filter((name) => more[name]).length + (pages === 0 ? 2 : 0));
				const variables = {
					account: this.env.BROLLY_ACCOUNT_ID,
					since: new Date(since).toISOString(),
					until: new Date(until).toISOString(),
					...Object.fromEntries(names.flatMap((name) => [[`${name}Cursor`, cursors[name]], [`${name}More`, more[name]]])),
					firstPage: pages === 0
				};
				const response = await fetch(`${API$2}/graphql`, {
					method: "POST",
					headers: authHeaders(await this.token()),
					body: JSON.stringify({
						query,
						variables
					}),
					signal: this.budget.signal
				});
				if (!response.ok) throw await cloudflareApiError(response);
				const payload = await response.json();
				if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
				const account = payload.data?.viewer?.accounts?.[0] ?? {};
				if (pages === 0) {
					sqlStorage = account.sqlStorage ?? [];
					kvStorage = account.kvStorage ?? [];
				}
				for (const name of names) {
					if (!more[name]) continue;
					const groups = account[name] ?? [];
					seen[name] += groups.length;
					for (const group of groups) addDurableObjectGroup(samples, this.env.BROLLY_ACCOUNT_ID, name, group, since, until);
					const lastId = groups.at(-1)?.dimensions.objectId;
					if (lastId) cursors[name] = lastId;
					more[name] = groups.length === pageSize && (!options.expectedActiveObjects || seen[name] < options.expectedActiveObjects);
				}
				pages += 1;
			}
			for (const group of sqlStorage ?? []) {
				if (group.max.storedBytes === void 0) continue;
				const asset = {
					accountId: this.env.BROLLY_ACCOUNT_ID,
					family: "durable_objects",
					id: group.dimensions.namespaceId,
					scope: "namespace",
					tier: "unclassified"
				};
				samples.set(`${asset.id}:sql_storage_bytes`, metric(asset, "sql_storage_bytes", "bytes", group.max.storedBytes, since, until, false));
			}
			if ((kvStorage?.length ?? 0) > 0) {
				const value = Math.max(0, ...(kvStorage ?? []).map((group) => group.max.storedBytes ?? 0));
				const asset = {
					accountId: this.env.BROLLY_ACCOUNT_ID,
					family: "durable_objects",
					id: "legacy-kv-storage",
					name: "Legacy key-value Durable Object storage",
					scope: "account",
					tier: "control_plane"
				};
				samples.set(`${asset.id}:kv_storage_bytes`, metric(asset, "kv_storage_bytes", "bytes", value, since, until, false));
			}
			const complete = !names.some((name) => more[name]);
			const detail = complete ? void 0 : `Durable Object keyset pagination paused after ${pages} pages; the continuation is persisted`;
			const result = [...samples.values()];
			this.budget.charge("samples", result.length);
			return {
				samples: result,
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
					], complete ? "healthy" : "delayed", detail, "object"),
					...coverageForMetrics("durable_objects", ["sql_storage_bytes"], (sqlStorage?.length ?? 0) >= pageSize ? "delayed" : "healthy", void 0, "namespace"),
					...coverageForMetrics("durable_objects", ["kv_storage_bytes"], "healthy", void 0, "account")
				],
				continuation: complete ? null : Object.fromEntries(names.filter((name) => more[name]).map((name) => [name, cursors[name]])),
				complete,
				pages,
				watermarkAt: until
			};
		} catch (error) {
			const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
			const detail = error instanceof Error ? error.message : String(error);
			return {
				samples: [...samples.values()],
				coverage: coverageForMetrics("durable_objects", [
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
				], state, detail, "object"),
				continuation: Object.fromEntries(names.filter((name) => more[name]).map((name) => [name, cursors[name]])),
				complete: false,
				pages,
				watermarkAt: until
			};
		}
	}
	async workerUsage(since, until, options = {}) {
		const pageSize = 1e4;
		const maxPages = Math.max(1, Math.min(options.maxPages ?? 10, 30));
		const query = `query BrollyWorkers(
      $account: String!, $since: Time!, $until: Time!,
      $requestsCursor: String!, $cpuCursor: String!,
      $requestsMore: Boolean!, $cpuMore: Boolean!
    ) {
      viewer { accounts(filter: { accountTag: $account }) {
        byRequests: workersInvocationsAdaptive(
          limit: 10000
          filter: { datetime_geq: $since, datetime_lt: $until, isPreview: 0, scriptName_gt: $requestsCursor }
          orderBy: [dimensions_scriptName_ASC]
        ) @include(if: $requestsMore) {
          dimensions { scriptName }
          sum { requests }
        }
        byCpu: workersInvocationsAdaptive(
          limit: 10000
          filter: { datetime_geq: $since, datetime_lt: $until, isPreview: 0, scriptName_gt: $cpuCursor }
          orderBy: [dimensions_scriptName_ASC]
        ) @include(if: $cpuMore) {
          dimensions { scriptName }
          sum { cpuTimeUs }
        }
      } }
    }`;
		const cursors = {
			requests: options.cursor?.requests ?? "",
			cpu: options.cursor?.cpu ?? ""
		};
		const more = {
			requests: true,
			cpu: true
		};
		const samples = /* @__PURE__ */ new Map();
		let pages = 0;
		try {
			while (pages < maxPages && (more.requests || more.cpu)) {
				this.budget.charge("apiCalls");
				this.ledgerBudget?.charge("pagesPerDataset");
				this.ledgerBudget?.charge("graphqlQueries", Number(more.requests) + Number(more.cpu));
				const response = await fetch(`${API$2}/graphql`, {
					method: "POST",
					headers: authHeaders(await this.token()),
					body: JSON.stringify({
						query,
						variables: {
							account: this.env.BROLLY_ACCOUNT_ID,
							since: new Date(since).toISOString(),
							until: new Date(until).toISOString(),
							requestsCursor: cursors.requests,
							cpuCursor: cursors.cpu,
							requestsMore: more.requests,
							cpuMore: more.cpu
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
				for (const group of requestGroups) {
					if (group.sum.requests === void 0 || !group.dimensions.scriptName) continue;
					const value = workerMetric(this.env.BROLLY_ACCOUNT_ID, group.dimensions.scriptName, "requests", "requests", group.sum.requests, since, until, false, this.env.BROLLY_SELF_WORKER_NAME);
					samples.set(`${group.dimensions.scriptName}:requests`, value);
				}
				for (const group of cpuGroups) {
					if (group.sum.cpuTimeUs === void 0 || !group.dimensions.scriptName) continue;
					const value = workerMetric(this.env.BROLLY_ACCOUNT_ID, group.dimensions.scriptName, "cpu_ms", "milliseconds", group.sum.cpuTimeUs / 1e3, since, until, false, this.env.BROLLY_SELF_WORKER_NAME);
					samples.set(`${group.dimensions.scriptName}:cpu_ms`, value);
				}
				const lastRequest = requestGroups.at(-1)?.dimensions.scriptName;
				const lastCpu = cpuGroups.at(-1)?.dimensions.scriptName;
				if (lastRequest) cursors.requests = lastRequest;
				if (lastCpu) cursors.cpu = lastCpu;
				more.requests = requestGroups.length === pageSize;
				more.cpu = cpuGroups.length === pageSize;
				pages += 1;
			}
			const complete = !more.requests && !more.cpu;
			const detail = complete ? void 0 : `Worker keyset pagination paused after ${pages} pages; the continuation is persisted`;
			const result = [...samples.values()];
			this.budget.charge("samples", result.length);
			return {
				samples: result,
				coverage: [...coverageForMetrics("workers", ["requests", "cpu_ms"], complete ? "healthy" : "delayed", detail, "resource"), ...coverageForMetrics("workers", ["cache_requests"], "unavailable", "Brolly has the complete per-Worker data Cloudflare provides: requests and CPU time. Cloudflare reports cache charges only at the account level, so Brolly protects those costs with account and product limits instead of assigning them to individual Workers.", "resource")],
				continuation: complete ? null : {
					...more.requests ? { requests: cursors.requests } : {},
					...more.cpu ? { cpu: cursors.cpu } : {}
				},
				complete,
				pages,
				watermarkAt: until
			};
		} catch (error) {
			const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
			return {
				samples: [...samples.values()],
				coverage: coverageForMetrics("workers", [
					"requests",
					"cpu_ms",
					"cache_requests"
				], state, error instanceof Error ? error.message : String(error), "resource"),
				continuation: {
					...more.requests ? { requests: cursors.requests } : {},
					...more.cpu ? { cpu: cursors.cpu } : {}
				},
				complete: false,
				pages,
				watermarkAt: until
			};
		}
	}
	/** Collect one bounded product window from every dataset in its registry entry. */
	async productUsage(definition, since, until) {
		const samples = [];
		const coverage = [];
		let complete = true;
		let pages = 0;
		for (const source of definition.datasets) try {
			const zoneIds = source.root === "zone" ? await this.zoneIds() : [];
			if (source.root === "zone" && zoneIds.length === 0) {
				coverage.push(...source.metrics.map((item) => ({
					family: definition.family,
					metric: item.metric,
					finestScope: "zone",
					state: "healthy",
					checkedAt: Date.now(),
					detail: "The connected account has no zones."
				})));
				continue;
			}
			this.budget.charge("apiCalls");
			this.ledgerBudget?.charge("pagesPerDataset");
			this.ledgerBudget?.charge("graphqlQueries");
			const response = await fetch(`${API$2}/graphql`, {
				method: "POST",
				headers: authHeaders(await this.token()),
				body: JSON.stringify({
					query: buildProductDatasetQuery(definition, source),
					variables: productDatasetVariables(source, this.env.BROLLY_ACCOUNT_ID, since, until, zoneIds)
				}),
				signal: this.budget.signal
			});
			if (!response.ok) throw await cloudflareApiError(response);
			const payload = await response.json();
			if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
			const roots = (source.root ?? "account") === "zone" ? payload.data?.viewer?.zones ?? [] : payload.data?.viewer?.accounts ?? [];
			samples.push(...normalizeProductDataset(definition, source, roots, this.env.BROLLY_ACCOUNT_ID, since, until));
			const truncated = roots.some((root) => Array.isArray(root[source.alias]) && root[source.alias].length >= 1e4);
			coverage.push(...source.metrics.map((item) => ({
				family: definition.family,
				metric: item.metric,
				finestScope: source.root === "zone" ? "zone" : source.resourceDimension ? definition.scope : "account",
				state: truncated ? "delayed" : "healthy",
				checkedAt: Date.now(),
				detail: truncated ? `${source.dataset} reached its bounded 10,000-row daily limit; retained rows are marked partial` : void 0
			})));
			pages += 1;
		} catch (error) {
			if (error instanceof LedgerBudgetExceededError || error instanceof MonitoringBudgetExceededError) throw error;
			complete = false;
			const state = error instanceof CloudflareApiError && error.status === 403 ? "permission_denied" : "unavailable";
			coverage.push(...source.metrics.map((item) => ({
				family: definition.family,
				metric: item.metric,
				finestScope: source.root === "zone" ? "zone" : source.resourceDimension ? definition.scope : "account",
				state,
				checkedAt: Date.now(),
				detail: `${source.dataset}: ${error instanceof Error ? error.message : String(error)}`
			})));
		}
		coverage.push(...definition.billingOnlyMetrics.map((item) => ({
			family: definition.family,
			metric: item,
			finestScope: definition.scope,
			state: "unavailable",
			checkedAt: Date.now(),
			detail: "This metric is retained through authoritative billing because Cloudflare does not expose a supported usage field."
		})));
		this.budget.charge("samples", samples.length);
		return {
			samples,
			coverage,
			continuation: null,
			complete,
			pages,
			watermarkAt: until
		};
	}
	async billingUsage(since, until) {
		const token = await configuredBillingToken(this.env);
		if (!token) return null;
		try {
			const requested = await this.getBillingUsage(since, until, token);
			const aligned = billingAlignedStart(requested, since, until);
			if (aligned !== null) return await this.getBillingUsage(aligned, until, token);
			return requested;
		} catch (error) {
			if (!(error instanceof CloudflareApiError) || ![403, 404].includes(error.status)) throw error;
			const alignedRecords = (await this.getPaygoBillingUsage(since, until, token)).map(normalizePaygoBillingRecord);
			const aligned = billingAlignedStart(alignedRecords, since, until);
			if (aligned !== null) return (await this.getPaygoBillingUsage(aligned, until, token)).map(normalizePaygoBillingRecord);
			return alignedRecords;
		}
	}
	async getBillingUsage(since, until, token) {
		const from = new Date(since).toISOString().slice(0, 10);
		const to = new Date(until).toISOString().slice(0, 10);
		return await this.get(`/accounts/${this.env.BROLLY_ACCOUNT_ID}/billable/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, token);
	}
	async getPaygoBillingUsage(since, until, token) {
		const from = new Date(since).toISOString().slice(0, 10);
		return this.get(`/accounts/${this.env.BROLLY_ACCOUNT_ID}/billable-usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(until).toISOString().slice(0, 10))}`, token);
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
		const authorization = authHeaders(token ?? await this.token());
		let response;
		for (let attempt = 0;; attempt += 1) {
			this.budget.charge("apiCalls");
			this.ledgerBudget?.charge("restRequests");
			response = await fetch(`${API$2}${path}`, {
				headers: authorization,
				signal: AbortSignal.any([this.budget.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
			});
			if (response.status !== 429 || attempt > 0) break;
			const retryAfter = retryAfterMilliseconds(response.headers.get("Retry-After"));
			if (retryAfter === null) break;
			await delayWithSignal(retryAfter, this.budget.signal);
		}
		if (!response.ok) throw await cloudflareApiError(response);
		const envelope = await response.json();
		if (!envelope.success) throw new Error(envelope.errors?.map((error) => error.message).join("; ") || "Cloudflare API error");
		return envelope;
	}
	zoneIds() {
		this.zoneIdsPromise ??= this.listRows(`/zones?account.id=${encodeURIComponent(this.env.BROLLY_ACCOUNT_ID)}&per_page=50`).then((result) => result.rows.map((row) => stringValue(row.id)).filter((value) => Boolean(value)));
		return this.zoneIdsPromise;
	}
	token() {
		this.tokenPromise ??= operationalToken(this.env);
		return this.tokenPromise;
	}
};
function normalizePaygoBillingRecord(row) {
	const family = row.ServiceFamilyName ?? row.ServiceName;
	return {
		ChargePeriodStart: row.ChargePeriodStart,
		ChargePeriodEnd: row.ChargePeriodEnd,
		ConsumedQuantity: row.ConsumedQuantity,
		ConsumedUnit: row.ConsumedUnit,
		x_BillableMetricId: slug(row.ServiceName),
		x_BillableMetricName: row.ServiceName,
		x_ProductFamilyId: slug(family),
		x_ProductFamilyName: family,
		x_ZoneId: row.ZoneId,
		x_ZoneName: row.ZoneName,
		BillingPeriodStart: row.BillingPeriodStart,
		BillingPeriodEnd: row.BillingPeriodEnd,
		BilledCost: row.BilledCost,
		EffectiveCost: row.EffectiveCost,
		ListCost: row.ListCost
	};
}
function startOfUtcDay(timestamp) {
	const date = new Date(timestamp);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
function billingCycleStart(records) {
	const starts = records.map((record) => record.BillingPeriodStart ? Date.parse(record.BillingPeriodStart) : NaN).filter(Number.isFinite);
	return starts.length ? Math.min(...starts) : null;
}
function billingAlignedStart(records, since, until) {
	const cycleStart = billingCycleStart(records);
	if (cycleStart === null) return null;
	const aligned = until - cycleStart <= BILLING_USAGE_MAX_RANGE_MS ? cycleStart : startOfUtcDay(since);
	return aligned === startOfUtcDay(since) ? null : aligned;
}
function retryAfterMilliseconds(value) {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1e3, REQUEST_TIMEOUT_MS);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return null;
	return Math.max(0, Math.min(timestamp - Date.now(), REQUEST_TIMEOUT_MS));
}
async function delayWithSignal(milliseconds, signal) {
	if (milliseconds <= 0) return;
	await new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, milliseconds);
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? /* @__PURE__ */ new Error("Cloudflare request aborted"));
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}
function catalogCapabilityGaps(accountId, checkedAt, coveredFamilies = /* @__PURE__ */ new Set(["workers", "durable_objects"])) {
	return METRIC_CATALOG.filter((product) => !coveredFamilies.has(product.family)).map((product) => ({
		accountId,
		collectorKey: product.fastSource ? `${product.fastSource}:${product.family}` : "billing:catchall",
		dataset: product.family,
		available: false,
		retentionDays: null,
		samplingBehavior: null,
		finestScope: product.preferredScope,
		lastVerifiedAt: checkedAt,
		errorCode: "detailed_collector_unavailable",
		humanExplanation: product.billingSource ? "Authoritative billing lines remain visible. Detailed resource attribution is unavailable for this product." : "Cloudflare does not expose a supported account collector for this product.",
		state: "unavailable",
		watermarkAt: null
	}));
}
function slug(value) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}
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
function addDurableObjectGroup(samples, accountId, source, group, since, until) {
	const [name, unit, rawValue] = source === "requests" ? group.dimensions.type === "hibernation" ? [
		"incoming_websocket_messages",
		"count",
		group.sum.requests
	] : [
		"requests",
		"requests",
		group.sum.requests
	] : source === "duration" ? [
		"duration_gb_seconds",
		"gb_seconds",
		group.sum.duration
	] : source === "websocket" ? [
		"incoming_websocket_messages",
		"count",
		group.sum.inboundWebsocketMsgCount
	] : source === "rowsRead" ? [
		"rows_read",
		"rows",
		group.sum.rowsRead
	] : source === "rowsWritten" ? [
		"rows_written",
		"rows",
		group.sum.rowsWritten
	] : source === "storageReads" ? [
		"kv_read_units",
		"count",
		group.sum.storageReadUnits
	] : source === "storageWrites" ? [
		"kv_write_units",
		"count",
		group.sum.storageWriteUnits
	] : [
		"kv_delete_requests",
		"requests",
		group.sum.storageDeletes
	];
	if (rawValue === void 0 || !group.dimensions.objectId) return;
	const asset = {
		accountId,
		family: "durable_objects",
		id: group.dimensions.objectId,
		parentId: group.dimensions.namespaceId,
		scope: "object",
		tier: "unclassified"
	};
	const key = `${asset.parentId}:${asset.id}:${name}`;
	const next = metric(asset, name, unit, rawValue, since, until, false);
	const existing = samples.get(key);
	if (!existing) {
		samples.set(key, next);
		return;
	}
	existing.value += next.value;
	existing.estimatedCostUsd = (existing.estimatedCostUsd ?? 0) + (next.estimatedCostUsd ?? 0);
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
function workerMetric(accountId, scriptName, name, unit, value, start, end, sampled, selfWorker) {
	return {
		asset: {
			accountId,
			family: "workers",
			id: scriptName,
			name: scriptName,
			scope: "resource",
			tier: isBrollyScript(scriptName, selfWorker) ? "control_plane" : "unclassified"
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
function isBrollyScript(value, configured) {
	return value === (configured ?? "brolly-guard") || value === "brolly-guard" || value.startsWith("brolly-guard-");
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
		this.chargeRows(row ? 1 : 0, "read");
		if (!row) return DEFAULT_POLICY;
		try {
			const policy = JSON.parse(row.value);
			return policy && typeof policy.version === "string" && policy.accountDailySpend && Array.isArray(policy.thresholds) ? policy : DEFAULT_POLICY;
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
	async applyPoliciesToAssets(assets, family) {
		const result = await this.db.prepare(`SELECT asset_id,tier,name,metadata_json FROM assets WHERE account_id=?1 AND family=?2
       ORDER BY CASE WHEN scope='namespace' THEN 0 WHEN scope='resource' THEN 1 ELSE 2 END,seen_at DESC
       LIMIT 25000`).bind(assets[0]?.accountId ?? "", family).all();
		this.chargeMeta(result.meta);
		const policies = new Map(result.results.map((row) => [row.asset_id, row]));
		for (const asset of assets) {
			const direct = policies.get(asset.id);
			const parent = asset.parentId ? policies.get(asset.parentId) : void 0;
			if (!direct && !parent) continue;
			const parentTags = parseTags$1(parent?.metadata_json);
			const directTags = parseTags$1(direct?.metadata_json);
			asset.tier = direct?.tier && direct.tier !== "unclassified" ? direct.tier : parent?.tier ?? direct?.tier ?? asset.tier;
			asset.name = direct?.name ?? asset.name;
			asset.tags = {
				...parentTags,
				...directTags
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
		this.chargeRows(row ? 1 : 0, "read");
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
		this.chargeRows(existing ? 1 : 0, "read");
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
	async listNotificationTargets(ids = []) {
		if (!ids.length) return [];
		const page = ids.slice(0, 20);
		const placeholders = page.map((_, index) => `?${index + 1}`).join(",");
		const result = await this.db.prepare(`SELECT * FROM notification_targets WHERE enabled=1 AND id IN (${placeholders}) LIMIT 20`).bind(...page).all();
		this.chargeMeta(result.meta);
		return result.results;
	}
	async notificationAllowed(targetId, kind) {
		const now = Date.now();
		const result = await this.db.prepare(`SELECT
         SUM(CASE WHEN created_at>=?2 THEN 1 ELSE 0 END) AS hourly,
         SUM(CASE WHEN created_at>=?3 THEN 1 ELSE 0 END) AS daily
       FROM notification_deliveries WHERE target_id=?1 AND created_at>=?3`).bind(targetId, now - 36e5, now - 864e5).first();
		this.chargeRows(result ? 1 : 0, "read");
		return Number(result?.hourly ?? 0) < 20 && (kind !== "twilio" || Number(result?.daily ?? 0) < 5);
	}
	async recordNotification(targetId, incidentId, kind, result) {
		const written = await this.db.prepare(`INSERT INTO notification_deliveries(id,target_id,incident_id,kind,ok,status_code,error,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`).bind(crypto.randomUUID(), targetId, incidentId, kind, result.ok ? 1 : 0, result.status ?? null, result.error?.slice(0, 2e3) ?? null, Date.now()).run();
		this.chargeMeta(written.meta);
	}
	chargeMeta(meta) {
		this.chargeRows(meta.rows_read ?? 0, "read");
		this.chargeRows(meta.rows_written ?? meta.changes ?? 0, "write");
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
var AUTOMATIC_WORKER_COOLDOWN_MS = 9e5;
var AUTOMATIC_ACCOUNT_WINDOW_MS = 36e5;
var MAX_AUTOMATIC_DEPLOYMENTS_PER_HOUR = 3;
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
	const automaticHolder = automatic ? crypto.randomUUID() : null;
	try {
		if (automaticHolder && !await acquireControlLease(env.DB, "fuse:automatic-account", automaticHolder, 3e4)) throw new AutomaticDeploymentLimitError("Another automatic deployment is already in progress for this account");
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
		if (automaticHolder) await releaseControlLease(env.DB, "fuse:automatic-account", automaticHolder);
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
	const error = automaticDeploymentCapacityError(worker?.created_at ?? null, Number(account?.count ?? 0), now);
	if (error) throw new AutomaticDeploymentLimitError(error.replace("{worker}", workerScript));
}
function automaticDeploymentCapacityError(lastWorkerDeploymentAt, accountDeployments, now) {
	if (lastWorkerDeploymentAt !== null && lastWorkerDeploymentAt > now - AUTOMATIC_WORKER_COOLDOWN_MS) return "Automatic deployment cooldown is active for {worker}";
	return accountDeployments >= MAX_AUTOMATIC_DEPLOYMENTS_PER_HOUR ? "Brolly's automatic deployment circuit breaker is open for one hour" : null;
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
//#region src/ledger-accumulator.ts
function applyAccumulatorObservations(input, observations, resourceIds, aggregationKinds, cycleSeeds) {
	const payload = input ?? { resources: {} };
	const changes = /* @__PURE__ */ new Map();
	for (const observation of observations) {
		const resourceId = requiredResourceId(resourceIds, observation);
		const metricDefinitionId = `${observation.sample.asset.family}:${observation.sample.metric}`;
		const resource = payload.resources[resourceId] ??= {
			metrics: {},
			windows: {},
			updatedAt: observation.sample.end
		};
		const seed = cycleSeeds.get(resourceId)?.[metricDefinitionId];
		const metric = resource.metrics[metricDefinitionId] ??= {
			day: 0,
			cycle: seed?.value ?? 0,
			estimatedDayUsd: 0,
			estimatedCycleUsd: seed?.estimatedCostUsd ?? 0,
			cycleSeedValue: seed?.value ?? 0,
			baseline: [],
			quality: "complete",
			sampleInterval: 1,
			cycleQuality: seed?.quality ?? "complete",
			cycleSampleInterval: seed?.sampleInterval ?? 1,
			cycleSeedQuality: seed?.quality ?? "complete",
			cycleSeedSampleInterval: seed?.sampleInterval ?? 1,
			watermarkAt: null
		};
		const windowKey = `${observation.collectorKey}:${observation.dataset}:${observation.sample.start}:${observation.sample.end}`;
		const window = resource.windows[windowKey] ??= {};
		const previous = window[metricDefinitionId];
		const next = {
			value: observation.sample.value,
			estimatedCostUsd: observation.sample.estimatedCostUsd ?? 0,
			quality: observation.quality,
			sampleInterval: observation.sampleInterval,
			watermarkAt: observation.watermarkAt
		};
		const aggregation = aggregationKinds.get(metricDefinitionId) ?? "sum";
		const rollingBaseline = median(metric.baseline);
		if (aggregation === "sum") {
			metric.day += next.value - (previous?.value ?? 0);
			metric.cycle += next.value - (previous?.value ?? 0);
			metric.estimatedDayUsd += next.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0);
			metric.estimatedCycleUsd += next.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0);
		} else {
			metric.estimatedDayUsd += next.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0);
			metric.estimatedCycleUsd += next.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0);
		}
		window[metricDefinitionId] = next;
		if (!previous || previous.value !== next.value) metric.baseline = [...metric.baseline, next.value].slice(-12);
		resource.updatedAt = Math.max(resource.updatedAt, observation.sample.end);
		trimWindows(resource);
		if (aggregation === "maximum") {
			const retained = Object.values(resource.windows).map((values) => values[metricDefinitionId]?.value).filter((value) => value !== void 0);
			metric.day = Math.max(resource.trimmedMaximum?.[metricDefinitionId] ?? 0, ...retained);
			metric.cycle = Math.max(metric.cycleSeedValue ?? 0, metric.day);
		} else if (aggregation === "latest") {
			metric.day = next.value;
			metric.cycle = next.value;
		}
		metric.quality = worstQuality([...resource.trimmedQuality?.[metricDefinitionId] ? [resource.trimmedQuality[metricDefinitionId]] : [], ...Object.values(resource.windows).map((values) => values[metricDefinitionId]?.quality).filter(Boolean)]);
		metric.sampleInterval = worstSampleInterval([resource.trimmedSampleInterval?.[metricDefinitionId], ...Object.values(resource.windows).map((windowValues) => windowValues[metricDefinitionId]?.sampleInterval)]);
		metric.cycleQuality = worstQuality([metric.cycleSeedQuality ?? "complete", metric.quality]);
		metric.cycleSampleInterval = worstSampleInterval([metric.cycleSeedSampleInterval, metric.sampleInterval]);
		metric.watermarkAt = maximumWatermark(resource.windows, metricDefinitionId);
		const changeKey = `${resourceId}:${metricDefinitionId}`;
		const priorChange = changes.get(changeKey);
		const latestEvidence = !priorChange || observation.sample.end >= priorChange.periodEndAt;
		changes.set(changeKey, {
			resourceId,
			metricDefinitionId,
			metricKey: observation.sample.metric,
			intervalValue: latestEvidence ? next.value : priorChange.intervalValue,
			dayValue: metric.day,
			cycleValue: metric.cycle,
			estimatedDayUsd: metric.estimatedDayUsd,
			estimatedCycleUsd: metric.estimatedCycleUsd,
			quality: metric.quality,
			sampleInterval: latestEvidence ? next.sampleInterval : priorChange.sampleInterval,
			cycleQuality: metric.cycleQuality,
			cycleSampleInterval: metric.cycleSampleInterval,
			watermarkAt: latestEvidence ? next.watermarkAt : priorChange.watermarkAt,
			rollingBaseline: latestEvidence ? rollingBaseline : priorChange.rollingBaseline,
			periodStartAt: latestEvidence ? observation.sample.start : priorChange.periodStartAt,
			periodEndAt: latestEvidence ? observation.sample.end : priorChange.periodEndAt,
			historical: latestEvidence ? observation.historical : priorChange.historical
		});
	}
	return {
		payload,
		changes: [...changes.values()]
	};
}
function median(values) {
	if (!values.length) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + sorted[middle]) / 2;
}
function trimWindows(resource) {
	const keys = Object.keys(resource.windows);
	if (keys.length <= 16) return;
	keys.sort((left, right) => windowEnd(left) - windowEnd(right));
	for (const key of keys.slice(0, keys.length - 16)) {
		const windowValues = resource.windows[key];
		for (const [metricId, value] of Object.entries(windowValues ?? {})) {
			resource.trimmedQuality ??= {};
			resource.trimmedSampleInterval ??= {};
			resource.trimmedMaximum ??= {};
			resource.trimmedQuality[metricId] = worstQuality([resource.trimmedQuality[metricId] ?? "complete", value.quality]);
			resource.trimmedSampleInterval[metricId] = worstSampleInterval([resource.trimmedSampleInterval[metricId], value.sampleInterval]);
			resource.trimmedMaximum[metricId] = Math.max(resource.trimmedMaximum[metricId] ?? 0, value.value);
		}
		delete resource.windows[key];
	}
}
function windowEnd(key) {
	return Number(key.split(":").at(-1)) || 0;
}
function worstSampleInterval(values) {
	if (values.some((value) => value === null)) return null;
	const numbers = values.filter((value) => value !== void 0);
	return numbers.length ? Math.max(...numbers) : 1;
}
function maximumWatermark(windows, metricId) {
	const values = Object.values(windows).map((window) => window[metricId]?.watermarkAt).filter((value) => value !== null && value !== void 0);
	return values.length ? Math.max(...values) : null;
}
function requiredResourceId(resourceIds, observation) {
	const id = resourceIds.get(observation);
	if (!id) throw new Error("Usage observation is missing a canonical resource id");
	return id;
}
//#endregion
//#region src/ledger-store.ts
var MAX_BATCH$3 = 100;
var MAX_SHARD_BYTES = 15e5;
var SPLIT_DEPTH = 4;
var AGGREGATION_BY_METRIC = new Map(METRIC_DEFINITIONS.map((definition) => [definition.id, definition.aggregationKind]));
var LedgerStore = class {
	db;
	budget;
	constructor(db, budget) {
		this.db = db;
		this.budget = budget;
	}
	async syncMetricCatalog() {
		const statements = METRIC_DEFINITIONS.map((definition) => this.db.prepare(`INSERT INTO metric_definitions(
         id,product_family,metric_key,display_name,unit,aggregation_kind,billing_mapping,
         collector_key,finest_scope,pricing_version_id,active,catalog_version
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
       ON CONFLICT(id) DO UPDATE SET
         display_name=excluded.display_name,unit=excluded.unit,aggregation_kind=excluded.aggregation_kind,
         billing_mapping=excluded.billing_mapping,collector_key=excluded.collector_key,
         finest_scope=excluded.finest_scope,pricing_version_id=excluded.pricing_version_id,
         active=excluded.active,catalog_version=excluded.catalog_version`).bind(definition.id, definition.productFamily, definition.metricKey, definition.displayName, definition.unit, definition.aggregationKind, definition.billingMapping, definition.collectorKey, definition.finestScope, definition.pricingVersionId ?? null, definition.active ? 1 : 0, METRIC_CATALOG_VERSION));
		await this.writeBatches(statements);
	}
	async claimDueCollector(accountId, collectorKey, cadenceMs, now, force = false) {
		const result = await this.db.prepare(`INSERT INTO collector_state(
         account_id,collector_key,partition_key,next_eligible_at,last_started_at,last_status
       ) VALUES(?1,?2,'',?3,?4,'running')
       ON CONFLICT(account_id,collector_key,partition_key) DO UPDATE SET
         next_eligible_at=excluded.next_eligible_at,last_started_at=excluded.last_started_at,last_status='running',last_error=NULL
       WHERE ?5=1 OR collector_state.next_eligible_at<=?4 OR collector_state.last_status='running' AND collector_state.last_started_at<?6`).bind(accountId, collectorKey, now + cadenceMs, now, force ? 1 : 0, now - 2 * cadenceMs).run();
		this.chargeMeta(result.meta);
		return Number(result.meta.changes ?? 0) === 1;
	}
	async collectorCursor(accountId, collectorKey, partitionKey = "") {
		const row = await this.db.prepare(`SELECT cursor_json FROM collector_state WHERE account_id=?1 AND collector_key=?2 AND partition_key=?3 LIMIT 1`).bind(accountId, collectorKey, partitionKey).first();
		this.chargeRead(row ? 1 : 0);
		if (!row?.cursor_json) return null;
		try {
			return JSON.parse(row.cursor_json);
		} catch {
			return null;
		}
	}
	async startMonitorRun(accountId, kind, now = Date.now()) {
		const id = crypto.randomUUID();
		const result = await this.db.prepare(`INSERT INTO monitor_runs(id,account_id,kind,started_at,status,coverage_status)
       VALUES(?1,?2,?3,?4,'running','partial')`).bind(id, accountId, kind, now).run();
		this.chargeMeta(result.meta);
		return id;
	}
	async finishMonitorRun(runId, accountId, localDay, values) {
		const now = Date.now();
		const usage = this.budget?.usage;
		const errors = values.errors ?? [];
		const deferred = values.deferredCollectors ?? [];
		const estimatedCostUsd = estimateMonitoringCost({
			graphqlQueries: usage?.graphqlQueries ?? 0,
			restRequests: usage?.restRequests ?? 0,
			d1RowsRead: usage?.d1RowsRead ?? 0,
			d1RowsWritten: usage?.d1RowsWritten ?? 0,
			workerCpuMs: now - values.startedAt
		});
		const results = await this.db.batch([this.db.prepare(`UPDATE monitor_runs SET
           completed_at=?2,duration_ms=?3,graphql_queries=?4,rest_requests=?5,datasets_queried=?6,
           rows_returned=?7,d1_rows_read=?8,d1_rows_written=?9,samples_normalized=?10,
           continuation_json=?11,errors_json=?12,deferred_collectors_json=?13,
           coverage_status=?14,status=?15 WHERE id=?1`).bind(runId, now, now - values.startedAt, usage?.graphqlQueries ?? 0, usage?.restRequests ?? 0, values.datasetsQueried, values.rowsReturned, usage?.d1RowsRead ?? 0, usage?.d1RowsWritten ?? 0, values.samplesNormalized, values.continuation === void 0 ? null : JSON.stringify(values.continuation), JSON.stringify(errors), JSON.stringify(deferred), values.complete ? "complete" : "partial", errors.length ? "failed" : values.complete ? "complete" : "partial"), this.db.prepare(`INSERT INTO monitor_usage_daily(
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
           deferred_collectors_json=excluded.deferred_collectors_json,updated_at=excluded.updated_at`).bind(accountId, localDay, usage?.graphqlQueries ?? 0, this.budget?.limits.graphqlQueries ?? 0, usage?.restRequests ?? 0, this.budget?.limits.restRequests ?? 0, usage?.d1RowsRead ?? 0, usage?.d1RowsWritten ?? 0, now - values.startedAt, estimatedCostUsd, JSON.stringify(deferred), now)]);
		for (const result of results) this.chargeMeta(result.meta);
	}
	async saveResourceHierarchy(observations, recordActivity = true) {
		const resources = /* @__PURE__ */ new Map();
		const observationIds = /* @__PURE__ */ new Map();
		for (const observation of observations) {
			const exact = resourceFromAsset(observation.sample.asset, observation.quality, recordActivity && observation.sample.value > 0 ? observation.sample.end : null);
			observationIds.set(observation, exact.id);
			resources.set(exact.id, exact);
			for (const parent of parentResources(observation.sample.asset, observation.quality, observation.sample.end)) resources.set(parent.id, parent);
		}
		const orderedResources = [...resources.values()].sort((left, right) => resourceDepth(left) - resourceDepth(right));
		this.budget?.observePeak("resourcesPerTransaction", Math.min(orderedResources.length, this.transactionLimit()));
		const statements = orderedResources.map((resource) => this.db.prepare(`INSERT INTO resources(
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
          OR json_patch(resources.metadata_json,excluded.metadata_json)!=resources.metadata_json`).bind(resource.id, resource.accountId, resource.parentResourceId, resource.productFamily, resource.resourceType, resource.cloudflareId, resource.displayName, resource.firstSeenAt, resource.lastSeenAt, resource.lastActiveAt, resource.coverageStatus, resource.controlCapability, resource.runtimeFuseStatus, resource.autoQuarantinePolicy, resource.tier, resource.excluded ? 1 : 0, observations.find((item) => observationIds.get(item) === resource.id)?.collectorKey ?? null, observations.find((item) => observationIds.get(item) === resource.id)?.dataset ?? null, JSON.stringify(resource.metadata)));
		await this.writeBatches(statements);
		return observationIds;
	}
	async saveCapabilities(items) {
		const statements = items.map((item) => this.db.prepare(`INSERT INTO collector_capabilities(
         account_id,collector_key,dataset,available,retention_days,sampling_behavior,finest_scope,
         last_verified_at,error_code,human_explanation,state,watermark_at
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
       ON CONFLICT(account_id,collector_key,dataset) DO UPDATE SET
         available=excluded.available,retention_days=excluded.retention_days,
         sampling_behavior=excluded.sampling_behavior,finest_scope=excluded.finest_scope,
         last_verified_at=excluded.last_verified_at,error_code=excluded.error_code,
         human_explanation=excluded.human_explanation,state=excluded.state,watermark_at=excluded.watermark_at`).bind(item.accountId, item.collectorKey, item.dataset, item.available ? 1 : 0, item.retentionDays, item.samplingBehavior, item.finestScope, item.lastVerifiedAt, item.errorCode, item.humanExplanation, item.state, item.watermarkAt));
		await this.writeBatches(statements);
	}
	async saveInventory(assets, collectorKey = "rest:inventory", dataset = "account-resources") {
		if (!assets.length) return;
		const now = Date.now();
		const observations = assets.map((asset) => ({
			collectorKey,
			dataset,
			sample: {
				asset,
				metric: "__inventory__",
				unit: "count",
				value: 0,
				start: now,
				end: now,
				source: "rest"
			},
			quality: "complete",
			sampleInterval: 1,
			watermarkAt: now,
			historical: false
		}));
		await this.saveResourceHierarchy(observations, false);
	}
	async currentBillingCycle(accountId, now) {
		const row = await this.db.prepare(`SELECT id,starts_at,ends_at,approximate FROM billing_cycles
       WHERE account_id=?1 AND starts_at<=?2 AND ends_at>?2
       ORDER BY approximate ASC,reconciled_at DESC LIMIT 1`).bind(accountId, now).first();
		this.chargeRead(row ? 1 : 0);
		if (row) return {
			id: row.id,
			startsAt: row.starts_at,
			endsAt: row.ends_at,
			approximate: row.approximate === 1
		};
		const date = new Date(now);
		const startsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
		const endsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
		const id = `${accountId}:${startsAt}:${endsAt}`;
		const result = await this.db.prepare(`INSERT OR IGNORE INTO billing_cycles(id,account_id,starts_at,ends_at,status,currency,approximate)
       VALUES(?1,?2,?3,?4,'open','USD',1)`).bind(id, accountId, startsAt, endsAt).run();
		this.chargeMeta(result.meta);
		return {
			id,
			startsAt,
			endsAt,
			approximate: true
		};
	}
	async applyObservations(observations, timeZone) {
		if (!observations.length) return [];
		const resourceIds = await this.saveResourceHierarchy(observations, true);
		const cyclesByTimestamp = /* @__PURE__ */ new Map();
		for (const observation of observations) {
			const timestamp = Math.max(observation.sample.start, observation.sample.end - 1);
			if (!cyclesByTimestamp.has(timestamp)) cyclesByTimestamp.set(timestamp, await this.currentBillingCycle(observation.sample.asset.accountId, timestamp));
		}
		const observationsByCycle = /* @__PURE__ */ new Map();
		for (const observation of observations) {
			const timestamp = Math.max(observation.sample.start, observation.sample.end - 1);
			const cycleId = cyclesByTimestamp.get(timestamp).id;
			observationsByCycle.set(cycleId, [...observationsByCycle.get(cycleId) ?? [], observation]);
		}
		const groups = await this.loadShards([...observationsByCycle.entries()].flatMap(([cycleId, items]) => groupObservations(items, resourceIds, cycleId, timeZone)));
		const seedsByCycle = /* @__PURE__ */ new Map();
		for (const cycleId of observationsByCycle.keys()) seedsByCycle.set(cycleId, await this.loadCycleSeeds(groups.filter((group) => group.billingCycleId === cycleId), cycleId));
		const aggregationKinds = new Map(METRIC_DEFINITIONS.map((definition) => [definition.id, definition.aggregationKind]));
		const changes = [];
		const writes = [];
		const now = Date.now();
		for (const group of groups) {
			const applied = applyAccumulatorObservations(group.payload, group.observations, group.resourceIds, aggregationKinds, seedsByCycle.get(group.billingCycleId) ?? /* @__PURE__ */ new Map());
			changes.push(...applied.changes.map((change) => ({
				...change,
				localDay: group.localDay,
				billingCycleId: group.billingCycleId
			})));
			const parts = splitOversizedShard(group, applied.payload);
			if (parts.some((part) => part.group.splitDepth !== group.splitDepth)) writes.push(this.db.prepare(`DELETE FROM usage_accumulator_shards
         WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND local_day=?4
           AND billing_cycle_id=?5 AND resource_hash_bucket=?6`).bind(group.accountId, group.productFamily, group.scopeType, group.localDay, group.billingCycleId, group.bucket));
			for (const part of parts) {
				const payloadJson = JSON.stringify(part.payload);
				if (new TextEncoder().encode(payloadJson).byteLength > MAX_SHARD_BYTES) throw new Error(`Usage accumulator shard ${part.group.key} exceeded its safe row size after splitting`);
				writes.push(this.db.prepare(`INSERT INTO usage_accumulator_shards(
             account_id,product_family,scope_type,local_day,billing_cycle_id,resource_hash_bucket,
             split_depth,split_segment,payload_json,source_watermarks_json,quality_flags_json,version,updated_at
           ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'{}','[]',?10,?11)
           ON CONFLICT(account_id,product_family,scope_type,local_day,billing_cycle_id,resource_hash_bucket,split_depth,split_segment)
           DO UPDATE SET payload_json=excluded.payload_json,version=excluded.version,updated_at=excluded.updated_at`).bind(part.group.accountId, part.group.productFamily, part.group.scopeType, part.group.localDay, part.group.billingCycleId, part.group.bucket, part.group.splitDepth, part.group.splitSegment, payloadJson, part.group.version + 1, now));
			}
		}
		await this.writeBatches(writes);
		const reconciled = await this.reconcilePeriodChanges(changes);
		return [...reconciled, ...costChanges(reconciled)];
	}
	async sealCompletedDays(accountId, timeZone, now = Date.now(), shardLimit = 16) {
		const today = localDayAt(now, timeZone);
		const rows = await this.db.prepare(`SELECT account_id,product_family,scope_type,local_day,billing_cycle_id,resource_hash_bucket,
         split_depth,split_segment,payload_json,version,updated_at
       FROM usage_accumulator_shards
       WHERE account_id=?1 AND local_day<?2
         AND (json_extract(payload_json,'$.sealedAt') IS NULL OR updated_at>json_extract(payload_json,'$.sealedAt'))
       ORDER BY local_day ASC,resource_hash_bucket ASC LIMIT ?3`).bind(accountId, today, shardLimit).all();
		this.chargeMeta(rows.meta);
		let sealed = 0;
		const dailyPayloadCache = /* @__PURE__ */ new Map();
		const cyclePayloadCache = /* @__PURE__ */ new Map();
		for (const row of rows.results) {
			const payload = parsePayload(String(row.payload_json));
			const bounds = localDayBounds(String(row.local_day), timeZone);
			const dailyCacheKey = [
				row.account_id,
				row.product_family,
				row.scope_type,
				row.local_day,
				row.resource_hash_bucket
			].join("|");
			let dailyPayloads = dailyPayloadCache.get(dailyCacheKey);
			if (!dailyPayloads) {
				const related = await this.db.prepare(`SELECT payload_json FROM usage_accumulator_shards
           WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND local_day=?4
             AND resource_hash_bucket=?5`).bind(row.account_id, row.product_family, row.scope_type, row.local_day, row.resource_hash_bucket).all();
				this.chargeMeta(related.meta);
				dailyPayloads = related.results.map((item) => parsePayload(item.payload_json));
				dailyPayloadCache.set(dailyCacheKey, dailyPayloads);
			}
			const cycleCacheKey = [
				row.account_id,
				row.product_family,
				row.scope_type,
				row.billing_cycle_id,
				row.resource_hash_bucket
			].join("|");
			let cyclePayloads = cyclePayloadCache.get(cycleCacheKey);
			if (!cyclePayloads) {
				const related = await this.db.prepare(`SELECT payload_json FROM usage_accumulator_shards
           WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND billing_cycle_id=?4
             AND resource_hash_bucket=?5`).bind(row.account_id, row.product_family, row.scope_type, row.billing_cycle_id, row.resource_hash_bucket).all();
				this.chargeMeta(related.meta);
				cyclePayloads = related.results.map((item) => parsePayload(item.payload_json));
				cyclePayloadCache.set(cycleCacheKey, cyclePayloads);
			}
			const statements = [];
			for (const id of Object.keys(payload.resources)) {
				const daily = aggregateDailyResource(dailyPayloads, id);
				const cycle = aggregateDailyResource(cyclePayloads, id);
				const metrics = daily.metrics;
				const cycleMetrics = cycle.metrics;
				const estimatedDay = daily.estimatedCostUsd;
				const estimatedCycle = cycle.estimatedCostUsd;
				const cycleQuality = cycle.quality;
				const cycleSampling = cycle.sampling;
				statements.push(this.db.prepare(`INSERT INTO usage_daily(
             resource_id,local_day,period_start_at,period_end_at,metrics_json,estimated_cost_usd,
             authoritative_allocated_cost_usd,completeness,sampling_json,sealed,revision,revised_at
           ) VALUES(?1,?2,?3,?4,?5,?6,NULL,?7,?8,1,1,?9)
           ON CONFLICT(resource_id,local_day) DO UPDATE SET
             metrics_json=json_patch(usage_daily.metrics_json,excluded.metrics_json),estimated_cost_usd=excluded.estimated_cost_usd,
             completeness=excluded.completeness,sampling_json=excluded.sampling_json,sealed=1,
             revision=usage_daily.revision+1,revised_at=excluded.revised_at`).bind(id, row.local_day, bounds.start, bounds.end, JSON.stringify(metrics), estimatedDay, daily.quality, JSON.stringify(daily.sampling), now));
				statements.push(this.db.prepare(`INSERT INTO usage_cycle_totals(
             resource_id,billing_cycle_id,metrics_json,estimated_cost_usd,authoritative_allocated_cost_usd,
             completeness,sampling_json,sealed,revision,revised_at
           ) VALUES(?1,?2,?3,?4,NULL,?5,?6,0,1,?7)
           ON CONFLICT(resource_id,billing_cycle_id) DO UPDATE SET
             metrics_json=json_patch(usage_cycle_totals.metrics_json,excluded.metrics_json),estimated_cost_usd=excluded.estimated_cost_usd,
             completeness=excluded.completeness,sampling_json=excluded.sampling_json,
             revision=usage_cycle_totals.revision+1,revised_at=excluded.revised_at`).bind(id, row.billing_cycle_id, JSON.stringify(cycleMetrics), estimatedCycle, cycleQuality, JSON.stringify(cycleSampling), now));
			}
			payload.sealedAt = now;
			statements.push(this.db.prepare(`UPDATE usage_accumulator_shards SET payload_json=?9,version=version+1,updated_at=?10
         WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND local_day=?4
           AND billing_cycle_id=?5 AND resource_hash_bucket=?6 AND split_depth=?7 AND split_segment=?8`).bind(row.account_id, row.product_family, row.scope_type, row.local_day, row.billing_cycle_id, row.resource_hash_bucket, row.split_depth, row.split_segment, JSON.stringify(payload), now));
			await this.writeBatches(statements);
			sealed += 1;
		}
		return sealed;
	}
	async reconcilePeriodChanges(changes) {
		const dailyCache = /* @__PURE__ */ new Map();
		const cycleCache = /* @__PURE__ */ new Map();
		const reconciled = [];
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
			const dailyKey = [
				accountId,
				productFamily,
				scopeType,
				change.localDay,
				bucket
			].join("|");
			let dailyPayloads = dailyCache.get(dailyKey);
			if (!dailyPayloads) {
				const result = await this.db.prepare(`SELECT payload_json FROM usage_accumulator_shards
           WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND local_day=?4
             AND resource_hash_bucket=?5`).bind(accountId, productFamily, scopeType, change.localDay, bucket).all();
				this.chargeMeta(result.meta);
				dailyPayloads = result.results.map((row) => parsePayload(row.payload_json));
				dailyCache.set(dailyKey, dailyPayloads);
			}
			const cycleKey = [
				accountId,
				productFamily,
				scopeType,
				change.billingCycleId,
				bucket
			].join("|");
			let cyclePayloads = cycleCache.get(cycleKey);
			if (!cyclePayloads) {
				const result = await this.db.prepare(`SELECT payload_json FROM usage_accumulator_shards
           WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND billing_cycle_id=?4
             AND resource_hash_bucket=?5`).bind(accountId, productFamily, scopeType, change.billingCycleId, bucket).all();
				this.chargeMeta(result.meta);
				cyclePayloads = result.results.map((row) => parsePayload(row.payload_json));
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
				sampleInterval: Object.hasOwn(daily.sampling, change.metricDefinitionId) ? daily.sampling[change.metricDefinitionId] : change.sampleInterval,
				cycleQuality: cycle.qualityByMetric[change.metricDefinitionId] ?? change.cycleQuality,
				cycleSampleInterval: Object.hasOwn(cycle.sampling, change.metricDefinitionId) ? cycle.sampling[change.metricDefinitionId] : change.cycleSampleInterval
			});
		}
		return reconciled;
	}
	async persistCollectorState(accountId, collectorKey, partitionKey, values) {
		const now = Date.now();
		const result = await this.db.prepare(`INSERT INTO collector_state(
         account_id,collector_key,partition_key,cursor_json,high_watermark_at,retry_count,next_eligible_at,
         last_started_at,last_completed_at,last_error,last_status
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
       ON CONFLICT(account_id,collector_key,partition_key) DO UPDATE SET
         cursor_json=excluded.cursor_json,high_watermark_at=excluded.high_watermark_at,
         retry_count=excluded.retry_count,next_eligible_at=excluded.next_eligible_at,
         last_completed_at=excluded.last_completed_at,last_error=excluded.last_error,last_status=excluded.last_status`).bind(accountId, collectorKey, partitionKey, values.cursor === void 0 ? null : JSON.stringify(values.cursor), values.watermarkAt ?? null, values.error ? 1 : 0, values.nextEligibleAt, now, values.status === "complete" ? now : null, values.error?.slice(0, 2e3) ?? null, values.status).run();
		this.chargeMeta(result.meta);
	}
	async loadShards(groups) {
		const statements = groups.map((group) => this.db.prepare(`SELECT payload_json,version,split_depth,split_segment FROM usage_accumulator_shards
       WHERE account_id=?1 AND product_family=?2 AND scope_type=?3 AND local_day=?4
         AND billing_cycle_id=?5 AND resource_hash_bucket=?6`).bind(group.accountId, group.productFamily, group.scopeType, group.localDay, group.billingCycleId, group.bucket));
		const results = await this.readBatches(statements);
		const expanded = [];
		for (let index = 0; index < groups.length; index += 1) {
			const base = groups[index];
			const rows = results[index]?.results;
			const depth = rows?.reduce((maximum, row) => Math.max(maximum, Number(row.split_depth)), 0) ?? 0;
			const bySegment = new Map((rows ?? []).filter((row) => Number(row.split_depth) === depth).map((row) => [Number(row.split_segment), row]));
			const partitions = /* @__PURE__ */ new Map();
			for (const observation of base.observations) {
				const id = base.resourceIds.get(observation);
				const segment = depth === 0 ? 0 : resourceHashSegment(id, depth);
				const row = bySegment.get(segment);
				const group = partitions.get(segment) ?? {
					...base,
					key: `${base.key}|${depth}|${segment}`,
					splitDepth: depth,
					splitSegment: segment,
					observations: [],
					resourceIds: /* @__PURE__ */ new Map(),
					payload: row ? parsePayload(row.payload_json) : null,
					version: Number(row?.version ?? 0)
				};
				group.observations.push(observation);
				group.resourceIds.set(observation, id);
				partitions.set(segment, group);
			}
			expanded.push(...partitions.values());
		}
		return expanded;
	}
	async loadCycleSeeds(groups, cycleId) {
		const emptyGroups = groups.filter((group) => !group.payload);
		const resourceIds = [...new Set(emptyGroups.flatMap((group) => [...group.resourceIds.values()]))];
		const statements = [];
		for (let offset = 0; offset < resourceIds.length; offset += 90) {
			const ids = resourceIds.slice(offset, offset + 90);
			const placeholders = ids.map((_, index) => `?${index + 2}`).join(",");
			statements.push(this.db.prepare(`SELECT resource_id,metrics_json,estimated_cost_usd,completeness,sampling_json FROM usage_cycle_totals
         WHERE billing_cycle_id=?1 AND resource_id IN (${placeholders})`).bind(cycleId, ...ids));
		}
		const seeds = /* @__PURE__ */ new Map();
		for (const result of await this.readBatches(statements)) for (const row of result.results) {
			const metrics = parseNumberMap$1(row.metrics_json);
			const sampling = parseNullableNumberMap(row.sampling_json);
			const estimated = Number(row.estimated_cost_usd ?? 0);
			const total = Object.values(metrics).reduce((sum, value) => sum + Math.abs(value), 0) || 1;
			seeds.set(row.resource_id, Object.fromEntries(Object.entries(metrics).map(([metricId, value]) => [metricId, {
				value,
				estimatedCostUsd: estimated * Math.abs(value) / total,
				quality: row.completeness,
				sampleInterval: sampling[metricId] ?? null
			}])));
		}
		const priorShardStatements = emptyGroups.map((group) => this.db.prepare(`SELECT payload_json FROM usage_accumulator_shards
       WHERE account_id=?1 AND product_family=?2 AND scope_type=?3
         AND billing_cycle_id=?4 AND resource_hash_bucket=?5 AND local_day<?6
       ORDER BY local_day DESC,split_depth DESC,split_segment ASC LIMIT 16`).bind(group.accountId, group.productFamily, group.scopeType, group.billingCycleId, group.bucket, group.localDay));
		const priorShards = await this.readBatches(priorShardStatements);
		for (let index = 0; index < emptyGroups.length; index += 1) {
			const rows = priorShards[index]?.results;
			const wanted = new Set(emptyGroups[index].resourceIds.values());
			for (const row of rows ?? []) {
				if (!row.payload_json) continue;
				const prior = parsePayload(row.payload_json);
				for (const resourceIdValue of wanted) {
					if (seeds.has(resourceIdValue) && prior.resources[resourceIdValue] === void 0) continue;
					const resource = prior.resources[resourceIdValue];
					if (!resource) continue;
					seeds.set(resourceIdValue, Object.fromEntries(Object.entries(resource.metrics).map(([metricId, metric]) => [metricId, {
						value: metric.cycle,
						estimatedCostUsd: metric.estimatedCycleUsd,
						quality: metric.cycleQuality ?? metric.quality,
						sampleInterval: metric.cycleSampleInterval ?? metric.sampleInterval
					}])));
					wanted.delete(resourceIdValue);
				}
				if (!wanted.size) break;
			}
		}
		return seeds;
	}
	async readBatches(statements) {
		const output = [];
		const batchSize = this.transactionLimit();
		for (let offset = 0; offset < statements.length; offset += batchSize) {
			const results = await this.db.batch(statements.slice(offset, offset + batchSize));
			for (const result of results) {
				this.chargeMeta(result.meta);
				output.push(result);
			}
		}
		return output;
	}
	async writeBatches(statements) {
		const batchSize = this.transactionLimit();
		for (let offset = 0; offset < statements.length; offset += batchSize) {
			const results = await this.db.batch(statements.slice(offset, offset + batchSize));
			for (const result of results) this.chargeMeta(result.meta);
		}
	}
	chargeRead(amount) {
		this.budget?.charge("d1RowsRead", amount);
	}
	transactionLimit() {
		return Math.max(1, Math.min(MAX_BATCH$3, this.budget?.limits.resourcesPerTransaction ?? MAX_BATCH$3));
	}
	chargeMeta(meta) {
		this.budget?.charge("d1RowsRead", meta.rows_read ?? 0);
		this.budget?.charge("d1RowsWritten", meta.rows_written ?? meta.changes ?? 0);
	}
};
function estimateMonitoringCost(values) {
	const workerRequests = .3 / 1e6;
	const cpu = values.workerCpuMs * (.02 / 1e6);
	const reads = values.d1RowsRead * (.001 / 1e6);
	const writes = values.d1RowsWritten * (1 / 1e6);
	return workerRequests + cpu + reads + writes;
}
function expandUsageObservations(samples, collectorKey, dataset, quality, options = {}) {
	const observations = /* @__PURE__ */ new Map();
	for (const sample of samples) {
		const scopes = hierarchySamples(sample);
		for (const scoped of scopes) {
			const key = [
				scoped.asset.family,
				scoped.asset.scope,
				scoped.asset.id,
				scoped.metric,
				scoped.start,
				scoped.end
			].join(":");
			const existing = observations.get(key);
			if (existing) {
				existing.sample.value += scoped.value;
				existing.sample.estimatedCostUsd = (existing.sample.estimatedCostUsd ?? 0) + (scoped.estimatedCostUsd ?? 0);
				continue;
			}
			observations.set(key, {
				collectorKey,
				dataset,
				sample: structuredClone(scoped),
				quality: scoped.sampled ? "sampled" : quality,
				sampleInterval: options.sampleInterval ?? (scoped.sampled ? null : 1),
				watermarkAt: options.watermarkAt ?? scoped.end,
				historical: options.historical ?? false
			});
		}
	}
	return [...observations.values()];
}
function groupObservations(observations, ids, cycleId, timeZone) {
	const groups = /* @__PURE__ */ new Map();
	for (const observation of observations) {
		const id = ids.get(observation);
		const day = localDayAt(Math.max(observation.sample.start, observation.sample.end - 1), timeZone);
		const scopeType = resourceType(observation.sample.asset);
		const shardFamily = scopeType === "account" ? "account" : observation.sample.asset.family;
		const bucket = resourceHashBucket(id);
		const key = [
			observation.sample.asset.accountId,
			shardFamily,
			scopeType,
			day,
			cycleId,
			bucket
		].join("|");
		const group = groups.get(key) ?? {
			key,
			accountId: observation.sample.asset.accountId,
			productFamily: shardFamily,
			scopeType,
			localDay: day,
			billingCycleId: cycleId,
			bucket,
			observations: [],
			resourceIds: /* @__PURE__ */ new Map(),
			splitDepth: 0,
			splitSegment: 0,
			payload: null,
			version: 0
		};
		group.observations.push(observation);
		group.resourceIds.set(observation, id);
		groups.set(key, group);
	}
	return [...groups.values()];
}
function resourceFromAsset(asset, quality, activeAt) {
	const type = resourceType(asset);
	const parentResourceId = parentId(asset);
	const canonicalFamily = type === "account" ? "account" : asset.family;
	const tags = asset.tags ?? {};
	const controlCapability = asset.family === "queues" ? "queue_pause" : tags.brollyFuse === "true" && (asset.family === "workers" || asset.family === "durable_objects") ? "runtime_fuse" : "none";
	const controlPlane = asset.tier === "control_plane" || tags.brollyControlPlane === "true";
	const now = activeAt ?? Date.now();
	return {
		id: resourceId(asset.accountId, canonicalFamily, type, asset.id),
		accountId: asset.accountId,
		parentResourceId,
		productFamily: canonicalFamily,
		resourceType: type,
		cloudflareId: asset.id,
		displayName: asset.name ?? asset.id,
		firstSeenAt: now,
		lastSeenAt: now,
		lastActiveAt: activeAt,
		coverageStatus: quality,
		controlCapability,
		runtimeFuseStatus: tags.brollyFuseVerified === "true" ? "verified" : tags.brollyFuse === "true" ? "declared" : "unknown",
		autoQuarantinePolicy: "inherit",
		tier: asset.tier,
		excluded: controlPlane,
		metadata: tags
	};
}
function parentResources(asset, quality, seenAt) {
	const account = {
		accountId: asset.accountId,
		family: "account",
		id: asset.accountId,
		name: "Cloudflare account",
		scope: "account",
		tier: "unclassified",
		tags: { ledgerLevel: "account" }
	};
	const product = {
		accountId: asset.accountId,
		family: asset.family,
		id: asset.family,
		name: productName(asset.family),
		scope: "account",
		tier: "unclassified",
		tags: { ledgerLevel: "product" }
	};
	const parents = [resourceFromAsset(account, quality, seenAt), resourceFromAsset(product, quality, seenAt)];
	if (asset.scope === "object" && asset.parentId) parents.push(resourceFromAsset({
		accountId: asset.accountId,
		family: asset.family,
		id: asset.parentId,
		name: asset.parentId,
		scope: "namespace",
		tier: asset.tier,
		tags: asset.tags
	}, quality, seenAt));
	return parents;
}
function hierarchySamples(sample) {
	const values = [sample];
	if (sample.asset.scope === "object" && sample.asset.parentId) values.push({
		...sample,
		asset: {
			accountId: sample.asset.accountId,
			family: sample.asset.family,
			id: sample.asset.parentId,
			name: sample.asset.parentId,
			scope: "namespace",
			tier: sample.asset.tier,
			tags: sample.asset.tags
		}
	});
	values.push({
		...sample,
		asset: {
			accountId: sample.asset.accountId,
			family: sample.asset.family,
			id: sample.asset.family,
			name: productName(sample.asset.family),
			scope: "account",
			tier: "unclassified",
			tags: { ledgerLevel: "product" }
		}
	});
	values.push({
		...sample,
		asset: {
			accountId: sample.asset.accountId,
			family: sample.asset.family,
			id: sample.asset.accountId,
			name: "Cloudflare account",
			scope: "account",
			tier: "unclassified",
			tags: { ledgerLevel: "account" }
		}
	});
	return values;
}
function resourceType(asset) {
	const level = asset.tags?.ledgerLevel;
	return level === "account" || level === "product" ? level : `${asset.family}:${asset.scope}`;
}
function parentId(asset) {
	const type = resourceType(asset);
	if (type === "account") return null;
	if (type === "product") return resourceId(asset.accountId, "account", "account", asset.accountId);
	if (asset.scope === "object" && asset.parentId) return resourceId(asset.accountId, asset.family, `${asset.family}:namespace`, asset.parentId);
	return resourceId(asset.accountId, asset.family, "product", asset.family);
}
function productName(family) {
	return family.replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase());
}
function resourceDepth(resource) {
	if (resource.resourceType === "account") return 0;
	if (resource.resourceType === "product") return 1;
	if (resource.resourceType.endsWith(":namespace")) return 2;
	return 3;
}
function parsePayload(value) {
	try {
		const parsed = JSON.parse(value);
		return parsed && parsed.resources ? parsed : { resources: {} };
	} catch {
		return { resources: {} };
	}
}
function aggregateDailyResource(payloads, resourceIdValue) {
	const metrics = {};
	const estimatedByMetric = {};
	const qualityByMetric = {};
	const sampling = {};
	const qualities = [];
	let estimatedCostUsd = 0;
	for (const payload of payloads) {
		const resource = payload.resources[resourceIdValue];
		if (!resource) continue;
		for (const [metricId, metric] of Object.entries(resource.metrics)) {
			metrics[metricId] = AGGREGATION_BY_METRIC.get(metricId) === "maximum" ? Math.max(metrics[metricId] ?? Number.NEGATIVE_INFINITY, metric.day) : (metrics[metricId] ?? 0) + metric.day;
			estimatedByMetric[metricId] = (estimatedByMetric[metricId] ?? 0) + metric.estimatedDayUsd;
			estimatedCostUsd += metric.estimatedDayUsd;
			qualities.push(metric.quality);
			qualityByMetric[metricId] = worstQuality([qualityByMetric[metricId] ?? "complete", metric.quality]);
			const current = sampling[metricId];
			sampling[metricId] = current === null || metric.sampleInterval === null ? null : Math.max(current ?? 1, metric.sampleInterval);
		}
	}
	return {
		metrics,
		estimatedByMetric,
		estimatedCostUsd,
		quality: worstQuality(qualities),
		qualityByMetric,
		sampling
	};
}
function splitOversizedShard(group, payload) {
	if (new TextEncoder().encode(JSON.stringify(payload)).byteLength <= MAX_SHARD_BYTES || group.splitDepth > 0) return [{
		group,
		payload
	}];
	const resources = /* @__PURE__ */ new Map();
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
			splitSegment: segment
		},
		payload: {
			resources: partition,
			...payload.sealedAt === void 0 ? {} : { sealedAt: payload.sealedAt }
		}
	}));
}
function parseNumberMap$1(value) {
	try {
		const parsed = JSON.parse(value);
		return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === "number"));
	} catch {
		return {};
	}
}
function costChanges(changes) {
	const grouped = /* @__PURE__ */ new Map();
	for (const change of changes) {
		const key = [
			change.resourceId,
			change.localDay ?? "",
			change.billingCycleId ?? ""
		].join("|");
		grouped.set(key, [...grouped.get(key) ?? [], change]);
	}
	return [...grouped.values()].map((values) => {
		const first = values[0];
		const canonicalFamily = decodeURIComponent(first.resourceId.split(":")[1] ?? "") || first.metricDefinitionId.split(":")[0] || "unknown";
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
			quality: worstQuality(values.map((value) => value.quality)),
			sampleInterval: values.some((value) => value.sampleInterval === null) ? null : Math.max(...values.map((value) => value.sampleInterval ?? 1)),
			cycleQuality: worstQuality(values.map((value) => value.cycleQuality)),
			cycleSampleInterval: values.some((value) => value.cycleSampleInterval === null) ? null : Math.max(...values.map((value) => value.cycleSampleInterval ?? 1)),
			watermarkAt: values.reduce((minimum, value) => value.watermarkAt === null ? minimum : Math.min(minimum ?? value.watermarkAt, value.watermarkAt), null),
			rollingBaseline: values.reduce((sum, value) => sum + value.rollingBaseline, 0),
			periodStartAt: Math.min(...values.map((value) => value.periodStartAt)),
			periodEndAt: Math.max(...values.map((value) => value.periodEndAt)),
			historical: values.some((value) => value.historical)
		};
	});
}
function parseNullableNumberMap(value) {
	try {
		const parsed = JSON.parse(value);
		return Object.fromEntries(Object.entries(parsed).filter((entry) => entry[1] === null || typeof entry[1] === "number"));
	} catch {
		return {};
	}
}
//#endregion
//#region src/billing-ledger.ts
var MAX_BATCH$2 = 100;
async function reconcileBilling(env, client, budget, now = Date.now(), window) {
	const startsAt = window?.startsAt ?? now - 26784e5;
	const endsAt = window?.endsAt ?? now;
	const records = await client.billingUsage(startsAt, endsAt);
	if (!records) return {
		available: false,
		complete: false,
		records: 0,
		cycles: 0,
		unknownProducts: [],
		authoritativeCostUsd: null,
		alertChanges: []
	};
	const truncated = records.length > 2e4;
	const boundedRecords = records.slice(0, 2e4);
	const cycles = /* @__PURE__ */ new Map();
	const dailyAggregates = /* @__PURE__ */ new Map();
	const cycleAggregates = /* @__PURE__ */ new Map();
	const unknownProducts = /* @__PURE__ */ new Set();
	const resourceFamilies = /* @__PURE__ */ new Set();
	const billingMetrics = /* @__PURE__ */ new Set();
	const statements = [];
	const nowValue = Date.now();
	const timeZone = env.BROLLY_TIMEZONE ?? "UTC";
	for (const record of boundedRecords) {
		const family = normalizeFamily(record.x_ProductFamilyId ?? record.x_ProductFamilyName ?? "unknown");
		const metric = normalizeMetric(record.x_BillableMetricId ?? record.x_BillableMetricName ?? "unknown");
		const mappedMetric = billingCatalogMetric(family, metric);
		const mapped = mappedMetric !== null;
		if (!mapped) unknownProducts.add(`${family}/${metric}`);
		const chargeStart = safeDate(record.ChargePeriodStart, now - 864e5);
		const chargeEnd = safeDate(record.ChargePeriodEnd, now);
		const startsAt = safeDate(record.BillingPeriodStart, Date.UTC(new Date(chargeStart).getUTCFullYear(), new Date(chargeStart).getUTCMonth(), 1));
		const endsAt = safeDate(record.BillingPeriodEnd, Date.UTC(new Date(startsAt).getUTCFullYear(), new Date(startsAt).getUTCMonth() + 1, 1));
		const currency = record.BillingCurrency ?? "USD";
		const cycleId = `${env.BROLLY_ACCOUNT_ID}:${startsAt}:${endsAt}`;
		const cost = record.BilledCost ?? record.EffectiveCost ?? record.ListCost ?? 0;
		const cycle = cycles.get(cycleId) ?? {
			id: cycleId,
			startsAt,
			endsAt,
			currency,
			cost: 0
		};
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
			resourceId: productResourceId,
			periodKey: localDay,
			startsAt: localBounds.start,
			endsAt: localBounds.end,
			metricId,
			quantity: record.ConsumedQuantity,
			cost
		});
		addBillingAggregate(dailyAggregates, `${productResourceId}:${localDay}`, {
			resourceId: productResourceId,
			periodKey: localDay,
			startsAt: localBounds.start,
			endsAt: localBounds.end,
			metricId: billedMetricId,
			quantity: cost,
			cost: 0
		});
		addBillingAggregate(dailyAggregates, `${accountResourceId}:${localDay}`, {
			resourceId: accountResourceId,
			periodKey: localDay,
			startsAt: localBounds.start,
			endsAt: localBounds.end,
			metricId: "account:billed_cost_usd",
			quantity: cost,
			cost
		});
		addBillingAggregate(cycleAggregates, `${productResourceId}:${cycleId}`, {
			resourceId: productResourceId,
			periodKey: cycleId,
			startsAt,
			endsAt,
			metricId,
			quantity: record.ConsumedQuantity,
			cost
		});
		addBillingAggregate(cycleAggregates, `${productResourceId}:${cycleId}`, {
			resourceId: productResourceId,
			periodKey: cycleId,
			startsAt,
			endsAt,
			metricId: billedMetricId,
			quantity: cost,
			cost: 0
		});
		addBillingAggregate(cycleAggregates, `${accountResourceId}:${cycleId}`, {
			resourceId: accountResourceId,
			periodKey: cycleId,
			startsAt,
			endsAt,
			metricId: "account:billed_cost_usd",
			quantity: cost,
			cost
		});
		statements.push(env.DB.prepare(`INSERT INTO billing_line_items(
         id,billing_cycle_id,account_id,charge_period_start,charge_period_end,product_family,metric_key,
         description,consumed_quantity,consumed_unit,billed_cost,effective_cost,list_cost,currency,
         resource_cloudflare_id,mapped,raw_metadata_json,revised_at
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
       ON CONFLICT(account_id,charge_period_start,charge_period_end,product_family,metric_key,resource_cloudflare_id,description,consumed_unit)
       DO UPDATE SET
         description=excluded.description,consumed_quantity=excluded.consumed_quantity,
         consumed_unit=excluded.consumed_unit,billed_cost=excluded.billed_cost,
         effective_cost=excluded.effective_cost,list_cost=excluded.list_cost,currency=excluded.currency,
         mapped=excluded.mapped,raw_metadata_json=excluded.raw_metadata_json,revised_at=excluded.revised_at`).bind(lineId, cycleId, env.BROLLY_ACCOUNT_ID, chargeStart, chargeEnd, family, metric, record.ChargeDescription ?? record.x_BillableMetricName ?? metric, record.ConsumedQuantity, record.ConsumedUnit, record.BilledCost ?? null, record.EffectiveCost ?? null, record.ListCost ?? null, currency, record.x_ZoneId ?? "", mapped ? 1 : 0, JSON.stringify({
			zoneName: record.x_ZoneName ?? null,
			source: "cloudflare-billable-usage"
		}), nowValue));
		if (!resourceFamilies.has(family)) {
			statements.push(...billingResourceStatements(env, family, nowValue));
			resourceFamilies.add(family);
		}
		if (!billingMetrics.has(metricId)) {
			statements.push(...billingMetricDefinitionStatements(env.DB, family, metric, mappedMetric, record.x_BillableMetricName ?? metric, record.ConsumedUnit));
			billingMetrics.add(metricId);
		}
	}
	for (const cycle of cycles.values()) statements.unshift(env.DB.prepare(`INSERT INTO billing_cycles(id,account_id,starts_at,ends_at,status,currency,authoritative_cost,reconciled_at,approximate)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status,currency=excluded.currency,authoritative_cost=excluded.authoritative_cost,
         reconciled_at=excluded.reconciled_at,approximate=0`).bind(cycle.id, env.BROLLY_ACCOUNT_ID, cycle.startsAt, cycle.endsAt, cycle.endsAt <= now ? "sealed" : "open", cycle.currency, cycle.cost, nowValue));
	for (const aggregate of dailyAggregates.values()) statements.push(env.DB.prepare(`INSERT INTO usage_daily(
         resource_id,local_day,period_start_at,period_end_at,metrics_json,estimated_cost_usd,
         authoritative_allocated_cost_usd,completeness,sampling_json,sealed,revision,revised_at
       ) VALUES(?1,?2,?3,?4,?5,NULL,?6,'complete','{}',1,1,?7)
       ON CONFLICT(resource_id,local_day) DO UPDATE SET
         metrics_json=json_patch(usage_daily.metrics_json,excluded.metrics_json),
         authoritative_allocated_cost_usd=excluded.authoritative_allocated_cost_usd,
         revision=usage_daily.revision+1,revised_at=excluded.revised_at`).bind(aggregate.resourceId, aggregate.periodKey, aggregate.startsAt, aggregate.endsAt, JSON.stringify(aggregate.metrics), aggregate.cost, nowValue));
	for (const aggregate of cycleAggregates.values()) statements.push(env.DB.prepare(`INSERT INTO usage_cycle_totals(
         resource_id,billing_cycle_id,metrics_json,estimated_cost_usd,authoritative_allocated_cost_usd,
         completeness,sampling_json,sealed,revision,revised_at
       ) VALUES(?1,?2,?3,NULL,?4,'complete','{}',0,1,?5)
       ON CONFLICT(resource_id,billing_cycle_id) DO UPDATE SET
         metrics_json=json_patch(usage_cycle_totals.metrics_json,excluded.metrics_json),
         authoritative_allocated_cost_usd=excluded.authoritative_allocated_cost_usd,
         revision=usage_cycle_totals.revision+1,revised_at=excluded.revised_at`).bind(aggregate.resourceId, aggregate.periodKey, JSON.stringify(aggregate.metrics), aggregate.cost, nowValue));
	for (const unknown of unknownProducts) statements.push(env.DB.prepare(`INSERT INTO collector_capabilities(
         account_id,collector_key,dataset,available,retention_days,sampling_behavior,finest_scope,
         last_verified_at,error_code,human_explanation,state,watermark_at
       ) VALUES(?1,'billing:catchall',?2,1,NULL,NULL,'account',?3,'unmapped_billing_product',?4,'delayed',?3)
       ON CONFLICT(account_id,collector_key,dataset) DO UPDATE SET
         last_verified_at=excluded.last_verified_at,human_explanation=excluded.human_explanation,
         state=excluded.state,watermark_at=excluded.watermark_at`).bind(env.BROLLY_ACCOUNT_ID, unknown, nowValue, `Authoritative billing includes ${unknown}; detailed resource telemetry is not mapped yet`));
	if (truncated) statements.push(env.DB.prepare(`INSERT INTO collector_capabilities(
       account_id,collector_key,dataset,available,retention_days,sampling_behavior,finest_scope,
       last_verified_at,error_code,human_explanation,state,watermark_at
     ) VALUES(?1,'billing:billable-usage','billable-usage',1,NULL,NULL,'account',?2,
       'billing_row_limit',?3,'delayed',?2)
     ON CONFLICT(account_id,collector_key,dataset) DO UPDATE SET
       last_verified_at=excluded.last_verified_at,error_code=excluded.error_code,
       human_explanation=excluded.human_explanation,state=excluded.state,watermark_at=excluded.watermark_at`).bind(env.BROLLY_ACCOUNT_ID, nowValue, `Billing reconciliation retained the first 20,000 of ${records.length} lines`));
	await runBatches$3(env.DB, statements, budget);
	await allocateAuthoritativeCosts(env.DB, env.BROLLY_ACCOUNT_ID, boundedRecords, timeZone, budget);
	const effectiveStart = effectiveBillingStart(boundedRecords, startsAt);
	const missingRanges = window?.recordGaps ? billingMissingRanges(boundedRecords, effectiveStart, endsAt) : [];
	const gapDetail = missingRanges.length ? `Billing data is missing for ${missingRanges.map((range) => `${range.from} through ${range.to}`).join(", ")}` : void 0;
	if (gapDetail) chargeMeta$2(budget, (await env.DB.prepare(`INSERT INTO metric_coverage(family,metric,finest_scope,state,detail,checked_at)
       VALUES('billing','initial_import_gaps','account','delayed',?1,?2)
       ON CONFLICT(family,metric) DO NOTHING`).bind(gapDetail, nowValue).run()).meta);
	const authoritativeCostUsd = [...cycles.values()].reduce((total, cycle) => total + cycle.cost, 0);
	const alertChanges = billingAlertChanges(env.BROLLY_ACCOUNT_ID, boundedRecords, [...cycles.values()], env.BROLLY_TIMEZONE ?? "UTC", now);
	return {
		available: true,
		complete: !truncated,
		records: boundedRecords.length,
		cycles: cycles.size,
		unknownProducts: [...unknownProducts].sort(),
		authoritativeCostUsd,
		alertChanges,
		...truncated || gapDetail ? { error: [truncated ? `Billing reconciliation reached its 20,000-line limit from ${records.length} returned lines` : null, gapDetail].filter(Boolean).join("; ") } : {}
	};
}
function billingMissingRanges(records, startsAt, endsAt) {
	const firstDay = utcDayStart(startsAt);
	const lastDay = utcDayStart(endsAt) - 864e5;
	if (lastDay < firstDay) return [];
	const covered = /* @__PURE__ */ new Set();
	for (const record of records) {
		const start = safeDate(record.ChargePeriodStart, startsAt);
		const end = Math.max(start + 1, safeDate(record.ChargePeriodEnd, endOfUtcDay(start)));
		for (let day = utcDayStart(start); day < end; day += 864e5) if (day >= firstDay && day <= lastDay) covered.add(utcDate(day));
	}
	const missing = [];
	for (let day = firstDay; day <= lastDay; day += 864e5) if (!covered.has(utcDate(day))) missing.push(day);
	const ranges = [];
	for (const day of missing) {
		const previous = ranges.at(-1);
		const date = utcDate(day);
		if (previous && utcDate(Date.parse(`${previous.to}T00:00:00Z`) + 864e5) === date) previous.to = date;
		else ranges.push({
			from: date,
			to: date
		});
	}
	return ranges;
}
function effectiveBillingStart(records, requestedStart) {
	const starts = records.map((record) => record.BillingPeriodStart ? Date.parse(record.BillingPeriodStart) : NaN).filter(Number.isFinite);
	return starts.length ? Math.max(requestedStart, Math.min(...starts)) : requestedStart;
}
function utcDayStart(timestamp) {
	const date = new Date(timestamp);
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
function endOfUtcDay(timestamp) {
	return utcDayStart(timestamp) + 864e5;
}
function utcDate(timestamp) {
	return new Date(timestamp).toISOString().slice(0, 10);
}
function addBillingAggregate(target, key, value) {
	const aggregate = target.get(key) ?? {
		resourceId: value.resourceId,
		periodKey: value.periodKey,
		startsAt: value.startsAt,
		endsAt: value.endsAt,
		metrics: {},
		cost: 0
	};
	aggregate.startsAt = Math.min(aggregate.startsAt, value.startsAt);
	aggregate.endsAt = Math.max(aggregate.endsAt, value.endsAt);
	aggregate.metrics[value.metricId] = (aggregate.metrics[value.metricId] ?? 0) + value.quantity;
	aggregate.cost += value.cost;
	target.set(key, aggregate);
}
function billingResourceStatements(env, family, now) {
	const productResourceId = resourceId(env.BROLLY_ACCOUNT_ID, family, "product", family);
	const accountResourceId = resourceId(env.BROLLY_ACCOUNT_ID, "account", "account", env.BROLLY_ACCOUNT_ID);
	return [env.DB.prepare(`INSERT OR IGNORE INTO resources(
         id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,
         first_seen_at,last_seen_at,last_active_at,coverage_status,control_capability,runtime_fuse_status,
         auto_quarantine_policy,tier,excluded,collector_key,dataset,metadata_json
       ) VALUES(?1,?2,NULL,'account','account',?2,'Cloudflare account',?3,?3,?3,'complete','none','unknown','inherit','unclassified',0,'billing','billable-usage','{}')`).bind(accountResourceId, env.BROLLY_ACCOUNT_ID, now), env.DB.prepare(`INSERT OR IGNORE INTO resources(
         id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,
         first_seen_at,last_seen_at,last_active_at,coverage_status,control_capability,runtime_fuse_status,
         auto_quarantine_policy,tier,excluded,collector_key,dataset,metadata_json
       ) VALUES(?1,?2,?3,?4,'product',?4,?5,?6,?6,?6,'complete','none','unknown','inherit','unclassified',0,'billing','billable-usage','{}')`).bind(productResourceId, env.BROLLY_ACCOUNT_ID, accountResourceId, family, displayFamily$1(family), now)];
}
function billingMetricDefinitionStatements(db, family, billingMetric, mappedMetric, displayName, consumedUnit) {
	const metricKey = mappedMetric ?? billingMetric;
	return [db.prepare(`INSERT OR IGNORE INTO metric_definitions(
         id,product_family,metric_key,display_name,unit,aggregation_kind,billing_mapping,
         collector_key,finest_scope,pricing_version_id,active,catalog_version
       ) VALUES(?1,?2,?3,?4,?5,'sum',?6,'billing:billable-usage','product',NULL,1,'billing-dynamic')`).bind(`${family}:${metricKey}`, family, metricKey, displayName, consumedUnit || "count", billingMetric), db.prepare(`INSERT OR IGNORE INTO metric_definitions(
         id,product_family,metric_key,display_name,unit,aggregation_kind,billing_mapping,
         collector_key,finest_scope,pricing_version_id,active,catalog_version
       ) VALUES(?1,?2,'billed_cost_usd','Billed cost','usd','sum','billed_cost',
         'billing:billable-usage','product',NULL,1,'billing-dynamic')`).bind(`${family}:billed_cost_usd`, family)];
}
function billingAlertChanges(accountId, records, cycles, timeZone, now) {
	const day = localDayAt(now, timeZone);
	const dayBounds = localDayBounds(day, timeZone);
	const currentCycle = cycles.find((cycle) => cycle.startsAt <= now && cycle.endsAt > now) ?? cycles.sort((left, right) => right.startsAt - left.startsAt)[0];
	if (!currentCycle) return [];
	const totals = /* @__PURE__ */ new Map();
	for (const record of records) {
		const family = normalizeFamily(record.x_ProductFamilyId ?? record.x_ProductFamilyName ?? "unknown");
		const startsAt = safeDate(record.ChargePeriodStart, now);
		const cost = record.BilledCost ?? record.EffectiveCost ?? record.ListCost;
		if (cost === void 0) continue;
		const product = totals.get(family) ?? {
			day: 0,
			cycle: 0
		};
		if (startsAt >= dayBounds.start && startsAt < dayBounds.end) product.day += cost;
		if (startsAt >= currentCycle.startsAt && startsAt < currentCycle.endsAt) product.cycle += cost;
		totals.set(family, product);
	}
	return [["account", [...totals.values()].reduce((sum, value) => ({
		day: sum.day + value.day,
		cycle: sum.cycle + value.cycle
	}), {
		day: 0,
		cycle: 0
	})], ...[...totals.entries()]].map(([family, total]) => ({
		localDay: day,
		billingCycleId: currentCycle.id,
		resourceId: family === "account" ? resourceId(accountId, "account", "account", accountId) : resourceId(accountId, family, "product", family),
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
		historical: false
	}));
}
async function allocateAuthoritativeCosts(db, accountId, records, timeZone, budget) {
	const productDays = /* @__PURE__ */ new Map();
	for (const record of records) {
		const cost = record.BilledCost ?? record.EffectiveCost ?? record.ListCost;
		if (cost === void 0) continue;
		const family = normalizeFamily(record.x_ProductFamilyId ?? record.x_ProductFamilyName ?? "unknown");
		const day = localDayAt(safeDate(record.ChargePeriodStart, Date.now()), timeZone);
		const key = `${family}:${day}`;
		const item = productDays.get(key) ?? {
			family,
			day,
			cost: 0
		};
		item.cost += cost;
		productDays.set(key, item);
	}
	for (const item of productDays.values()) {
		const rows = await db.prepare(`SELECT u.resource_id,u.estimated_cost_usd FROM usage_daily u JOIN resources r ON r.id=u.resource_id
       WHERE r.account_id=?1 AND r.product_family=?2 AND u.local_day=?3
         AND r.resource_type NOT IN ('account','product')
         AND NOT EXISTS (SELECT 1 FROM resources child WHERE child.parent_resource_id=r.id)
         AND u.estimated_cost_usd>0 LIMIT 5000`).bind(accountId, item.family, item.day).all();
		chargeMeta$2(budget, rows.meta);
		const estimate = rows.results.reduce((total, row) => total + row.estimated_cost_usd, 0);
		if (estimate <= 0) continue;
		await runBatches$3(db, rows.results.map((row) => db.prepare(`UPDATE usage_daily SET authoritative_allocated_cost_usd=?3,revision=revision+1,revised_at=?4
       WHERE resource_id=?1 AND local_day=?2`).bind(row.resource_id, item.day, item.cost * row.estimated_cost_usd / estimate, Date.now())), budget);
	}
}
async function runBatches$3(db, statements, budget) {
	for (let offset = 0; offset < statements.length; offset += MAX_BATCH$2) {
		const results = await db.batch(statements.slice(offset, offset + MAX_BATCH$2));
		for (const result of results) chargeMeta$2(budget, result.meta);
	}
}
function chargeMeta$2(budget, meta) {
	budget?.charge("d1RowsRead", meta.rows_read ?? 0);
	budget?.charge("d1RowsWritten", meta.rows_written ?? meta.changes ?? 0);
}
function billingLineId(accountId, record, family, metric) {
	return [
		accountId,
		record.ChargePeriodStart,
		record.ChargePeriodEnd,
		family,
		metric,
		record.x_ZoneId ?? "account",
		record.ChargeDescription ?? record.x_BillableMetricName,
		record.ConsumedUnit
	].map(encodeURIComponent).join(":");
}
function normalizeFamily(value) {
	const normalized = normalizeMetric(value);
	return {
		durable_objects: "durable_objects",
		workers_kv: "kv",
		workers_ai: "workers_ai",
		ai_gateway: "ai_gateway",
		browser_rendering: "browser_rendering",
		worker_builds: "worker_builds"
	}[normalized] ?? normalized;
}
function normalizeMetric(value) {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}
function billingCatalogMetric(family, billingMetric) {
	const product = METRIC_CATALOG.find((item) => item.family === family && item.family !== "unknown");
	if (!product) return null;
	return [...product.metrics].sort((left, right) => right.length - left.length).find((metric) => billingMetric === metric || billingMetric.includes(metric)) ?? null;
}
function displayFamily$1(family) {
	return family.replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase());
}
function safeDate(value, fallback) {
	if (!value) return fallback;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}
//#endregion
//#region src/ingest.ts
/** Collects, normalizes, and persists one bounded usage or billing window. */
async function ingestWindow(options) {
	if (options.collector === "billing") {
		const result = await reconcileBilling(options.env, options.client, options.budget, options.endsAt, {
			startsAt: options.startsAt,
			endsAt: options.endsAt,
			recordGaps: options.historical === true
		});
		const state = !result.available ? "permission_denied" : result.error && options.historical ? "delayed" : result.complete ? "healthy" : "delayed";
		return {
			observations: result.records,
			complete: result.complete,
			continuation: null,
			samples: [],
			coverage: [{
				family: "billing",
				metric: options.historical ? "initial_import_gaps" : "authoritative_usage",
				finestScope: "account",
				state,
				checkedAt: options.endsAt,
				detail: result.error ?? (result.available ? void 0 : "Add Billing Read access to reconcile authoritative usage and billing-cycle boundaries")
			}],
			changes: result.alertChanges,
			watermarkAt: options.endsAt
		};
	}
	const definition = productUsageDefinition(options.collector);
	const result = options.collector === "graphql:durable-objects" ? await options.client.durableObjectUsagePaged(options.startsAt, options.endsAt, {
		cursor: options.cursor,
		maxPages: options.maxPages
	}) : options.collector === "graphql:workers" ? await options.client.workerUsage(options.startsAt, options.endsAt, {
		cursor: options.cursor,
		maxPages: options.maxPages
	}) : definition ? await options.client.productUsage(definition, options.startsAt, options.endsAt) : unreachableCollector(options.collector);
	const observations = expandUsageObservations(result.samples, options.collector, options.collector === "graphql:durable-objects" ? "durable-object-usage" : options.collector === "graphql:workers" ? "workersInvocationsAdaptive" : definition.datasets.map((item) => item.dataset).join("+"), result.complete ? "complete" : "partial", {
		watermarkAt: result.watermarkAt,
		historical: options.historical ?? false
	});
	const changes = options.persist === false ? [] : await options.ledger.applyObservations(observations, options.timeZone);
	return {
		observations: observations.length,
		complete: result.complete,
		continuation: result.continuation,
		samples: result.samples,
		coverage: result.coverage,
		changes,
		watermarkAt: result.watermarkAt,
		normalizedObservations: observations
	};
}
function unreachableCollector(collector) {
	throw new Error(`Unsupported usage collector: ${String(collector)}`);
}
//#endregion
//#region src/alert-levels.ts
var REPEAT_INTERVALS = [
	null,
	3e5,
	9e5,
	18e5,
	36e5,
	108e5,
	216e5,
	432e5,
	864e5
];
var ALERT_ENTRY_KINDS = [
	"channel",
	"prepare_stop",
	"prepare_quarantine",
	"auto_pause",
	"auto_quarantine"
];
async function alertLevelsApiRoute(request, env, actor) {
	const url = new URL(request.url);
	if (url.pathname === "/api/alert-levels" && request.method === "GET") return Response.json({ levels: await loadAlertLevels(env.DB) }, { headers: { "cache-control": "no-store" } });
	if (url.pathname === "/api/alert-levels" && request.method === "POST") {
		const body = await request.json();
		const label = normalizedLabel(body.label);
		if (!label) return Response.json({ error: "Level name must contain 1 to 40 characters" }, { status: 400 });
		const levels = await loadAlertLevels(env.DB);
		if (levels.length >= 8) return Response.json({ error: "Brolly supports up to eight alert levels" }, { status: 400 });
		if (levels.some((level) => sameLabel(level.label, label))) return Response.json({ error: "Alert level names must be unique" }, { status: 400 });
		let insertAt = 0;
		if (body.afterLevelId != null) {
			const after = levels.findIndex((level) => level.id === body.afterLevelId);
			if (after === -1) return Response.json({ error: "Previous alert level not found" }, { status: 400 });
			insertAt = after + 1;
		}
		const id = crypto.randomUUID();
		const now = Date.now();
		await env.DB.prepare(`INSERT INTO alert_levels(id,position,label,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)`).bind(id, 1e4 + levels.length, label, now).run();
		const ordered = [...levels];
		ordered.splice(insertAt, 0, {
			id,
			position: insertAt,
			label,
			entries: []
		});
		await writeLevelPositions(env.DB, ordered.map((level) => level.id), now);
		await audit$3(env.DB, actor, "alert_level.create", id, {
			label,
			position: insertAt
		});
		return Response.json({
			ok: true,
			level: (await loadAlertLevels(env.DB)).find((level) => level.id === id)
		}, { status: 201 });
	}
	const levelMatch = url.pathname.match(/^\/api\/alert-levels\/([^/]+)$/);
	if (levelMatch && request.method === "PATCH") {
		const id = decodeURIComponent(levelMatch[1]);
		const body = await request.json();
		if (body.label === void 0 && body.position === void 0) return Response.json({ error: "No level change supplied" }, { status: 400 });
		const levels = await loadAlertLevels(env.DB);
		const currentIndex = levels.findIndex((level) => level.id === id);
		if (currentIndex === -1) return Response.json({ error: "Alert level not found" }, { status: 404 });
		const now = Date.now();
		if (body.label !== void 0) {
			const label = normalizedLabel(body.label);
			if (!label) return Response.json({ error: "Level name must contain 1 to 40 characters" }, { status: 400 });
			if (levels.some((level) => level.id !== id && sameLabel(level.label, label))) return Response.json({ error: "Alert level names must be unique" }, { status: 400 });
			await env.DB.batch([env.DB.prepare(`UPDATE alert_levels SET label=?2,updated_at=?3 WHERE id=?1`).bind(id, label, now), env.DB.prepare(`UPDATE alert_lines SET label=?2,updated_at=?3 WHERE level_id=?1`).bind(id, label, now)]);
		}
		if (body.position !== void 0) {
			if (!Number.isInteger(body.position) || body.position < 0 || body.position >= levels.length) return Response.json({ error: "Level position is outside the board" }, { status: 400 });
			const [moved] = levels.splice(currentIndex, 1);
			levels.splice(body.position, 0, moved);
			await writeLevelPositions(env.DB, levels.map((level) => level.id), now);
			await synchronizeLinePriorities(env.DB, levels, now);
		}
		await audit$3(env.DB, actor, "alert_level.update", id, body);
		return Response.json({
			ok: true,
			level: (await loadAlertLevels(env.DB)).find((level) => level.id === id)
		});
	}
	if (levelMatch && request.method === "DELETE") {
		const id = decodeURIComponent(levelMatch[1]);
		const levels = await loadAlertLevels(env.DB);
		if (!levels.some((level) => level.id === id)) return Response.json({ error: "Alert level not found" }, { status: 404 });
		if (levels.length === 1) return Response.json({ error: "At least one alert level must remain" }, { status: 409 });
		const now = Date.now();
		await env.DB.batch([env.DB.prepare(`UPDATE alert_lines SET retired=1,updated_at=?2 WHERE level_id=?1`).bind(id, now), env.DB.prepare(`DELETE FROM alert_levels WHERE id=?1`).bind(id)]);
		const remaining = levels.filter((level) => level.id !== id);
		await writeLevelPositions(env.DB, remaining.map((level) => level.id), now);
		await synchronizeLinePriorities(env.DB, remaining, now);
		await audit$3(env.DB, actor, "alert_level.delete", id, {});
		return Response.json({
			ok: true,
			id
		});
	}
	const entriesMatch = url.pathname.match(/^\/api\/alert-levels\/([^/]+)\/entries(?:\/([^/]+))?$/);
	if (!entriesMatch) return null;
	const levelId = decodeURIComponent(entriesMatch[1]);
	const entryId = entriesMatch[2] ? decodeURIComponent(entriesMatch[2]) : null;
	if (!await env.DB.prepare(`SELECT 1 AS present FROM alert_levels WHERE id=?1 LIMIT 1`).bind(levelId).first()) return Response.json({ error: "Alert level not found" }, { status: 404 });
	if (!entryId && request.method === "POST") {
		const body = await request.json();
		if (!ALERT_ENTRY_KINDS.includes(body.kind)) return Response.json({ error: "Invalid alert level entry" }, { status: 400 });
		const kind = body.kind;
		const repeatIntervalMs = body.repeatIntervalMs ?? null;
		if (kind === "channel") {
			if (!body.targetId) return Response.json({ error: "Channel entry requires a target" }, { status: 400 });
			if (!isRepeatInterval(repeatIntervalMs)) return Response.json({ error: "Invalid repeat interval" }, { status: 400 });
			if (!await env.DB.prepare(`SELECT 1 AS present FROM notification_targets WHERE id=?1 LIMIT 1`).bind(body.targetId).first()) return Response.json({ error: "Notification target not found" }, { status: 400 });
		} else if (body.targetId != null || body.repeatIntervalMs != null) return Response.json({ error: "Action entries do not use a channel or interval" }, { status: 400 });
		if (await env.DB.prepare(`SELECT 1 AS present FROM alert_level_entries WHERE level_id=?1 AND kind=?2 AND COALESCE(target_id,'')=COALESCE(?3,'') LIMIT 1`).bind(levelId, kind, kind === "channel" ? body.targetId : null).first()) return Response.json({ error: "This entry is already in the level" }, { status: 409 });
		const position = Number((await env.DB.prepare(`SELECT COALESCE(MAX(position),-1)+1 AS position FROM alert_level_entries WHERE level_id=?1`).bind(levelId).first())?.position ?? 0);
		const id = crypto.randomUUID();
		const now = Date.now();
		await env.DB.prepare(`INSERT INTO alert_level_entries(id,level_id,kind,target_id,repeat_interval_ms,position,created_at,updated_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?7)`).bind(id, levelId, kind, kind === "channel" ? body.targetId : null, kind === "channel" ? repeatIntervalMs : null, position, now).run();
		await audit$3(env.DB, actor, "alert_level_entry.create", id, {
			levelId,
			kind,
			targetId: body.targetId ?? null,
			repeatIntervalMs
		});
		return Response.json({
			ok: true,
			entry: (await loadAlertLevels(env.DB)).find((level) => level.id === levelId)?.entries.find((entry) => entry.id === id)
		}, { status: 201 });
	}
	if (entryId && request.method === "PATCH") {
		const body = await request.json();
		if (body.repeatIntervalMs === void 0 && body.position === void 0) return Response.json({ error: "No entry change supplied" }, { status: 400 });
		const current = await env.DB.prepare(`SELECT kind FROM alert_level_entries WHERE id=?1 AND level_id=?2 LIMIT 1`).bind(entryId, levelId).first();
		if (!current) return Response.json({ error: "Alert level entry not found" }, { status: 404 });
		if (body.repeatIntervalMs !== void 0 && (current.kind !== "channel" || !isRepeatInterval(body.repeatIntervalMs))) return Response.json({ error: "Invalid repeat interval" }, { status: 400 });
		const entries = (await loadAlertLevels(env.DB)).find((level) => level.id === levelId).entries;
		const currentIndex = entries.findIndex((entry) => entry.id === entryId);
		if (body.position !== void 0 && (!Number.isInteger(body.position) || body.position < 0 || body.position >= entries.length)) return Response.json({ error: "Entry position is outside the level" }, { status: 400 });
		const now = Date.now();
		if (body.repeatIntervalMs !== void 0) await env.DB.prepare(`UPDATE alert_level_entries SET repeat_interval_ms=?3,updated_at=?4 WHERE id=?1 AND level_id=?2`).bind(entryId, levelId, body.repeatIntervalMs, now).run();
		if (body.position !== void 0) {
			const [moved] = entries.splice(currentIndex, 1);
			entries.splice(body.position, 0, moved);
			await writeEntryPositions(env.DB, entries.map((entry) => entry.id), now);
		}
		await audit$3(env.DB, actor, "alert_level_entry.update", entryId, {
			levelId,
			...body
		});
		return Response.json({
			ok: true,
			entry: (await loadAlertLevels(env.DB)).find((level) => level.id === levelId)?.entries.find((entry) => entry.id === entryId)
		});
	}
	if (entryId && request.method === "DELETE") {
		const result = await env.DB.prepare(`DELETE FROM alert_level_entries WHERE id=?1 AND level_id=?2`).bind(entryId, levelId).run();
		if (Number(result.meta.changes ?? 0) === 0) return Response.json({ error: "Alert level entry not found" }, { status: 404 });
		await audit$3(env.DB, actor, "alert_level_entry.delete", entryId, { levelId });
		return Response.json({
			ok: true,
			id: entryId
		});
	}
	return null;
}
async function loadAlertLevels(db) {
	const [levels, entries] = await Promise.all([db.prepare(`SELECT id,position,label FROM alert_levels ORDER BY position,id`).all(), db.prepare(`SELECT id,level_id,kind,target_id,repeat_interval_ms,position FROM alert_level_entries ORDER BY level_id,position,id`).all()]);
	const byLevel = /* @__PURE__ */ new Map();
	for (const row of entries.results) {
		const collection = byLevel.get(row.level_id) ?? [];
		collection.push({
			id: row.id,
			levelId: row.level_id,
			kind: row.kind,
			targetId: row.target_id,
			repeatIntervalMs: row.repeat_interval_ms == null ? null : Number(row.repeat_interval_ms),
			position: Number(row.position)
		});
		byLevel.set(row.level_id, collection);
	}
	return levels.results.map((row) => ({
		id: row.id,
		position: Number(row.position),
		label: row.label,
		entries: byLevel.get(row.id) ?? []
	}));
}
function resolveEffectiveEntries(levels, firingPosition) {
	const channels = /* @__PURE__ */ new Map();
	let prepareStop = false;
	let autoPause = false;
	let prepareQuarantine = false;
	let autoQuarantine = false;
	for (const level of [...levels].sort((left, right) => left.position - right.position)) {
		if (level.position > firingPosition) break;
		for (const entry of [...level.entries].sort((left, right) => left.position - right.position)) if (entry.kind === "channel" && entry.targetId) channels.set(entry.targetId, {
			targetId: entry.targetId,
			repeatIntervalMs: entry.repeatIntervalMs
		});
		else if (entry.kind === "prepare_stop") prepareStop = true;
		else if (entry.kind === "auto_pause") autoPause = true;
		else if (entry.kind === "prepare_quarantine") prepareQuarantine = true;
		else if (entry.kind === "auto_quarantine") autoQuarantine = true;
	}
	return {
		channels: [...channels.values()],
		stopOrPause: autoPause ? "auto" : prepareStop ? "prepare" : null,
		quarantine: autoQuarantine ? "auto" : prepareQuarantine ? "prepare" : null
	};
}
function normalizedLabel(value) {
	if (typeof value !== "string") return null;
	const label = value.trim();
	return label && label.length <= 40 ? label : null;
}
function sameLabel(left, right) {
	return left.localeCompare(right, void 0, { sensitivity: "accent" }) === 0;
}
function isRepeatInterval(value) {
	return REPEAT_INTERVALS.includes(value);
}
async function writeLevelPositions(db, ids, now) {
	await db.batch(ids.map((id, position) => db.prepare(`UPDATE alert_levels SET position=?2,updated_at=?3 WHERE id=?1`).bind(id, 1e4 + position, now)));
	await db.batch(ids.map((id, position) => db.prepare(`UPDATE alert_levels SET position=?2,updated_at=?3 WHERE id=?1`).bind(id, position, now)));
}
async function writeEntryPositions(db, ids, now) {
	await db.batch(ids.map((id, position) => db.prepare(`UPDATE alert_level_entries SET position=?2,updated_at=?3 WHERE id=?1`).bind(id, position, now)));
}
async function synchronizeLinePriorities(db, levels, now) {
	if (!levels.length) return;
	await db.batch(levels.map((level, position) => db.prepare(`UPDATE alert_lines SET priority=?2,updated_at=?3 WHERE level_id=?1`).bind(level.id, position * 10, now)));
}
async function audit$3(db, actor, action, target, detail) {
	await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
}
//#endregion
//#region src/alert-engine.ts
var MAX_BATCH$1 = 100;
async function evaluateUsageAlerts(env, changes, context) {
	if (!changes.length) return {
		notifications: [],
		automaticActions: [],
		breached: 0
	};
	const now = context.now ?? Date.now();
	const alertLevels = await loadAlertLevels(env.DB);
	const metricIds = [...new Set(changes.map((change) => change.metricDefinitionId))];
	const ruleLines = await loadRuleLines(env.DB, env.BROLLY_ACCOUNT_ID, metricIds, context.budget);
	if (!ruleLines.length) return {
		notifications: [],
		automaticActions: [],
		breached: 0
	};
	const cycleRows = await loadBillingCycleBounds(env.DB, env.BROLLY_ACCOUNT_ID, changes, context.budget);
	const resourceRows = await loadResources(env.DB, [...new Set(changes.map((change) => change.resourceId))], context.budget);
	const resources = new Map(resourceRows.map((row) => [row.id, resourceFromRow(row)]));
	const changesByMetric = /* @__PURE__ */ new Map();
	for (const change of changes) changesByMetric.set(change.metricDefinitionId, [...changesByMetric.get(change.metricDefinitionId) ?? [], change]);
	const statements = [];
	const breachedIds = /* @__PURE__ */ new Set();
	for (const rule of ruleLines) for (const change of changesByMetric.get(rule.metric_definition_id) ?? []) {
		const resource = resources.get(change.resourceId);
		if (!resource || !ruleMatchesResource(rule, resource)) continue;
		const observed = observedValue(rule.measurement, rule.period, change);
		const timestamp = Math.max(change.periodStartAt, change.periodEndAt - 1);
		const cycle = alertBillingCycleBounds(cycleRows, timestamp, {
			startsAt: context.billingCycleStart,
			endsAt: context.billingCycleEnd
		});
		const bounds = rule.period === "day" ? localDayBounds(localDayAt(timestamp, context.timeZone), context.timeZone) : {
			start: cycle.startsAt,
			end: cycle.endsAt
		};
		const id = alertInstanceId(rule.rule_id, rule.line_id, resource.id, bounds.start, bounds.end);
		if (observed >= rule.threshold_value) {
			breachedIds.add(id);
			const historical = change.historical || bounds.end <= now;
			const evidenceQuality = rule.period === "day" ? change.quality : change.cycleQuality;
			const evidence = {
				quality: evidenceQuality,
				sampleInterval: rule.period === "day" ? change.sampleInterval : change.cycleSampleInterval,
				watermarkAt: change.watermarkAt,
				rollingBaseline: change.rollingBaseline,
				measurement: rule.measurement
			};
			statements.push(env.DB.prepare(`INSERT INTO alert_instances(
             id,alert_rule_id,alert_line_id,target_resource_id,period_start_at,period_end_at,
             observed_value,threshold_value,evidence_json,data_quality,status,first_breached_at,
             last_breached_at,next_notification_at,notification_count,historical
           ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13,0,?14)
           ON CONFLICT(alert_rule_id,alert_line_id,target_resource_id,period_start_at,period_end_at)
           DO UPDATE SET
             observed_value=excluded.observed_value,threshold_value=excluded.threshold_value,
             evidence_json=excluded.evidence_json,data_quality=excluded.data_quality,
             status=CASE WHEN alert_instances.status IN ('expired','resolved') AND excluded.historical=0 THEN 'open' ELSE alert_instances.status END,
             last_breached_at=excluded.last_breached_at,historical=excluded.historical`).bind(id, rule.rule_id, rule.line_id, resource.id, bounds.start, bounds.end, observed, rule.threshold_value, JSON.stringify(evidence), evidenceQuality, historical ? "expired" : "open", now, historical ? null : now, historical ? 1 : 0));
		} else statements.push(env.DB.prepare(`UPDATE alert_instances SET status='resolved',last_breached_at=?6,next_notification_at=NULL
           WHERE alert_rule_id=?1 AND alert_line_id=?2 AND target_resource_id=?3
             AND period_start_at=?4 AND period_end_at=?5 AND status IN ('open','acknowledged')`).bind(rule.rule_id, rule.line_id, resource.id, bounds.start, bounds.end, now));
	}
	statements.push(env.DB.prepare(`UPDATE alert_instances SET status='expired',next_notification_at=NULL
     WHERE period_end_at<=?1 AND status IN ('open','acknowledged')`).bind(now));
	await runBatches$2(env.DB, statements, context.budget);
	if (!breachedIds.size) return {
		notifications: [],
		automaticActions: [],
		breached: 0
	};
	const instances = (await loadBreachedInstances(env.DB, env.BROLLY_ACCOUNT_ID, now, context.budget)).filter((instance) => breachedIds.has(instance.instance_id));
	const firingInstances = selectHighestFiringInstances(instances);
	const notifications = [];
	const automaticActions = [];
	for (const instance of firingInstances) {
		const effective = resolveEffectiveEntries(alertLevels, Math.floor(instance.priority / 10));
		if (alertInstanceCanNotify(instance.status, instance.historical === 1, instance.next_notification_at, now) && effective.channels.length) notifications.push(notificationFromRow(instance, effective.channels, alertLevels.length));
		const action = await prepareExactRuleAction(env.DB, instance, now, actionMode(instance.product_family, effective), context.budget);
		if (action) automaticActions.push(action);
		const contributorAction = await prepareAggregateContributorAction(env.DB, instance, changes, resources, now, effective, context.budget);
		if (contributorAction) automaticActions.push(contributorAction);
	}
	return {
		notifications,
		automaticActions,
		breached: instances.length
	};
}
function selectHighestFiringInstances(instances) {
	const selected = /* @__PURE__ */ new Map();
	for (const instance of instances) {
		const key = [
			instance.rule_id,
			instance.target_resource_id ?? instance.id,
			instance.period_start_at,
			instance.period_end_at
		].join("\0");
		const current = selected.get(key);
		if (!current || instance.priority > current.priority) selected.set(key, instance);
	}
	return [...selected.values()];
}
async function dispatchAlertNotifications(env, pending, budget) {
	for (const item of pending.slice(0, 100)) {
		const now = Date.now();
		const configured = new Map(item.targets.map((target) => [target.targetId, target]));
		const targets = await notificationTargets(env.DB, item.targets.map((target) => target.targetId), budget);
		const nextTimes = [];
		let deliveredCount = 0;
		for (const row of targets) {
			const schedule = configured.get(String(row.id));
			if (!schedule) continue;
			const dueAt = notificationDueAt(await latestAlertDelivery(env.DB, String(row.id), item.instanceId, budget), schedule.repeatIntervalMs, now);
			if (dueAt === null) continue;
			if (dueAt > now) {
				nextTimes.push(dueAt);
				continue;
			}
			if (!await notificationDeliveryAllowed(env.DB, String(row.id), String(row.kind), now, budget)) {
				nextTimes.push(now + 9e5);
				continue;
			}
			const config = env.BROLLY_CREDENTIAL_KEY ? await openJson(String(row.config_json), env.BROLLY_CREDENTIAL_KEY) : JSON.parse(String(row.config_json));
			const incident = {
				id: item.instanceId,
				key: item.instanceId,
				asset: assetFromResource(item.resource),
				metric: item.metricDefinitionId,
				severity: item.severity,
				observed: item.observed,
				threshold: item.threshold,
				reason: `${item.lineLabel} threshold crossed for ${item.metricDefinitionId}`,
				action: "notify",
				status: "open",
				firstSeen: now,
				lastSeen: now,
				occurrences: 1
			};
			const result = await notify({
				...config,
				id: String(row.id),
				kind: row.kind,
				enabled: true
			}, incident);
			chargeMeta$1(budget, (await env.DB.prepare(`INSERT INTO notification_deliveries(
           id,target_id,incident_id,kind,ok,status_code,error,created_at,alert_instance_id
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?3)`).bind(crypto.randomUUID(), row.id, item.instanceId, row.kind, result.ok ? 1 : 0, result.status ?? null, result.error?.slice(0, 2e3) ?? null, now).run()).meta);
			if (result.ok) deliveredCount += 1;
			const next = result.ok ? schedule.repeatIntervalMs === null ? null : now + schedule.repeatIntervalMs : now + 9e5;
			if (next !== null) nextTimes.push(next);
		}
		const next = nextTimes.length ? Math.min(...nextTimes) : null;
		chargeMeta$1(budget, (await env.DB.prepare(`UPDATE alert_instances SET
         notification_count=notification_count+?2,next_notification_at=?3
       WHERE id=?1 AND status='open' AND acknowledged_at IS NULL`).bind(item.instanceId, deliveredCount, next).run()).meta);
	}
}
function notificationDueAt(previous, repeatIntervalMs, now) {
	if (!previous) return now;
	if (!previous.ok) return previous.createdAt + 9e5;
	return repeatIntervalMs === null ? null : previous.createdAt + repeatIntervalMs;
}
async function latestAlertDelivery(db, targetId, instanceId, budget) {
	const row = await db.prepare(`SELECT ok,created_at FROM notification_deliveries
     WHERE target_id=?1 AND alert_instance_id=?2 ORDER BY created_at DESC LIMIT 1`).bind(targetId, instanceId).first();
	budget?.charge("d1RowsRead", row ? 1 : 0);
	return row ? {
		ok: Number(row.ok) === 1,
		createdAt: Number(row.created_at)
	} : null;
}
async function notificationDeliveryAllowed(db, targetId, kind, now = Date.now(), budget) {
	const result = await db.prepare(`SELECT
       SUM(CASE WHEN created_at>=?2 THEN 1 ELSE 0 END) AS hourly,
       SUM(CASE WHEN created_at>=?3 THEN 1 ELSE 0 END) AS daily
     FROM notification_deliveries WHERE target_id=?1 AND created_at>=?3`).bind(targetId, now - 36e5, now - 864e5).first();
	budget?.charge("d1RowsRead", 1);
	return Number(result?.hourly ?? 0) < 20 && (kind !== "twilio" || Number(result?.daily ?? 0) < 5);
}
async function acknowledgeAlertInstance(db, instanceId, actor) {
	const now = Date.now();
	const result = await db.prepare(`UPDATE alert_instances SET status='acknowledged',acknowledged_at=?2,acknowledged_by=?3,next_notification_at=NULL
     WHERE id=?1 AND status='open'`).bind(instanceId, now, actor).run();
	if (Number(result.meta.changes ?? 0) !== 1) return false;
	await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at)
     VALUES(?1,?2,'alert_instance.acknowledge',?3,'{}',?4)`).bind(crypto.randomUUID(), actor, instanceId, now).run();
	return true;
}
async function prepareExactRuleAction(db, instance, now, controlMode, budget) {
	if (!controlMode || instance.target_resource_id !== instance.id) return null;
	const resource = resourceFromRow(instance);
	if (!manualActionEligible(resource, instance)) return null;
	const metadata = resource.metadata;
	const existing = await db.prepare(`SELECT * FROM actions WHERE alert_instance_id=?1 AND state IN ('prepared','approved','running','succeeded') LIMIT 1`).bind(instance.instance_id).first();
	budget?.charge("d1RowsRead", existing ? 1 : 0);
	if (await hasDeniedAncestor(db, resource.id, budget)) return null;
	const evidence = parseEvidence(instance.evidence_json);
	if (!(controlMode === "auto")) {
		if (existing) return null;
		await insertPreparedAction(db, instance, resource, now, false, `${instance.label} threshold crossed; operator approval is required`, budget);
		return null;
	}
	const activeAction = await db.prepare(`SELECT id,state,alert_instance_id FROM actions WHERE account_id=?1 AND family=?2 AND asset_id=?3
     AND state IN ('prepared','approved','running','succeeded')
     ORDER BY CASE state WHEN 'succeeded' THEN 0 WHEN 'running' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END LIMIT 1`).bind(resource.accountId, resource.productFamily, resource.cloudflareId).first();
	budget?.charge("d1RowsRead", activeAction ? 1 : 0);
	if (!automaticActionEligible(resource, {
		quality: instance.data_quality,
		sampleInterval: evidence.sampleInterval,
		measurement: instance.measurement,
		fresh: evidence.watermarkAt !== null && now - evidence.watermarkAt <= 9e5,
		alreadyQuarantined: blocksAutomaticAction(activeAction, instance.instance_id),
		confirmationSatisfied: now - instance.first_breached_at >= instance.confirmation_window_ms
	})) return null;
	if (!(resource.productFamily === "workers" ? resource.cloudflareId : metadata.cloudflareWorkerScript)) return null;
	if (existing) return Number(existing.automatic) === 1 && existing.state === "prepared" ? actionFromStoredRow(existing, resource) : null;
	return insertPreparedAction(db, instance, resource, now, true, `${instance.label} threshold remained breached for ${instance.confirmation_window_ms} ms`, budget);
}
async function insertPreparedAction(db, instance, resource, now, automatic, reason, budget) {
	const kind = resource.productFamily === "queues" ? "pause_consumer" : "runtime_quarantine";
	const workerScript = resource.productFamily === "workers" ? resource.cloudflareId : resource.metadata.cloudflareWorkerScript;
	if (kind === "runtime_quarantine" && !workerScript) return null;
	const action = {
		id: crypto.randomUUID(),
		incidentId: instance.instance_id,
		asset: assetFromResource(resource),
		kind,
		state: "prepared",
		reason,
		observed: { [instance.metric_definition_id]: instance.observed_value },
		rollback: {
			...workerScript ? { workerScript } : {},
			action: "resume"
		},
		actor: "brolly-alert-rule",
		createdAt: now
	};
	const auditId = crypto.randomUUID();
	const results = await db.batch([
		db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at)
       VALUES(?1,'brolly-alert-rule','action.prepare',?2,?3,?4)`).bind(auditId, action.id, JSON.stringify({
			alertInstanceId: instance.instance_id,
			automatic
		}), now),
		db.prepare(`INSERT OR IGNORE INTO actions(
         id,incident_id,idempotency_key,account_id,family,asset_id,kind,state,reason,observed_json,
         rollback_json,actor,created_at,updated_at,alert_instance_id,evidence_quality,automatic
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,'prepared',?8,?9,?10,?11,?12,?12,?2,?13,?14)`).bind(action.id, instance.instance_id, `alert:${instance.instance_id}`, resource.accountId, resource.productFamily, resource.cloudflareId, kind, action.reason, JSON.stringify(action.observed), JSON.stringify(action.rollback), action.actor, now, instance.data_quality, automatic ? 1 : 0),
		db.prepare(`UPDATE alert_instances SET linked_action_id=?2 WHERE id=?1`).bind(instance.instance_id, action.id)
	]);
	for (const result of results) chargeMeta$1(budget, result.meta);
	return Number(results[1]?.meta.changes ?? 0) === 1 ? action : null;
}
async function prepareAggregateContributorAction(db, instance, changes, resources, now, effective, budget) {
	if (!effective.stopOrPause && !effective.quarantine || !instance.target_resource_id) return null;
	if (instance.measurement !== "usage" || instance.data_quality !== "complete" || instance.historical === 1) return null;
	const target = resourceFromRow(instance);
	if (!["account", "product"].includes(target.resourceType) && !target.resourceType.endsWith(":namespace")) return null;
	const applicable = changes.filter((change) => change.metricDefinitionId === instance.metric_definition_id).map((change) => ({
		change,
		resource: resources.get(change.resourceId)
	})).filter((item) => Boolean(item.resource)).filter((item) => isExactControllableResource(item.resource) && isDescendant(item.resource, target.id, resources));
	if (!applicable.length) return null;
	const aggregateExcess = Math.max(0, instance.observed_value - instance.instance_threshold);
	const ownEmergency = await ownEmergencyThresholds(db, instance, applicable.map((item) => item.resource.id), budget);
	const evidence = applicable.map((item) => ({
		resourceId: item.resource.id,
		latestIntervalValue: item.change.intervalValue,
		periodValue: instance.period === "day" ? item.change.dayValue : item.change.cycleValue,
		aggregateExcess,
		rollingBaseline: item.change.rollingBaseline,
		crossedOwnEmergency: ownEmergency.has(item.resource.id) && (instance.period === "day" ? item.change.dayValue : item.change.cycleValue) >= ownEmergency.get(item.resource.id),
		eligible: periodQuality(item.change, instance.period) === "complete" && periodSampleInterval(item.change, instance.period) === 1 && resourceControlReady(item.resource) && !item.resource.excluded && item.resource.autoQuarantinePolicy !== "deny" && item.resource.tier !== "critical" && item.resource.tier !== "control_plane" && item.resource.tier !== "unclassified"
	}));
	const selected = selectAggregateContributor(evidence);
	if (!selected) {
		chargeMeta$1(budget, (await db.prepare(`DELETE FROM contributor_candidates WHERE alert_instance_id=?1`).bind(instance.instance_id).run()).meta);
		await auditAmbiguousContributors(db, instance, evidence, now, budget);
		if (effective.stopOrPause === "prepare" || effective.quarantine === "prepare") await prepareAmbiguousContributorApproval(db, instance, applicable, evidence, now, effective, budget);
		return null;
	}
	const resource = resources.get(selected.resourceId);
	if ((resource ? actionMode(resource.productFamily, effective) : null) !== "auto") {
		if (resource && manualActionEligible(resource, instance) && !await hasDeniedAncestor(db, resource.id, budget)) await insertPreparedAction(db, instance, resource, now, false, `${resource.displayName} is the leading contributor; operator approval is required`, budget);
		return null;
	}
	const watermark = applicable.find((item) => item.resource.id === selected.resourceId)?.change.watermarkAt ?? now;
	const updates = await db.batch([db.prepare(`DELETE FROM contributor_candidates WHERE alert_instance_id=?1 AND resource_id!=?2`).bind(instance.instance_id, selected.resourceId), db.prepare(`INSERT INTO contributor_candidates(
         alert_instance_id,resource_id,scan_watermark_at,consecutive_wins,evidence_json,updated_at
       ) VALUES(?1,?2,?3,1,?4,?5)
       ON CONFLICT(alert_instance_id,resource_id) DO UPDATE SET
         consecutive_wins=CASE WHEN contributor_candidates.scan_watermark_at=?3 THEN contributor_candidates.consecutive_wins ELSE contributor_candidates.consecutive_wins+1 END,
         scan_watermark_at=?3,evidence_json=?4,updated_at=?5`).bind(instance.instance_id, selected.resourceId, watermark, JSON.stringify(selected), now)]);
	for (const result of updates) chargeMeta$1(budget, result.meta);
	if (Number(updates[1]?.meta.changes ?? 0) !== 1) return null;
	const streak = await db.prepare(`SELECT consecutive_wins FROM contributor_candidates WHERE alert_instance_id=?1 AND resource_id=?2 LIMIT 1`).bind(instance.instance_id, selected.resourceId).first();
	budget?.charge("d1RowsRead", streak ? 1 : 0);
	if (Number(streak?.consecutive_wins ?? 0) < 2) return null;
	if (!resource || await hasDeniedAncestor(db, resource.id, budget)) return null;
	const change = applicable.find((item) => item.resource.id === selected.resourceId).change;
	const activeAction = await db.prepare(`SELECT * FROM actions WHERE account_id=?1 AND family=?2 AND asset_id=?3
     AND state IN ('prepared','approved','running','succeeded')
     ORDER BY CASE state WHEN 'succeeded' THEN 0 WHEN 'running' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END LIMIT 1`).bind(resource.accountId, resource.productFamily, resource.cloudflareId).first();
	budget?.charge("d1RowsRead", activeAction ? 1 : 0);
	if (!automaticActionEligible(resource, {
		quality: periodQuality(change, instance.period),
		sampleInterval: periodSampleInterval(change, instance.period),
		measurement: "usage",
		fresh: change.watermarkAt !== null && now - change.watermarkAt <= 9e5,
		alreadyQuarantined: blocksAutomaticAction(activeAction, instance.instance_id),
		confirmationSatisfied: true
	})) return null;
	if (activeAction) return Number(activeAction.automatic) === 1 && activeAction.state === "prepared" ? actionFromStoredRow(activeAction, resource) : null;
	return insertPreparedAction(db, instance, resource, now, true, `${resource.displayName} was the deterministic top contributor in two consecutive complete scans`, budget);
}
async function auditAmbiguousContributors(db, instance, evidence, now, budget) {
	const top = [...evidence].sort((left, right) => right.latestIntervalValue - left.latestIntervalValue).slice(0, 5);
	if (!top.length) return;
	const key = `contributors:ambiguous:${instance.instance_id}:${instance.last_breached_at}`;
	const exists = await db.prepare(`SELECT 1 AS present FROM audit_log WHERE target=?1 LIMIT 1`).bind(key).first();
	budget?.charge("d1RowsRead", exists ? 1 : 0);
	if (exists) return;
	chargeMeta$1(budget, (await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at)
     VALUES(?1,'brolly-alert-rule','contributors.ambiguous',?2,?3,?4)`).bind(crypto.randomUUID(), key, JSON.stringify({
		alertInstanceId: instance.instance_id,
		top
	}), now).run()).meta);
}
async function prepareAmbiguousContributorApproval(db, instance, applicable, evidence, now, effective, budget) {
	const byResource = new Map(applicable.map((item) => [item.resource.id, item.resource]));
	const ranked = [...evidence].sort((left, right) => right.latestIntervalValue - left.latestIntervalValue || right.periodValue - left.periodValue || left.resourceId.localeCompare(right.resourceId));
	for (const candidate of ranked.slice(0, 5)) {
		const resource = byResource.get(candidate.resourceId);
		if (!resource || actionMode(resource.productFamily, effective) !== "prepare" || !manualActionEligible(resource, instance) || await hasDeniedAncestor(db, resource.id, budget)) continue;
		await insertPreparedAction(db, instance, resource, now, false, `${resource.displayName} is among the leading contributors; attribution requires operator review`, budget);
		return;
	}
}
async function ownEmergencyThresholds(db, instance, resourceIds, budget) {
	const wanted = new Set(resourceIds);
	const result = await db.prepare(`SELECT r.target_resource_id,MIN(l.threshold_value) AS threshold_value
     FROM alert_rules r JOIN alert_lines l ON l.alert_rule_id=r.id
     WHERE r.account_id=?1 AND r.metric_definition_id=?2 AND r.period=?3
       AND r.enabled=1 AND r.retired=0 AND l.enabled=1 AND l.retired=0
       AND r.target_resource_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM alert_lines higher
         WHERE higher.alert_rule_id=l.alert_rule_id AND higher.enabled=1 AND higher.retired=0 AND higher.priority>l.priority
       )
     GROUP BY r.target_resource_id LIMIT 5000`).bind(instance.account_id, instance.metric_definition_id, instance.period).all();
	chargeMeta$1(budget, result.meta);
	return new Map(result.results.filter((row) => wanted.has(row.target_resource_id)).map((row) => [row.target_resource_id, Number(row.threshold_value)]));
}
function manualActionEligible(resource, instance) {
	if (!["open", "acknowledged"].includes(instance.status) || instance.historical === 1 || ["missing", "stale"].includes(instance.data_quality)) return false;
	if (!isExactControllableResource(resource) || resource.excluded || !resourceControlReady(resource)) return false;
	if (!["standard", "disposable"].includes(resource.tier)) return false;
	if (resource.autoQuarantinePolicy === "deny") return false;
	if (resource.productFamily === "queues") return true;
	if (!resource.metadata.brollyFuse || resource.metadata.brollyFuse !== "true") return false;
	if (resource.productFamily === "workers") return /^[A-Za-z0-9_-]+$/.test(resource.cloudflareId);
	return /^[a-f0-9]{64}$/i.test(resource.cloudflareId) && Boolean(resource.metadata.cloudflareWorkerScript);
}
function isDescendant(resource, targetId, resources) {
	let current = resource;
	const visited = /* @__PURE__ */ new Set();
	while (current && !visited.has(current.id)) {
		if (current.id === targetId) return true;
		visited.add(current.id);
		current = current.parentResourceId ? resources.get(current.parentResourceId) : void 0;
	}
	return false;
}
async function hasDeniedAncestor(db, resourceId, budget) {
	const row = await db.prepare(`WITH RECURSIVE ancestors(id,parent_resource_id,auto_quarantine_policy,excluded,tier) AS (
       SELECT id,parent_resource_id,auto_quarantine_policy,excluded,tier FROM resources WHERE id=?1
       UNION ALL
       SELECT r.id,r.parent_resource_id,r.auto_quarantine_policy,r.excluded,r.tier
       FROM resources r JOIN ancestors a ON r.id=a.parent_resource_id
     )
     SELECT 1 AS denied FROM ancestors
     WHERE auto_quarantine_policy='deny' OR excluded=1 OR tier IN ('control_plane','critical') LIMIT 1`).bind(resourceId).first();
	budget?.charge("d1RowsRead", row ? 1 : 0);
	return Boolean(row);
}
async function loadRuleLines(db, accountId, metricIds, budget) {
	const placeholders = metricIds.map((_, index) => `?${index + 2}`).join(",");
	const result = await db.prepare(`SELECT
       r.id AS rule_id,r.account_id,r.target_resource_id,r.target_selector_json,r.metric_definition_id,
       r.measurement,r.period,r.notification_target_ids_json,r.auto_quarantine,
       r.auto_quarantine_contributors,r.confirmation_window_ms,
       l.id AS line_id,l.label,l.color,l.priority,l.threshold_value,l.action AS line_action,l.repeat_interval_ms
     FROM alert_rules r JOIN alert_lines l ON l.alert_rule_id=r.id
     WHERE r.account_id=?1 AND r.enabled=1 AND r.retired=0 AND l.enabled=1 AND l.retired=0
       AND r.metric_definition_id IN (${placeholders})
     ORDER BY r.id,l.priority`).bind(accountId, ...metricIds).all();
	chargeMeta$1(budget, result.meta);
	return result.results;
}
async function loadResources(db, ids, budget) {
	if (ids.length > 400) {
		const wanted = new Set(ids);
		const accountId = decodeURIComponent(ids[0]?.split(":")[0] ?? "");
		const result = await db.prepare(`SELECT * FROM resources WHERE account_id=?1 ORDER BY last_seen_at DESC LIMIT 50000`).bind(accountId).all();
		chargeMeta$1(budget, result.meta);
		return result.results.filter((row) => wanted.has(row.id));
	}
	const rows = [];
	for (let offset = 0; offset < ids.length; offset += 90) {
		const page = ids.slice(offset, offset + 90);
		const placeholders = page.map((_, index) => `?${index + 1}`).join(",");
		const result = await db.prepare(`SELECT * FROM resources WHERE id IN (${placeholders})`).bind(...page).all();
		chargeMeta$1(budget, result.meta);
		rows.push(...result.results);
	}
	return rows;
}
async function loadBreachedInstances(db, accountId, breachedAt, budget) {
	const rows = [];
	let after = "";
	while (rows.length < 1e5) {
		const result = await db.prepare(`SELECT
         i.id AS instance_id,i.period_start_at,i.period_end_at,i.observed_value,i.threshold_value AS instance_threshold,i.data_quality,
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
       ORDER BY i.id LIMIT 10000`).bind(accountId, breachedAt, after).all();
		chargeMeta$1(budget, result.meta);
		rows.push(...result.results);
		if (result.results.length < 1e4) break;
		after = result.results.at(-1).instance_id;
	}
	return rows;
}
async function notificationTargets(db, ids, budget) {
	if (!ids.length) return [];
	const page = ids.slice(0, 50);
	const placeholders = page.map((_, index) => `?${index + 1}`).join(",");
	const result = await db.prepare(`SELECT * FROM notification_targets WHERE enabled=1 AND id IN (${placeholders})`).bind(...page).all();
	chargeMeta$1(budget, result.meta);
	return result.results;
}
function notificationFromRow(row, targets, levelCount) {
	return {
		instanceId: row.instance_id,
		ruleId: row.rule_id,
		lineId: row.line_id,
		lineLabel: row.label,
		priority: row.priority,
		observed: row.observed_value,
		threshold: row.instance_threshold,
		metricDefinitionId: row.metric_definition_id,
		resource: resourceFromRow(row),
		severity: alertSeverity(Math.floor(row.priority / 10), levelCount),
		targets
	};
}
function alertInstanceCanNotify(status, historical, nextNotificationAt, now) {
	return status === "open" && !historical && (nextNotificationAt === null || nextNotificationAt <= now);
}
function alertBillingCycleBounds(cycles, timestamp, fallback) {
	return cycles.find((cycle) => cycle.startsAt <= timestamp && cycle.endsAt > timestamp) ?? fallback;
}
async function loadBillingCycleBounds(db, accountId, changes, budget) {
	const timestamps = changes.map((change) => Math.max(change.periodStartAt, change.periodEndAt - 1));
	const minimum = Math.min(...timestamps);
	const maximum = Math.max(...timestamps);
	const result = await db.prepare(`SELECT starts_at,ends_at FROM billing_cycles
     WHERE account_id=?1 AND ends_at>?2 AND starts_at<=?3
     ORDER BY approximate ASC,starts_at ASC LIMIT 36`).bind(accountId, minimum, maximum).all();
	chargeMeta$1(budget, result.meta);
	return result.results.map((row) => ({
		startsAt: Number(row.starts_at),
		endsAt: Number(row.ends_at)
	}));
}
function observedValue(measurement, period, change) {
	if (measurement === "usage") return period === "day" ? change.dayValue : change.cycleValue;
	if (measurement === "estimated_cost") return period === "day" ? change.estimatedDayUsd : change.estimatedCycleUsd;
	return period === "day" ? change.billedDayUsd ?? 0 : change.billedCycleUsd ?? 0;
}
function periodQuality(change, period) {
	return period === "day" ? change.quality : change.cycleQuality;
}
function periodSampleInterval(change, period) {
	return period === "day" ? change.sampleInterval : change.cycleSampleInterval;
}
function ruleMatchesResource(rule, resource) {
	if (rule.target_resource_id) return rule.target_resource_id === resource.id;
	if (!rule.target_selector_json) return false;
	let selector;
	try {
		selector = JSON.parse(rule.target_selector_json);
	} catch {
		return false;
	}
	return (!selector.productFamily || selector.productFamily === resource.productFamily) && (!selector.resourceType || selector.resourceType === resource.resourceType) && (!selector.parentResourceId || selector.parentResourceId === resource.parentResourceId) && (!selector.cloudflareId || selector.cloudflareId === resource.cloudflareId) && (!selector.tier || selector.tier === resource.tier) && Object.entries(selector).filter(([key]) => key.startsWith("tag:")).every(([key, value]) => resource.metadata[key.slice(4)] === value);
}
function resourceFromRow(row) {
	return {
		id: row.id,
		accountId: row.account_id,
		parentResourceId: row.parent_resource_id,
		productFamily: row.product_family,
		resourceType: row.resource_type,
		cloudflareId: row.cloudflare_id,
		displayName: row.display_name,
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
		lastActiveAt: row.last_active_at,
		coverageStatus: row.coverage_status,
		controlCapability: row.control_capability,
		runtimeFuseStatus: row.runtime_fuse_status,
		autoQuarantinePolicy: row.auto_quarantine_policy,
		tier: row.tier,
		excluded: row.excluded === 1,
		metadata: parseStringRecord$1(row.metadata_json)
	};
}
function assetFromResource(resource) {
	const scope = resource.resourceType.split(":").at(-1);
	return {
		accountId: resource.accountId,
		family: resource.productFamily,
		id: resource.cloudflareId,
		parentId: resource.parentResourceId ?? void 0,
		name: resource.displayName,
		scope: scope === "object" || scope === "namespace" || scope === "resource" || scope === "zone" || scope === "account" ? scope : "resource",
		tier: resource.tier,
		tags: resource.metadata
	};
}
function actionFromStoredRow(row, resource) {
	return {
		id: String(row.id),
		incidentId: String(row.incident_id),
		asset: assetFromResource(resource),
		kind: String(row.kind),
		state: String(row.state),
		reason: String(row.reason),
		observed: parseNumberRecord(row.observed_json),
		rollback: parseUnknownRecord(row.rollback_json),
		actor: String(row.actor),
		createdAt: Number(row.created_at)
	};
}
function blocksAutomaticAction(row, alertInstanceId) {
	return Boolean(row) && (row?.state !== "prepared" || row.alert_instance_id !== alertInstanceId);
}
function isExactControllableResource(resource) {
	return resource.resourceType.endsWith(":resource") && resource.productFamily === "workers" || resource.resourceType.endsWith(":object") && resource.productFamily === "durable_objects" || resource.resourceType.endsWith(":resource") && resource.productFamily === "queues";
}
function resourceControlReady(resource) {
	return resource.productFamily === "queues" ? resource.controlCapability !== "none" : resource.controlCapability === "runtime_fuse" && resource.runtimeFuseStatus === "verified";
}
function actionMode(family, effective) {
	return family === "durable_objects" ? effective.quarantine : family === "workers" || family === "queues" ? effective.stopOrPause : null;
}
function automaticActionEligible(resource, evidence) {
	if (resource.productFamily !== "queues") return exactAutomaticActionEligible({
		resource,
		...evidence,
		ruleOptIn: true,
		parentDenied: false
	});
	return evidence.quality === "complete" && evidence.sampleInterval === 1 && evidence.measurement === "usage" && evidence.fresh && evidence.confirmationSatisfied && !evidence.alreadyQuarantined && !resource.excluded && ![
		"control_plane",
		"critical",
		"unclassified"
	].includes(resource.tier) && resource.autoQuarantinePolicy !== "deny" && resource.controlCapability !== "none";
}
function parseEvidence(value) {
	try {
		const parsed = JSON.parse(value);
		return {
			sampleInterval: typeof parsed.sampleInterval === "number" ? parsed.sampleInterval : null,
			watermarkAt: typeof parsed.watermarkAt === "number" ? parsed.watermarkAt : null
		};
	} catch {
		return {
			sampleInterval: null,
			watermarkAt: null
		};
	}
}
function alertSeverity(position, levelCount) {
	if (position >= levelCount - 1) return "emergency";
	if (levelCount >= 3 && position >= levelCount - 2) return "critical";
	return "warning";
}
function alertInstanceId(ruleId, lineId, resourceIdValue, start, end) {
	return [
		ruleId,
		lineId,
		resourceIdValue,
		start,
		end
	].map(encodeURIComponent).join(":");
}
async function runBatches$2(db, statements, budget) {
	for (let offset = 0; offset < statements.length; offset += MAX_BATCH$1) {
		const results = await db.batch(statements.slice(offset, offset + MAX_BATCH$1));
		for (const result of results) chargeMeta$1(budget, result.meta);
	}
}
function chargeMeta$1(budget, meta) {
	budget?.charge("d1RowsRead", meta.rows_read ?? 0);
	budget?.charge("d1RowsWritten", meta.rows_written ?? meta.changes ?? 0);
}
function parseStringRecord$1(value) {
	try {
		const parsed = JSON.parse(value);
		return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === "string"));
	} catch {
		return {};
	}
}
function parseNumberRecord(value) {
	try {
		const parsed = JSON.parse(String(value));
		return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === "number"));
	} catch {
		return {};
	}
}
function parseUnknownRecord(value) {
	try {
		const parsed = JSON.parse(String(value));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
//#endregion
//#region src/retention.ts
async function runRetentionMaintenance(db, accountId, budget, now = Date.now(), timeZone = "UTC") {
	const [capacitySetting, pageCountRow, pageSizeRow, rowEstimate] = await Promise.all([
		db.prepare(`SELECT value FROM settings WHERE key='d1_capacity_bytes' LIMIT 1`).first(),
		db.prepare(`PRAGMA page_count`).first(),
		db.prepare(`PRAGMA page_size`).first(),
		db.prepare(`SELECT COUNT(*) AS rows,AVG(length(u.metrics_json)+length(u.sampling_json)+192) AS average_bytes
       FROM usage_daily u JOIN resources r ON r.id=u.resource_id
       WHERE r.account_id=?1 AND r.resource_type NOT IN ('account','product')
         AND r.resource_type NOT LIKE '%:namespace'`).bind(accountId).first()
	]);
	budget?.charge("d1RowsRead", 4 + Number(rowEstimate?.rows ?? 0));
	const usedBytes = (firstNumber(pageCountRow) ?? 0) * (firstNumber(pageSizeRow) ?? 4096);
	const capacityBytes = positiveNumber(capacitySetting?.value) ?? 5e8;
	const decision = capacityDecision(usedBytes, capacityBytes);
	const today = localDayAt(now, timeZone);
	const retentionCutoff = localDayAt(now - 63072e6, timeZone);
	let prunedRows = 0;
	const routine = await db.batch([db.prepare(`DELETE FROM usage_daily WHERE rowid IN (
         SELECT u.rowid FROM usage_daily u JOIN resources r ON r.id=u.resource_id
         WHERE r.account_id=?1 AND u.local_day<?2 ORDER BY u.local_day ASC LIMIT 5000
       )`).bind(accountId, retentionCutoff), db.prepare(`DELETE FROM usage_accumulator_shards WHERE rowid IN (
         SELECT rowid FROM usage_accumulator_shards
         WHERE local_day<?1 AND json_extract(payload_json,'$.sealedAt') IS NOT NULL
         ORDER BY local_day ASC LIMIT 500
       )`).bind(localDayAt(now - 2592e5, timeZone))]);
	for (const result of routine) chargeMeta(budget, result.meta);
	if (decision.pauseBackfill) chargeMeta(budget, (await db.prepare(`UPDATE backfill_jobs SET status='paused',paused_reason='d1_capacity',updated_at=?1
       WHERE account_id=?2 AND status IN ('pending','running')`).bind(now, accountId).run()).meta);
	else chargeMeta(budget, (await db.prepare(`UPDATE backfill_jobs SET status='pending',paused_reason=NULL,updated_at=?1
       WHERE account_id=?2 AND status='paused' AND paused_reason='d1_capacity'`).bind(now, accountId).run()).meta);
	if (decision.pruneIndividualHistory) {
		const averageBytes = Math.max(256, Number(rowEstimate?.average_bytes ?? 512));
		const needed = Math.ceil((usedBytes - decision.targetBytes) / averageBytes);
		const limit = Math.min(2e4, Math.max(1, needed));
		const result = await db.prepare(`DELETE FROM usage_daily WHERE rowid IN (
         SELECT u.rowid FROM usage_daily u JOIN resources r ON r.id=u.resource_id
         WHERE r.account_id=?1 AND r.resource_type NOT IN ('account','product')
           AND r.resource_type NOT LIKE '%:namespace'
         ORDER BY u.local_day ASC,u.resource_id ASC LIMIT ?2
       )`).bind(accountId, limit).run();
		chargeMeta(budget, result.meta);
		prunedRows = Number(result.meta.changes ?? result.meta.rows_written ?? 0);
	}
	const oldest = await db.prepare(`SELECT MIN(u.local_day) AS oldest FROM usage_daily u JOIN resources r ON r.id=u.resource_id
     WHERE r.account_id=?1 AND r.resource_type NOT IN ('account','product')
       AND r.resource_type NOT LIKE '%:namespace'`).bind(accountId).first();
	budget?.charge("d1RowsRead", 1);
	const oldestResourceDay = oldest?.oldest ?? null;
	chargeMeta(budget, (await db.prepare(`INSERT INTO monitor_usage_daily(
       account_id,local_day,storage_bytes,storage_capacity_bytes,oldest_resource_day,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6)
     ON CONFLICT(account_id,local_day) DO UPDATE SET
       storage_bytes=excluded.storage_bytes,storage_capacity_bytes=excluded.storage_capacity_bytes,
       oldest_resource_day=excluded.oldest_resource_day,updated_at=excluded.updated_at`).bind(accountId, today, usedBytes, capacityBytes, oldestResourceDay, now).run()).meta);
	if (decision.warn) {
		const warningKey = `capacity-warning:${today}`;
		chargeMeta(budget, (await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at)
       SELECT ?1,'brolly-retention','d1.capacity.warning',?2,?3,?4
       WHERE NOT EXISTS(
         SELECT 1 FROM audit_log WHERE action='d1.capacity.warning' AND target=?2
       )`).bind(crypto.randomUUID(), warningKey, JSON.stringify({
			usedBytes,
			capacityBytes,
			pressure: decision.pressure,
			prunedRows
		}), now).run()).meta);
	}
	return {
		usedBytes,
		capacityBytes,
		pressure: decision.pressure,
		backfillPaused: decision.pauseBackfill,
		prunedRows,
		oldestResourceDay
	};
}
function firstNumber(row) {
	if (!row) return null;
	return Object.values(row).find((item) => typeof item === "number") ?? null;
}
function positiveNumber(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function chargeMeta(budget, meta) {
	budget?.charge("d1RowsRead", meta.rows_read ?? 0);
	budget?.charge("d1RowsWritten", meta.rows_written ?? meta.changes ?? 0);
}
//#endregion
//#region src/backfill.ts
async function runOneBackfillSlice(env, client, ledger, budget, timeZone, options = {}) {
	if (budget.remaining("d1RowsWritten") < 1e3 || budget.remaining("wallMs") < 8e3) return {
		worked: false,
		complete: false,
		samples: 0
	};
	const slice = await env.DB.prepare(`SELECT s.* FROM backfill_slices s JOIN backfill_jobs j ON j.id=s.backfill_job_id
     WHERE s.status='pending' AND j.status IN ('pending','running')
       AND (?1 IS NULL OR j.id=?1)
       AND (?2 IS NULL OR j.kind=?2)
       AND (s.next_eligible_at IS NULL OR s.next_eligible_at<=?3)
     ORDER BY s.ends_at DESC,s.collector_key LIMIT 1`).bind(options.jobId ?? null, options.kind ?? null, Date.now()).first();
	budget.charge("d1RowsRead", slice ? 1 : 0);
	if (!slice) return {
		worked: false,
		complete: true,
		samples: 0
	};
	const collector = toUsageCollector(slice.collector_key);
	const requiredQueries = (collector ? productUsageDefinition(collector) : void 0)?.datasets.length ?? (collector === "graphql:durable-objects" || collector === "graphql:workers" ? 16 : 1);
	if (collector === "billing" ? budget.remaining("restRequests") < 1 : budget.remaining("graphqlQueries") < requiredQueries) return {
		worked: false,
		complete: false,
		samples: 0
	};
	budget.charge("backfillSlices");
	const claimed = await env.DB.prepare(`UPDATE backfill_slices SET status='running',updated_at=?2 WHERE id=?1 AND status='pending'`).bind(slice.id, Date.now()).run();
	budget.charge("d1RowsWritten", Number(claimed.meta.rows_written ?? claimed.meta.changes ?? 0));
	if (Number(claimed.meta.changes ?? 0) !== 1) return {
		worked: false,
		complete: false,
		samples: 0
	};
	try {
		if (!collector) {
			await finishSlice(env.DB, budget, slice, "complete", null, "Collector has no historical implementation", "missing");
			await updateJobStatus(env.DB, budget, slice.backfill_job_id);
			return {
				worked: true,
				complete: true,
				samples: 0
			};
		}
		const result = await ingestWindow({
			env,
			client,
			ledger,
			collector,
			startsAt: slice.starts_at,
			endsAt: slice.ends_at,
			cursor: collector === "graphql:durable-objects" ? parseCursor(slice.cursor_json) : collector === "graphql:workers" ? parseWorkerCursor(slice.cursor_json) : void 0,
			budget,
			timeZone,
			historical: true,
			maxPages: 2
		});
		const unavailable = result.coverage.find((item) => (item.state === "permission_denied" || item.state === "unavailable") && !(collector === "graphql:workers" && item.metric === "cache_requests") && !item.detail?.startsWith("This metric is retained through authoritative billing"));
		if (unavailable) throw new Error(unavailable.detail ?? `${collector} telemetry is ${unavailable.state}`);
		const terminal = collector === "billing" || result.complete;
		const coverage = collector === "billing" ? result.coverage.some((item) => item.metric === "initial_import_gaps" && item.state !== "healthy") ? "partial" : "complete" : result.complete && !result.coverage.some((item) => item.state === "delayed") ? "complete" : "partial";
		await finishSlice(env.DB, budget, slice, terminal ? "complete" : "pending", result.continuation, terminal ? null : "Continuation saved after the bounded page budget", coverage);
		await updateJobStatus(env.DB, budget, slice.backfill_job_id);
		return {
			worked: true,
			complete: result.complete,
			samples: result.observations
		};
	} catch (error) {
		const previousRetryCount = Math.min(3, Number(slice.retry_count ?? 0));
		const failed = previousRetryCount >= 3;
		const retryCount = failed ? 3 : previousRetryCount + 1;
		await finishSlice(env.DB, budget, slice, failed ? "failed" : "pending", parseCursor(slice.cursor_json), error instanceof Error ? error.message : String(error), "missing", !failed, retryCount);
		await updateJobStatus(env.DB, budget, slice.backfill_job_id);
		return {
			worked: true,
			complete: false,
			samples: 0
		};
	}
}
async function finishSlice(db, budget, slice, status, cursor, error, coverage, retry = false, retryCount) {
	const nextEligibleAt = retry && (retryCount ?? 0) <= 3 ? Date.now() + [
		3e4,
		12e4,
		48e4
	][Math.max(0, (retryCount ?? 1) - 1)] : null;
	const result = await db.prepare(`UPDATE backfill_slices SET
       status=?2,cursor_json=?3,error=?4,coverage_status=?5,
       retry_count=COALESCE(?6,retry_count),next_eligible_at=?7,updated_at=?8 WHERE id=?1`).bind(slice.id, status, cursor ? JSON.stringify(cursor) : null, error?.slice(0, 2e3) ?? null, coverage, retryCount ?? null, nextEligibleAt, Date.now()).run();
	budget.charge("d1RowsWritten", Number(result.meta.rows_written ?? result.meta.changes ?? 0));
}
async function updateJobStatus(db, budget, jobId) {
	const result = await db.prepare(`UPDATE backfill_jobs SET
       status=CASE WHEN EXISTS(
         SELECT 1 FROM backfill_slices WHERE backfill_job_id=?1 AND status IN ('pending','running')
       ) THEN 'running' ELSE 'complete' END,
       updated_at=?2 WHERE id=?1`).bind(jobId, Date.now()).run();
	budget.charge("d1RowsWritten", Number(result.meta.rows_written ?? result.meta.changes ?? 0));
}
function toUsageCollector(value) {
	if (value === "billing" || value.includes("billing")) return "billing";
	if (value.includes("durable")) return "graphql:durable-objects";
	if (value === "graphql:workers" || value === "graphql:workersInvocationsAdaptive") return "graphql:workers";
	if (productUsageDefinition(value)) return value;
	return null;
}
function parseCursor(value) {
	if (!value) return void 0;
	try {
		return JSON.parse(value);
	} catch {
		return;
	}
}
function parseWorkerCursor(value) {
	if (!value) return void 0;
	try {
		return JSON.parse(value);
	} catch {
		return;
	}
}
//#endregion
//#region src/policy-migration.ts
var MAX_BATCH = 100;
async function migrateLegacyPolicyRules(db, accountId, policy, force = false) {
	const state = await db.prepare(`SELECT value FROM settings WHERE key='usage_ledger_policy_version' LIMIT 1`).first();
	if (!force && state?.value === policy.version) return 0;
	const levels = await loadAlertLevels(db);
	const now = Date.now();
	const rootId = resourceId(accountId, "account", "account", accountId);
	const statements = [db.prepare(`INSERT OR IGNORE INTO resources(
         id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,
         first_seen_at,last_seen_at,coverage_status,control_capability,runtime_fuse_status,
         auto_quarantine_policy,tier,excluded,collector_key,dataset,metadata_json
       ) VALUES(?1,?2,NULL,'account','account',?2,'Cloudflare account',?3,?3,'missing','none','unknown','inherit','unclassified',0,'migration','legacy-policy','{}')`).bind(rootId, accountId, now)];
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
		now
	});
	ruleCount += 1;
	for (const product of METRIC_CATALOG) {
		const family = product.family;
		const productId = resourceId(accountId, family, "product", family);
		statements.push(db.prepare(`INSERT OR IGNORE INTO resources(
         id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,
         first_seen_at,last_seen_at,coverage_status,control_capability,runtime_fuse_status,
         auto_quarantine_policy,tier,excluded,collector_key,dataset,metadata_json
       ) VALUES(?1,?2,?3,?4,'product',?4,?5,?6,?6,'missing','none','unknown','inherit','unclassified',0,'migration','legacy-policy','{}')`).bind(productId, accountId, rootId, family, displayFamily(family), now));
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
			now
		});
		ruleCount += 1;
	}
	for (const [key, limits] of Object.entries(policy.assetDailySpend ?? {})) {
		const parsed = parseAssetBudgetKey(key);
		if (!parsed) continue;
		const row = await db.prepare(`SELECT id FROM resources
       WHERE account_id=?1 AND product_family=?2 AND cloudflare_id=?3
         AND resource_type LIKE ?4 ORDER BY last_seen_at DESC LIMIT 1`).bind(accountId, parsed.family, parsed.id, `%:${parsed.scope}`).first();
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
			now
		});
		ruleCount += 1;
	}
	for (const threshold of policy.thresholds) for (const product of METRIC_CATALOG.filter((item) => item.metrics.includes(threshold.metric))) {
		addUsageRule(db, statements, accountId, product.family, threshold, levels, now);
		ruleCount += 1;
	}
	if (policy.limits) for (const [period, scopes] of [["day", policy.limits.day], ["billing_cycle", policy.limits.cycle]]) for (const [scopeKey, scope] of Object.entries(scopes)) {
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
				now
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
				now
			});
			ruleCount += 1;
		}
	}
	statements.push(db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('usage_ledger_policy_version',?1,?2)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(policy.version, now), db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at)
       VALUES(?1,'brolly-migration','policy.rules.migrate',?2,?3,?4)`).bind(crypto.randomUUID(), policy.version, JSON.stringify({ rules: ruleCount }), now));
	await runBatches$1(db, statements);
	return ruleCount;
}
function chartCost(scope, fallback) {
	return scope && Object.keys(scope.cost).length ? scope.cost : fallback;
}
async function resolvePolicyScope(db, accountId, rootId, scopeKey) {
	if (scopeKey === "account") return {
		resourceId: rootId,
		family: "account"
	};
	const family = scopeKey.match(/^family:(.+)$/)?.[1];
	if (family) return {
		resourceId: resourceId(accountId, family, "product", family),
		family
	};
	const assetKey = scopeKey.match(/^asset:(.+)$/)?.[1];
	const asset = assetKey ? parseAssetBudgetKey(assetKey) : null;
	if (!asset) return null;
	const row = await db.prepare(`SELECT id FROM resources
     WHERE account_id=?1 AND product_family=?2 AND cloudflare_id=?3
       AND resource_type LIKE ?4 ORDER BY last_seen_at DESC LIMIT 1`).bind(accountId, asset.family, asset.id, `%:${asset.scope}`).first();
	return row ? {
		resourceId: row.id,
		family: asset.family
	} : null;
}
function chartRuleId(period, scope, dimension) {
	return `policy:${period}:${encodeURIComponent(scope)}:${encodeURIComponent(dimension)}`;
}
function addSpendRule(db, statements, input) {
	addRule(db, statements, {
		...input,
		measurement: "estimated_cost",
		period: "day",
		enabled: input.enabled,
		lines: materializedSpendLines(input.limits, input.levels, input.levelEnabled)
	});
}
function addUsageRule(db, statements, accountId, family, threshold, levels, now) {
	addRule(db, statements, {
		id: legacyId("threshold", `${family}:${threshold.metric}:${threshold.windowMs}`),
		key: `threshold:${family}:${threshold.metric}:${threshold.windowMs}`,
		accountId,
		targetResourceId: null,
		targetSelector: { productFamily: family },
		metricDefinitionId: `${family}:${threshold.metric}`,
		measurement: "usage",
		period: threshold.windowMs >= 24192e5 ? "billing_cycle" : "day",
		now,
		lines: levels.flatMap((level, index) => {
			const value = thresholdValue(threshold, level);
			return value === void 0 ? [] : [{
				levelId: level.id,
				label: level.label,
				color: levelColor(index, levels.length),
				priority: level.position * 10,
				value,
				enabled: true
			}];
		})
	});
}
function addRule(db, statements, input) {
	statements.push(db.prepare(`INSERT INTO alert_rules(
       id,account_id,target_resource_id,target_selector_json,metric_definition_id,measurement,period,
       notification_target_ids_json,auto_quarantine,auto_quarantine_contributors,confirmation_window_ms,
       enabled,legacy_policy_key,created_at,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6,?7,'[]',0,0,300000,?8,?9,?10,?10)
     ON CONFLICT(id) DO UPDATE SET
       target_resource_id=excluded.target_resource_id,target_selector_json=excluded.target_selector_json,
       metric_definition_id=excluded.metric_definition_id,measurement=excluded.measurement,
       period=excluded.period,enabled=excluded.enabled,retired=0,
       legacy_policy_key=excluded.legacy_policy_key,updated_at=excluded.updated_at`).bind(input.id, input.accountId, input.targetResourceId, input.targetSelector ? JSON.stringify(input.targetSelector) : null, input.metricDefinitionId, input.measurement, input.period, input.enabled === false ? 0 : 1, input.key, input.now));
	statements.push(db.prepare(`UPDATE alert_lines SET retired=1,updated_at=?2 WHERE alert_rule_id=?1`).bind(input.id, input.now));
	for (const line of input.lines) statements.push(db.prepare(`INSERT INTO alert_lines(
         id,alert_rule_id,level_id,label,color,priority,threshold_value,action,repeat_interval_ms,
         enabled,created_at,updated_at
       ) VALUES(?1,?2,?3,?4,?5,?6,?7,'notify',NULL,?8,?9,?9)
       ON CONFLICT(alert_rule_id,level_id) DO UPDATE SET
         label=excluded.label,color=excluded.color,priority=excluded.priority,threshold_value=excluded.threshold_value,
         repeat_interval_ms=excluded.repeat_interval_ms,enabled=excluded.enabled,retired=0,updated_at=excluded.updated_at`).bind(`${input.id}:${line.levelId}`, input.id, line.levelId, line.label, line.color, line.priority, line.value, line.enabled ? 1 : 0, input.now));
}
function materializedSpendLines(limits, levels, levelEnabled) {
	return levels.flatMap((level, index) => finiteLimit(limits[level.id]) ? [{
		levelId: level.id,
		label: level.label,
		color: levelColor(index, levels.length),
		priority: level.position * 10,
		value: limits[level.id],
		enabled: levelEnabled?.[level.id] !== false
	}] : []);
}
function finiteLimit(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function thresholdValue(threshold, level) {
	const key = level.id === "warning" || level.id === "critical" || level.id === "emergency" ? level.id : level.label.toLowerCase() === "warning" || level.label.toLowerCase() === "critical" || level.label.toLowerCase() === "emergency" ? level.label.toLowerCase() : null;
	return key ? threshold[key] : void 0;
}
function levelColor(index, count) {
	if (index === count - 1) return "#ef4444";
	if (index === count - 2) return "#dc6b24";
	return "#f59e0b";
}
function legacyId(kind, key) {
	return `legacy:${kind}:${encodeURIComponent(key)}`;
}
function parseAssetBudgetKey(key) {
	const [family, scope, ...parts] = key.split(":");
	return family && scope && parts.length ? {
		family,
		scope,
		id: parts.join(":")
	} : null;
}
function displayFamily(family) {
	return family.replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase());
}
async function runBatches$1(db, statements) {
	for (let offset = 0; offset < statements.length; offset += MAX_BATCH) await db.batch(statements.slice(offset, offset + MAX_BATCH));
}
//#endregion
//#region src/ledger-settings.ts
var SETTING_KEY = "ledger_run_limits";
async function configuredLedgerRunLimits(db) {
	const row = await db.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`).bind(SETTING_KEY).first();
	if (!row) return { ...DEFAULT_LEDGER_RUN_LIMITS };
	try {
		return new LedgerRunBudget(JSON.parse(row.value)).limits;
	} catch {
		return { ...DEFAULT_LEDGER_RUN_LIMITS };
	}
}
function validateLedgerRunLimits(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) return "Monitoring limits must be an object";
	const values = input;
	for (const key of Object.keys(DEFAULT_LEDGER_RUN_LIMITS)) {
		const value = values[key];
		if (!Number.isInteger(value) || Number(value) <= 0) return `${key} must be a positive integer`;
		if (Number(value) > MAX_LEDGER_RUN_LIMITS[key]) return `${key} cannot exceed ${MAX_LEDGER_RUN_LIMITS[key]}`;
	}
	const unknown = Object.keys(values).find((key) => !Object.hasOwn(DEFAULT_LEDGER_RUN_LIMITS, key));
	return unknown ? `Unknown monitoring limit: ${unknown}` : null;
}
async function saveLedgerRunLimits(db, input) {
	const error = validateLedgerRunLimits(input);
	if (error) throw new TypeError(error);
	const limits = new LedgerRunBudget(input).limits;
	await db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(SETTING_KEY, JSON.stringify(limits), Date.now()).run();
	return limits;
}
//#endregion
//#region src/monitor.ts
async function runMonitor(env, options = {}) {
	const ledgerBudget = new LedgerRunBudget(await configuredLedgerRunLimits(env.DB));
	const budget = new RunBudget({
		apiCalls: ledgerBudget.limits.graphqlQueries + ledgerBudget.limits.restRequests,
		databaseRows: ledgerBudget.limits.d1RowsRead + ledgerBudget.limits.d1RowsWritten,
		samples: 1e5,
		wallMs: ledgerBudget.limits.wallMs
	});
	const store = new Store(env.DB, (amount, kind) => {
		budget.charge("databaseRows", amount);
		ledgerBudget.charge(kind === "read" ? "d1RowsRead" : "d1RowsWritten", amount);
	});
	const ledger = new LedgerStore(env.DB, ledgerBudget);
	const holder = crypto.randomUUID();
	if (!await store.acquireLease("minute-monitor", holder, 55e3)) return;
	const automaticQueue = /* @__PURE__ */ new Map();
	const automaticCloudflareActions = [];
	const startedAt = Date.now();
	const timeZone = env.BROLLY_TIMEZONE ?? "UTC";
	const collectionEnd = Math.floor((startedAt - 12e4) / 3e5) * 5 * 6e4;
	let activeDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "active-usage", 3e5, startedAt, options.force === true);
	if (!activeDue && !options.force) {
		if (await env.DB.prepare(`SELECT 1 AS present FROM collector_state
       WHERE account_id=?1 AND collector_key IN ('graphql:durable-objects','graphql:workers')
         AND partition_key IN ('active','correction') AND last_status='partial' LIMIT 1`).bind(env.BROLLY_ACCOUNT_ID).first()) activeDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "active-usage", 3e5, startedAt, true);
	}
	let hotWatch = false;
	if (!activeDue && !options.force) {
		const watched = await env.DB.prepare(`SELECT 1 AS present FROM alert_instances i JOIN alert_lines l ON l.id=i.alert_line_id
       WHERE i.status='open' AND i.historical=0 AND i.period_end_at>?1
         AND l.level_id IN (SELECT id FROM alert_levels ORDER BY position DESC LIMIT 2) LIMIT 1`).bind(startedAt).first();
		const watermark = await env.DB.prepare(`SELECT MIN(high_watermark_at) AS watermark FROM collector_state
       WHERE account_id=?1 AND collector_key IN ('graphql:durable-objects','graphql:workers')
         AND partition_key='active'`).bind(env.BROLLY_ACCOUNT_ID).first();
		if (watched && Number(watermark?.watermark ?? 0) < collectionEnd) hotWatch = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "hot-watch", 6e4, startedAt);
	}
	if (!activeDue && !hotWatch) return;
	const runId = await ledger.startMonitorRun(env.BROLLY_ACCOUNT_ID, options.force ? "explicit_refresh" : hotWatch ? "hot_watch" : "active_usage", startedAt);
	let runFinished = false;
	let runContinuation;
	let normalizedSamples = 0;
	try {
		const policy = await store.loadPolicy();
		const client = new CloudflareClient(env, budget, ledgerBudget);
		const now = startedAt;
		const utcMinute = new Date(now).getUTCMinutes();
		const since = collectionEnd - 3e5;
		const inventoryDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "resource-inventory", 36e5, now, options.force === true);
		const capabilityDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "capability-discovery", 864e5, now, options.force === true);
		const billingDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "billing-reconciliation", 36e5, now, options.force === true);
		const retentionDue = await ledger.claimDueCollector(env.BROLLY_ACCOUNT_ID, "retention-maintenance", 36e5, now, options.force === true);
		if (capabilityDue) await ledger.syncMetricCatalog();
		const inventory = inventoryDue ? await client.inventory() : {
			assets: [],
			coverage: []
		};
		budget.charge("samples", inventory.assets.length);
		await store.saveAssets(inventory.assets);
		for (const family of new Set(inventory.assets.map((asset) => asset.family))) await store.applyPoliciesToAssets(inventory.assets.filter((asset) => asset.family === family), family);
		await ledger.saveInventory(inventory.assets);
		await store.saveCoverage(inventory.coverage);
		if (capabilityDue) {
			await ledger.saveCapabilities(await client.analyticsCapabilities());
			await ledger.persistCollectorState(env.BROLLY_ACCOUNT_ID, "capability-discovery", "", {
				nextEligibleAt: now + 864e5,
				status: "complete",
				watermarkAt: now
			});
		}
		if (inventoryDue) await ledger.persistCollectorState(env.BROLLY_ACCOUNT_ID, "resource-inventory", "", {
			nextEligibleAt: now + 36e5,
			status: "complete",
			watermarkAt: now
		});
		if (capabilityDue) await migrateLegacyPolicyRules(env.DB, env.BROLLY_ACCOUNT_ID, policy);
		const [durableActiveCursor, durableCorrectionCursor, workerActiveCursor, workerCorrectionCursor] = await Promise.all([
			ledger.collectorCursor(env.BROLLY_ACCOUNT_ID, "graphql:durable-objects", "active"),
			ledger.collectorCursor(env.BROLLY_ACCOUNT_ID, "graphql:durable-objects", "correction"),
			ledger.collectorCursor(env.BROLLY_ACCOUNT_ID, "graphql:workers", "active"),
			ledger.collectorCursor(env.BROLLY_ACCOUNT_ID, "graphql:workers", "correction")
		]);
		const durableActiveWindow = collectorWindow(durableActiveCursor, since, collectionEnd);
		const durableCorrectionWindow = collectorWindow(durableCorrectionCursor, since - 3e5, since);
		const workerActiveWindow = collectorWindow(workerActiveCursor, since, collectionEnd);
		const workerCorrectionWindow = collectorWindow(workerCorrectionCursor, since - 3e5, since);
		const [durableObjects, durableCorrections, workers, workerCorrections] = await Promise.all([
			ingestWindow({
				env,
				client,
				ledger,
				collector: "graphql:durable-objects",
				budget: ledgerBudget,
				timeZone,
				startsAt: durableActiveWindow.startAt,
				endsAt: durableActiveWindow.endAt,
				cursor: durableActiveWindow.cursor,
				persist: false
			}),
			ingestWindow({
				env,
				client,
				ledger,
				collector: "graphql:durable-objects",
				budget: ledgerBudget,
				timeZone,
				startsAt: durableCorrectionWindow.startAt,
				endsAt: durableCorrectionWindow.endAt,
				cursor: durableCorrectionWindow.cursor,
				persist: false
			}),
			ingestWindow({
				env,
				client,
				ledger,
				collector: "graphql:workers",
				budget: ledgerBudget,
				timeZone,
				startsAt: workerActiveWindow.startAt,
				endsAt: workerActiveWindow.endAt,
				cursor: workerActiveWindow.cursor,
				persist: false
			}),
			ingestWindow({
				env,
				client,
				ledger,
				collector: "graphql:workers",
				budget: ledgerBudget,
				timeZone,
				startsAt: workerCorrectionWindow.startAt,
				endsAt: workerCorrectionWindow.endAt,
				cursor: workerCorrectionWindow.cursor,
				persist: false
			})
		]);
		runContinuation = {
			durableObjects: windowContinuation(durableActiveWindow, durableObjects.continuation, collectionEnd),
			durableObjectCorrections: windowContinuation(durableCorrectionWindow, durableCorrections.continuation),
			workers: windowContinuation(workerActiveWindow, workers.continuation, collectionEnd),
			workerCorrections: windowContinuation(workerCorrectionWindow, workerCorrections.continuation)
		};
		await store.saveCoverage([...durableObjects.coverage, ...workers.coverage]);
		await store.applyPoliciesToAssets([...durableObjects.samples, ...durableCorrections.samples].map((sample) => sample.asset), "durable_objects");
		await store.applyPoliciesToAssets([...workers.samples, ...workerCorrections.samples].map((sample) => sample.asset), "workers");
		normalizedSamples = durableObjects.observations + durableCorrections.observations + workers.observations + workerCorrections.observations;
		const ledgerObservations = [
			...durableCorrections.normalizedObservations ?? [],
			...durableObjects.normalizedObservations ?? [],
			...workerCorrections.normalizedObservations ?? [],
			...workers.normalizedObservations ?? []
		];
		const ledgerChanges = await ledger.applyObservations(ledgerObservations, timeZone);
		const billingCycle = await ledger.currentBillingCycle(env.BROLLY_ACCOUNT_ID, collectionEnd);
		const alertResult = await evaluateUsageAlerts(env, ledgerChanges, {
			timeZone,
			billingCycleId: billingCycle.id,
			billingCycleStart: billingCycle.startsAt,
			billingCycleEnd: billingCycle.endsAt,
			now,
			budget: ledgerBudget
		});
		await dispatchAlertNotifications(env, alertResult.notifications, ledgerBudget);
		for (const action of alertResult.automaticActions) {
			const workerScript = String(action.rollback.workerScript ?? "");
			if (workerScript) automaticQueue.set(workerScript, [...automaticQueue.get(workerScript) ?? [], action]);
			else if (action.kind === "pause_consumer") automaticCloudflareActions.push(action);
		}
		await persistWindowState(ledger, env.BROLLY_ACCOUNT_ID, "graphql:durable-objects", "active", durableActiveWindow, durableObjects, now, collectionEnd);
		await persistWindowState(ledger, env.BROLLY_ACCOUNT_ID, "graphql:durable-objects", "correction", durableCorrectionWindow, durableCorrections, now);
		await persistWindowState(ledger, env.BROLLY_ACCOUNT_ID, "graphql:workers", "active", workerActiveWindow, workers, now, collectionEnd);
		await persistWindowState(ledger, env.BROLLY_ACCOUNT_ID, "graphql:workers", "correction", workerCorrectionWindow, workerCorrections, now);
		await ledger.sealCompletedDays(env.BROLLY_ACCOUNT_ID, timeZone, now);
		if (billingDue) try {
			const billing = await ingestWindow({
				env,
				client,
				ledger,
				collector: "billing",
				budget: ledgerBudget,
				timeZone,
				startsAt: now - 26784e5,
				endsAt: now
			});
			const reconciledCycle = await ledger.currentBillingCycle(env.BROLLY_ACCOUNT_ID, now);
			const billingAlerts = await evaluateUsageAlerts(env, billing.changes, {
				timeZone,
				billingCycleId: reconciledCycle.id,
				billingCycleStart: reconciledCycle.startsAt,
				billingCycleEnd: reconciledCycle.endsAt,
				now,
				budget: ledgerBudget
			});
			await dispatchAlertNotifications(env, billingAlerts.notifications, ledgerBudget);
			for (const action of billingAlerts.automaticActions) {
				const workerScript = String(action.rollback.workerScript ?? "");
				if (workerScript) automaticQueue.set(workerScript, [...automaticQueue.get(workerScript) ?? [], action]);
				else if (action.kind === "pause_consumer") automaticCloudflareActions.push(action);
			}
			await store.saveCoverage([{
				family: "billing",
				metric: "authoritative_usage",
				finestScope: "account",
				state: billing.coverage[0]?.state ?? "unavailable",
				checkedAt: now,
				detail: billing.coverage[0]?.detail
			}]);
			await ledger.persistCollectorState(env.BROLLY_ACCOUNT_ID, "billing-reconciliation", "", {
				watermarkAt: now,
				nextEligibleAt: now + 36e5,
				status: billing.complete ? "complete" : "partial"
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			await store.saveCoverage([{
				family: "billing",
				metric: "authoritative_usage",
				finestScope: "account",
				state: "unavailable",
				checkedAt: now,
				detail
			}]);
			await ledger.persistCollectorState(env.BROLLY_ACCOUNT_ID, "billing-reconciliation", "", {
				nextEligibleAt: now + 3e5,
				status: "failed",
				error: detail
			});
		}
		if (retentionDue) {
			await runRetentionMaintenance(env.DB, env.BROLLY_ACCOUNT_ID, ledgerBudget, now, timeZone);
			await ledger.persistCollectorState(env.BROLLY_ACCOUNT_ID, "retention-maintenance", "", {
				watermarkAt: now,
				nextEligibleAt: now + 36e5,
				status: "complete"
			});
		}
		const objectCosts = /* @__PURE__ */ new Map();
		for (const sample of durableObjects.samples) if (sample.asset.scope === "object") {
			const current = objectCosts.get(sample.asset.id) ?? {
				asset: sample.asset,
				cost: 0
			};
			current.cost += sample.estimatedCostUsd ?? 0;
			objectCosts.set(sample.asset.id, current);
		}
		const projectedDailyCost = durableObjects.samples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0) * (864e5 / (collectionEnd - since));
		const projectedWorkersDailyCost = workers.samples.reduce((sum, sample) => sum + (sample.estimatedCostUsd ?? 0), 0) * (864e5 / (collectionEnd - since));
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
				end: collectionEnd,
				source: "graphql",
				estimatedCostUsd: projectedDailyCost
			},
			...[],
			{
				asset: workersSpendAsset,
				metric: "projected_daily_cost_usd",
				unit: "usd",
				value: projectedWorkersDailyCost,
				start: since,
				end: collectionEnd,
				source: "graphql",
				estimatedCostUsd: projectedWorkersDailyCost
			}
		]);
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
		await flushAutomaticCloudflareControls(store, env, automaticCloudflareActions);
		await flushAutomaticFuses(store, env, automaticQueue);
		while (ledgerBudget.remaining("backfillSlices") > 0 && ledgerBudget.remaining("wallMs") >= 8e3) {
			const backfill = await runOneBackfillSlice(env, client, ledger, ledgerBudget, timeZone);
			if (!backfill.worked) break;
			normalizedSamples += backfill.samples;
		}
		const localDay = new Intl.DateTimeFormat("en-CA", { timeZone: env.BROLLY_TIMEZONE ?? "UTC" }).format(new Date(now));
		if (isDailySummaryHour(env) && await store.claimDailySummary(localDay)) {
			const [billingCoverage, billedCost] = await Promise.all([env.DB.prepare(`SELECT state,detail FROM metric_coverage
           WHERE family='billing' AND metric='authoritative_usage' LIMIT 1`).first(), env.DB.prepare(`SELECT SUM(COALESCE(billed_cost,effective_cost,list_cost,0)) AS cost
           FROM billing_line_items WHERE account_id=?1 AND charge_period_start>=?2`).bind(env.BROLLY_ACCOUNT_ID, now - 1728e5).first()]);
			const billingState = billingCoverage?.state ?? "permission_denied";
			const billingDetail = billingCoverage?.detail ?? "Add Billing Read access in Brolly setup or configure CLOUDFLARE_BILLING_TOKEN for authoritative reconciliation";
			const authoritativeBilledCost = billedCost?.cost == null ? null : Number(billedCost.cost);
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
		await ledger.finishMonitorRun(runId, env.BROLLY_ACCOUNT_ID, localDayAt(now, timeZone), {
			startedAt,
			datasetsQueried: ledgerBudget.usage.graphqlQueries,
			rowsReturned: durableObjects.samples.length + durableCorrections.samples.length + workers.samples.length + workerCorrections.samples.length,
			samplesNormalized: normalizedSamples,
			continuation: runContinuation,
			complete: durableObjects.complete && durableCorrections.complete && workers.complete && workerCorrections.complete
		});
		runFinished = true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!runFinished) try {
			await ledger.finishMonitorRun(runId, env.BROLLY_ACCOUNT_ID, localDayAt(startedAt, timeZone), {
				startedAt,
				datasetsQueried: ledgerBudget.usage.graphqlQueries,
				rowsReturned: 0,
				samplesNormalized: normalizedSamples,
				continuation: runContinuation,
				errors: [message],
				complete: false
			});
		} catch (accountingError) {
			console.error("[Brolly] monitor accounting failed", accountingError);
		}
		if (error instanceof MonitoringBudgetExceededError || error instanceof LedgerBudgetExceededError) {
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
		await writeSentinelIncident(env.DB, env.BROLLY_ACCOUNT_ID, message);
	}
}
function collectorWindow(stored, fallbackStart, fallbackEnd) {
	if (stored && Number.isFinite(stored.startAt) && Number.isFinite(stored.endAt) && stored.startAt < stored.endAt) return stored;
	return {
		startAt: fallbackStart,
		endAt: fallbackEnd
	};
}
function windowContinuation(window, continuation, latestEnd) {
	if (continuation) return {
		startAt: window.startAt,
		endAt: window.endAt,
		cursor: continuation
	};
	if (latestEnd !== void 0 && window.endAt < latestEnd) return {
		startAt: window.endAt,
		endAt: Math.min(latestEnd, window.endAt + 3e5)
	};
	return null;
}
async function persistWindowState(ledger, accountId, collectorKey, partitionKey, window, result, now, latestEnd) {
	const continuation = windowContinuation(window, result.continuation, latestEnd);
	await ledger.persistCollectorState(accountId, collectorKey, partitionKey, {
		cursor: continuation ?? void 0,
		watermarkAt: result.watermarkAt,
		nextEligibleAt: now + (continuation ? 6e4 : 3e5),
		status: continuation || !result.complete ? "partial" : "complete"
	});
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
async function handleEvaluation(store, evaluation, dailySummary = false, env, automaticQueue) {
	const { incident, notify: shouldSend } = await store.recordEvaluation(evaluation);
	if (!shouldSend || !env) return;
	const levels = await loadAlertLevels(env.DB);
	const effective = resolveEffectiveEntries(levels, dailySummary || incident.severity === "emergency" ? levels.length - 1 : incident.severity === "critical" ? Math.max(0, levels.length - 2) : 0);
	const targets = await store.listNotificationTargets(effective.channels.map((channel) => channel.targetId));
	await Promise.allSettled(targets.slice(0, 10).map(async (row) => {
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
async function flushAutomaticCloudflareControls(store, env, queued) {
	const actions = [...new Map(queued.map((action) => [action.id, action])).values()].slice(0, 5);
	for (const action of actions) {
		if (action.kind !== "pause_consumer" || !await store.claimActionState(action.id, "prepared", "running")) continue;
		const current = await env.DB.prepare(`SELECT tier,excluded,auto_quarantine_policy FROM resources
       WHERE account_id=?1 AND product_family=?2 AND cloudflare_id=?3
       ORDER BY last_seen_at DESC LIMIT 1`).bind(action.asset.accountId, action.asset.family, action.asset.id).first();
		if (!current || Number(current.excluded) === 1 || current.auto_quarantine_policy === "deny" || [
			"control_plane",
			"critical",
			"unclassified"
		].includes(current.tier)) {
			await store.setActionState(action.id, "failed", "The resource protection policy changed before automatic control");
			await store.audit("brolly-policy", "action.pause.refused", action.id, {
				family: action.asset.family,
				assetId: action.asset.id
			});
			continue;
		}
		await store.audit("brolly-policy", "action.pause.start", action.id, {
			family: action.asset.family,
			assetId: action.asset.id
		});
		try {
			const rollback = await prepareCloudflareControl(env, action);
			action.rollback = rollback;
			await env.DB.prepare(`UPDATE actions SET rollback_json=?2,updated_at=?3 WHERE id=?1`).bind(action.id, JSON.stringify(rollback), Date.now()).run();
			await store.audit("brolly-policy", "action.rollback_snapshot", action.id, rollback);
			await executeCloudflareControl(env, action);
			await store.setActionState(action.id, "succeeded");
			await store.audit("brolly-policy", "action.pause.succeeded", action.id, {
				family: action.asset.family,
				assetId: action.asset.id
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await store.setActionState(action.id, "failed", message);
			await store.audit("brolly-policy", "action.pause.failed", action.id, { error: message });
		}
	}
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
	const [policyRow, incidentResult, coverageResult, assetFamilyResult, tierResult, spendResult, currentSpendResult, actionResult] = await Promise.all([
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
		env.DB.prepare(`SELECT product_family AS family,COUNT(*) AS asset_count,MAX(last_seen_at) AS last_seen
       FROM resources WHERE resource_type NOT IN ('account','product')
       GROUP BY product_family ORDER BY asset_count DESC,product_family`).all(),
		env.DB.prepare(`SELECT tier,COUNT(*) AS asset_count FROM resources WHERE resource_type NOT IN ('account','product') GROUP BY tier`).all(),
		env.DB.prepare(`SELECT r.product_family AS family,u.local_day,u.period_start_at,u.period_end_at,
         u.estimated_cost_usd,u.authoritative_allocated_cost_usd,u.completeness,u.revised_at
       FROM usage_daily u JOIN resources r ON r.id=u.resource_id
       WHERE r.resource_type='product' AND u.period_end_at>=?1
       ORDER BY u.period_start_at ASC LIMIT 2500`).bind(now - 26784e5).all(),
		env.DB.prepare(`SELECT product_family AS family,local_day,payload_json,updated_at
       FROM usage_accumulator_shards WHERE scope_type='product'
       ORDER BY local_day ASC,updated_at ASC LIMIT 1000`).all(),
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
	const spend = spendView(spendResult.results, currentSpendResult.results, coverage, now);
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
			version: policy.version,
			accountDailySpend: policy.accountDailySpend,
			familyDailySpend: policy.familyDailySpend ?? DEFAULT_FAMILY_DAILY_SPEND,
			assetDailySpend: policy.assetDailySpend ?? {},
			riskTolerance: policy.riskTolerance,
			limits: policy.limits
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
	const [completeRow, accountNameRow, policyRow, coverageResult, scopedAssetResult] = await Promise.all([
		env.DB.prepare(`SELECT value FROM settings WHERE key='onboarding_complete' LIMIT 1`).first(),
		env.DB.prepare(`SELECT value FROM settings WHERE key='account_name' LIMIT 1`).first(),
		env.DB.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first(),
		env.DB.prepare(`SELECT family,metric,state FROM metric_coverage`).all(),
		env.DB.prepare(`SELECT family,asset_id,name,scope,metadata_json FROM assets WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace') ORDER BY family,name,asset_id LIMIT 2500`).all()
	]);
	const policy = readPolicy(policyRow?.value);
	const coverage = coverageResult.results;
	return {
		accountId: env.BROLLY_ACCOUNT_ID,
		accountName: accountNameRow?.value ?? null,
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
function spendView(rows, currentRows, coverage, now) {
	const preferred = rows.map((row) => ({
		family: row.family,
		value: row.authoritative_allocated_cost_usd ?? row.estimated_cost_usd ?? 0,
		estimated: row.estimated_cost_usd ?? 0,
		authoritative: row.authoritative_allocated_cost_usd != null,
		start_at: row.period_start_at,
		end_at: row.period_end_at,
		updated_at: row.revised_at,
		quality: row.completeness
	}));
	for (const row of currentRows) {
		const productCost = accumulatorProductCost(String(row.payload_json ?? "{}"));
		if (!productCost) continue;
		preferred.push({
			family: row.family,
			value: productCost.estimatedUsd,
			estimated: productCost.estimatedUsd,
			authoritative: false,
			start_at: Number(row.updated_at) - 3e5,
			end_at: row.updated_at,
			updated_at: row.updated_at,
			quality: productCost.quality
		});
	}
	const latestByFamily = /* @__PURE__ */ new Map();
	for (const row of preferred) {
		const current = latestByFamily.get(String(row.family));
		if (!current || Number(row.end_at) > Number(current.end_at)) latestByFamily.set(String(row.family), row);
	}
	const categories = [...latestByFamily.entries()].map(([family, row]) => ({
		family,
		label: familyLabel(family),
		estimatedUsd: Number(row.value),
		updatedAt: Number(row.updated_at ?? row.end_at),
		coverage: row.quality === "complete" && coverage.some((item) => item.family === family && item.state === "healthy") ? "healthy" : String(row.quality ?? "partial"),
		authoritative: Boolean(row.authoritative)
	})).sort((a, b) => b.estimatedUsd - a.estimatedUsd);
	const bucketMap = /* @__PURE__ */ new Map();
	for (const row of preferred) {
		const bucket = Number(row.end_at);
		const family = String(row.family);
		const values = bucketMap.get(bucket) ?? /* @__PURE__ */ new Map();
		values.set(family, Number(row.value));
		bucketMap.set(bucket, values);
	}
	const history = [...bucketMap.entries()].sort((a, b) => a[0] - b[0]).slice(-31).map(([at, values]) => ({
		at,
		totalUsd: [...values.values()].reduce((sum, value) => sum + value, 0),
		categories: Object.fromEntries(values)
	}));
	const latestAt = categories.reduce((latest, item) => Math.max(latest, item.updatedAt), 0) || null;
	return {
		label: "Stored daily usage",
		estimatedTotalUsd: categories.reduce((sum, item) => sum + item.estimatedUsd, 0),
		categories,
		history,
		updatedAt: latestAt,
		authoritative: categories.length > 0 && categories.every((item) => item.authoritative),
		stale: latestAt === null || now - latestAt > 12e5,
		note: "Daily ledger values include data-quality state. Product totals use authoritative billing cost when reconciliation is available."
	};
}
function accumulatorProductCost(value) {
	try {
		const payload = JSON.parse(value);
		const resources = Object.values(payload.resources ?? {});
		if (!resources.length) return null;
		let estimatedUsd = 0;
		let quality = "complete";
		const rank = {
			complete: 0,
			sampled: 1,
			partial: 2,
			stale: 3,
			missing: 4
		};
		for (const resource of resources) for (const metric of Object.values(resource.metrics ?? {})) {
			estimatedUsd += Number(metric.estimatedDayUsd ?? 0);
			if ((rank[metric.quality ?? "missing"] ?? 4) > (rank[quality] ?? 0)) quality = metric.quality ?? "missing";
		}
		return {
			estimatedUsd,
			quality
		};
	} catch {
		return null;
	}
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
		email: "Email",
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
	const verified = verification.checks.apiAccess.state === "pass" && verification.checks.fuseSecret.state === "pass" && verification.checks.runtimeBundle.state === "pass" && verification.checks.activeDeployment.state === "pass";
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(`${VERIFICATION_PREFIX}${verification.workerScript}`, JSON.stringify(verification), verification.checkedAt),
		env.DB.prepare(`UPDATE resources SET
         runtime_fuse_status=?3,
         control_capability=CASE WHEN ?3='verified' THEN 'runtime_fuse' ELSE control_capability END,
         last_seen_at=MAX(last_seen_at,?4)
       WHERE account_id=?1 AND product_family='workers' AND cloudflare_id=?2`).bind(env.BROLLY_ACCOUNT_ID, verification.workerScript, verified ? "verified" : "unhealthy", verification.checkedAt),
		env.DB.prepare(`UPDATE resources SET
         runtime_fuse_status=?3,
         control_capability=CASE WHEN ?3='verified' THEN 'runtime_fuse' ELSE control_capability END,
         last_seen_at=MAX(last_seen_at,?4)
       WHERE account_id=?1 AND product_family='durable_objects'
         AND json_extract(metadata_json,'$.cloudflareWorkerScript')=?2
         AND json_extract(metadata_json,'$.brollyFuse')='true'`).bind(env.BROLLY_ACCOUNT_ID, verification.workerScript, verified ? "verified" : "unhealthy", verification.checkedAt)
	]);
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
var DAY_MS$1 = 864e5;
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
	if (env.CLOUDFLARE_BILLING_TOKEN) throw new Error("Billing access is managed by the CLOUDFLARE_BILLING_TOKEN Worker secret. Replace that secret in Cloudflare instead of saving a second token in Brolly.");
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
	}, budget).billingUsage(Date.now() - 2 * DAY_MS$1, Date.now()).catch((error) => {
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
async function billingAccessConfiguration(env) {
	if (env.CLOUDFLARE_BILLING_TOKEN) return {
		configured: true,
		source: "worker_secret",
		updatedAt: null
	};
	const row = await env.DB.prepare(`SELECT updated_at FROM settings WHERE key='billing_credentials' LIMIT 1`).first();
	return row ? {
		configured: true,
		source: "encrypted_database",
		updatedAt: row.updated_at
	} : {
		configured: false,
		source: "none",
		updatedAt: null
	};
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
		const windowStartAt = windowEndAt - DAY_MS$1;
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
			client.billingUsage(windowStartAt - DAY_MS$1, windowEndAt).then((records) => ({
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
		["containers", /\bcontainers?\b/],
		["browser_rendering", /browser rendering/],
		["workflows", /\bworkflows?\b/],
		["worker_builds", /worker builds?|build minutes?/],
		["analytics_engine", /analytics engine/],
		["log_explorer", /log explorer/],
		["zones", /zone analytics|bandwidth/],
		["email", /email routing|email service|email sent/],
		["workers", /\bworkers?\b/]
	].find(([, pattern]) => pattern.test(value))?.[0] ?? null;
}
//#endregion
//#region src/release.ts
var BROLLY_RELEASE = "6ca28d2366e440f18cdadb3e94e9ab0f3a784388";
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
//#region src/usage-series.ts
function scopeResourceId(accountId, scope) {
	if (scope === "account") return resourceId(accountId, "account", "account", accountId);
	const family = scope.match(/^family:([^:]+)$/);
	if (family) return resourceId(accountId, family[1], "product", family[1]);
	const asset = scope.match(/^asset:([^:]+):([^:]+):(.+)$/);
	if (asset) return resourceId(accountId, asset[1], `${asset[1]}:${asset[2]}`, asset[3]);
	return null;
}
async function usageSeriesResponse(db, accountId, url, now = Date.now()) {
	const scope = url.searchParams.get("scope") ?? "account";
	const id = scopeResourceId(accountId, scope);
	if (!id) return Response.json({ error: "scope must be account, family:<family>, or asset:<family>:<scope>:<id>" }, { status: 400 });
	const days = Math.min(400, Math.max(1, Number(url.searchParams.get("days") ?? 120)));
	const today = new Date(now).toISOString().slice(0, 10);
	const from = (/* @__PURE__ */ new Date(now - days * 864e5)).toISOString().slice(0, 10);
	const [resource, daily, shards, definitions, cycles] = await Promise.all([
		db.prepare(`SELECT id,product_family FROM resources WHERE id=?1 LIMIT 1`).bind(id).first(),
		db.prepare(`SELECT local_day,metrics_json,estimated_cost_usd,authoritative_allocated_cost_usd,sealed
       FROM usage_daily WHERE resource_id=?1 AND local_day>=?2 AND local_day<=?3 ORDER BY local_day ASC`).bind(id, from, today).all(),
		db.prepare(`SELECT local_day,payload_json FROM usage_accumulator_shards
       WHERE account_id=?1 AND local_day>=?2 AND local_day<=?3
         AND (json_extract(payload_json,'$.sealedAt') IS NULL OR updated_at>json_extract(payload_json,'$.sealedAt'))`).bind(accountId, from, today).all(),
		db.prepare(`SELECT id,metric_key,display_name,unit,billing_mapping FROM metric_definitions WHERE active=1`).all(),
		db.prepare(`SELECT starts_at,ends_at,approximate FROM billing_cycles WHERE account_id=?1 AND ends_at>=?2 ORDER BY starts_at ASC`).bind(accountId, now - (days + 31) * 864e5).all()
	]);
	const byDay = /* @__PURE__ */ new Map();
	for (const row of daily.results) byDay.set(row.local_day, {
		day: row.local_day,
		costUsd: Number(row.authoritative_allocated_cost_usd ?? row.estimated_cost_usd ?? 0),
		metrics: parseNumberMap(row.metrics_json),
		sealed: Number(row.sealed) === 1
	});
	for (const shard of shards.results) {
		const entry = accumulatorEntry(shard.payload_json, id);
		if (!entry) continue;
		const existing = byDay.get(shard.local_day);
		if (existing?.sealed) continue;
		const point = existing ?? {
			day: shard.local_day,
			costUsd: 0,
			metrics: {},
			sealed: false
		};
		for (const [metric, value] of Object.entries(entry)) {
			point.metrics[metric] = (point.metrics[metric] ?? 0) + value.day;
			point.costUsd += value.estimatedDayUsd;
		}
		byDay.set(shard.local_day, point);
	}
	const series = [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day));
	const present = new Set(series.flatMap((point) => Object.keys(point.metrics)));
	const metrics = Object.fromEntries(definitions.results.filter((definition) => present.has(definition.id)).map((definition) => [definition.id, {
		key: definition.metric_key,
		label: definition.display_name,
		unit: definition.unit,
		billable: Boolean(definition.billing_mapping)
	}]));
	const body = {
		scope,
		resourceId: id,
		found: Boolean(resource),
		today,
		metrics,
		series,
		cycles: cycles.results.map((cycle) => ({
			startsAt: cycle.starts_at,
			endsAt: cycle.ends_at,
			approximate: cycle.approximate === 1
		}))
	};
	return Response.json(body);
}
function parseNumberMap(value) {
	try {
		const parsed = JSON.parse(value);
		return Object.fromEntries(Object.entries(parsed ?? {}).filter(([, item]) => typeof item === "number" && Number.isFinite(item)));
	} catch {
		return {};
	}
}
function accumulatorEntry(payload, id) {
	try {
		const metrics = JSON.parse(payload).resources?.[id]?.metrics;
		if (!metrics) return null;
		return Object.fromEntries(Object.entries(metrics).map(([metric, item]) => [metric, {
			day: Number(item.day ?? 0),
			estimatedDayUsd: Number(item.estimatedDayUsd ?? 0)
		}]));
	} catch {
		return null;
	}
}
//#endregion
//#region src/ledger-api.ts
var MAX_PAGE = 500;
async function ledgerApiRoute(request, env, actor) {
	const url = new URL(request.url);
	if (url.pathname === "/api/usage" && request.method === "GET") return usageResponse(env.DB, url);
	if (url.pathname === "/api/usage-series" && request.method === "GET") return usageSeriesResponse(env.DB, env.BROLLY_ACCOUNT_ID, url);
	if (url.pathname === "/api/metric-definitions" && request.method === "GET") return metricDefinitionsResponse(env.DB, url);
	if (url.pathname === "/api/ledger/resources" && request.method === "GET") return resourcesResponse(env.DB, env.BROLLY_ACCOUNT_ID, url);
	if (url.pathname === "/api/coverage" && request.method === "GET") return coverageResponse(env.DB, env.BROLLY_ACCOUNT_ID);
	if (url.pathname === "/api/monitoring-cost" && request.method === "GET") return monitoringCostResponse(env.DB, env.BROLLY_ACCOUNT_ID);
	if (url.pathname === "/api/monitoring-limits" && request.method === "GET") return monitoringLimitsResponse(env.DB);
	if (url.pathname === "/api/monitoring-limits" && request.method === "PUT") return updateMonitoringLimits(request, env.DB, actor);
	if (url.pathname === "/api/retention" && request.method === "GET") return retentionResponse(env.DB, env.BROLLY_ACCOUNT_ID);
	if (url.pathname === "/api/backfill" && request.method === "GET") return backfillResponse(env.DB, env.BROLLY_ACCOUNT_ID);
	if (url.pathname === "/api/backfill" && request.method === "POST") return createBackfill(request, env.DB, env.BROLLY_ACCOUNT_ID, actor);
	if (url.pathname === "/api/alert-rules" && request.method === "GET") return rulesResponse(env.DB, env.BROLLY_ACCOUNT_ID);
	if (url.pathname === "/api/alert-rules" && request.method === "POST") return createRule(request, env.DB, env.BROLLY_ACCOUNT_ID, actor);
	if (url.pathname === "/api/alert-instances" && request.method === "GET") return instancesResponse(env.DB, env.BROLLY_ACCOUNT_ID, url);
	const ruleMatch = url.pathname.match(/^\/api\/alert-rules\/([^/]+)$/);
	if (ruleMatch && request.method === "PUT") return updateRule(request, env.DB, decodeURIComponent(ruleMatch[1]), env.BROLLY_ACCOUNT_ID, actor);
	if (ruleMatch && request.method === "DELETE") return deleteRule(env.DB, decodeURIComponent(ruleMatch[1]), env.BROLLY_ACCOUNT_ID, actor);
	const lineMatch = url.pathname.match(/^\/api\/alert-lines\/([^/]+)$/);
	if (lineMatch && request.method === "PUT") return updateLine(request, env.DB, decodeURIComponent(lineMatch[1]), actor);
	const acknowledgeMatch = url.pathname.match(/^\/api\/alerts\/([^/]+)\/acknowledge$/);
	if (acknowledgeMatch && request.method === "POST") return await acknowledgeAlertInstance(env.DB, decodeURIComponent(acknowledgeMatch[1]), actor) ? Response.json({ ok: true }) : Response.json({ error: "Open alert instance not found" }, { status: 404 });
	const protectionMatch = url.pathname.match(/^\/api\/ledger\/resources\/([^/]+)\/protection$/);
	if (protectionMatch && request.method === "PUT") return updateResourceProtection(request, env.DB, decodeURIComponent(protectionMatch[1]), actor);
	return null;
}
async function metricDefinitionsResponse(db, url) {
	const family = url.searchParams.get("family");
	const result = await db.prepare(`SELECT * FROM metric_definitions WHERE active=1 AND (?1 IS NULL OR product_family=?1)
     ORDER BY product_family,display_name`).bind(family).all();
	return Response.json({ metricDefinitions: result.results.map(mapMetricDefinition) });
}
async function usageResponse(db, url) {
	const resourceId = url.searchParams.get("resourceId");
	if (!resourceId) return Response.json({ error: "resourceId is required" }, { status: 400 });
	const metricId = url.searchParams.get("metricId");
	const from = validDay(url.searchParams.get("from")) ?? "0000-01-01";
	const to = validDay(url.searchParams.get("to")) ?? "9999-12-31";
	const [resource, daily, current, definitions, oldest] = await Promise.all([
		db.prepare(`SELECT * FROM resources WHERE id=?1 LIMIT 1`).bind(resourceId).first(),
		db.prepare(`SELECT local_day,period_start_at,period_end_at,metrics_json,estimated_cost_usd,
         authoritative_allocated_cost_usd,completeness,sampling_json,sealed,revision,revised_at
       FROM usage_daily WHERE resource_id=?1 AND local_day>=?2 AND local_day<=?3
       ORDER BY local_day ASC LIMIT 731`).bind(resourceId, from, to).all(),
		db.prepare(`SELECT local_day,payload_json,updated_at FROM usage_accumulator_shards
       WHERE product_family=(SELECT product_family FROM resources WHERE id=?1)
         AND local_day>=?2 AND local_day<=?3
         AND (json_extract(payload_json,'$.sealedAt') IS NULL
           OR updated_at>json_extract(payload_json,'$.sealedAt'))
       ORDER BY local_day ASC`).bind(resourceId, from, to).all(),
		db.prepare(`SELECT * FROM metric_definitions WHERE active=1 ORDER BY product_family,display_name`).all(),
		db.prepare(`SELECT MIN(u.local_day) AS oldest FROM usage_daily u JOIN resources r ON r.id=u.resource_id
       WHERE r.account_id=(SELECT account_id FROM resources WHERE id=?1)
         AND r.resource_type NOT IN ('account','product')
         AND r.resource_type NOT LIKE '%:namespace'`).bind(resourceId).first()
	]);
	if (!resource) return Response.json({ error: "Resource not found" }, { status: 404 });
	const pointsByDay = new Map(daily.results.map((row) => [String(row.local_day), usagePoint(row, metricId)]));
	const currentDays = /* @__PURE__ */ new Set();
	for (const shard of current.results) {
		const entry = accumulatorResource(shard.payload_json, resourceId);
		if (!entry) continue;
		const shardMetrics = filterMetrics(Object.fromEntries(Object.entries(entry.metrics).map(([id, metric]) => [id, metric.day])), metricId);
		const shardSampling = Object.fromEntries(Object.entries(entry.metrics).map(([id, metric]) => [id, metric.sampleInterval]));
		const shardQuality = worstAccumulatorQuality(entry.metrics);
		const existing = currentDays.has(shard.local_day) ? pointsByDay.get(shard.local_day) : void 0;
		pointsByDay.set(shard.local_day, {
			localDay: shard.local_day,
			metrics: mergeNumberObjects(existing?.metrics, shardMetrics),
			estimatedCostUsd: Number(existing?.estimatedCostUsd ?? 0) + Object.values(entry.metrics).reduce((total, metric) => total + metric.estimatedDayUsd, 0),
			authoritativeCostUsd: null,
			quality: existing ? worstUsageQuality(String(existing.quality), shardQuality) : shardQuality,
			sampling: mergeSampling(existing?.sampling, shardSampling),
			sealed: false,
			revision: 0,
			revisedAt: Math.max(Number(existing?.revisedAt ?? 0), shard.updated_at)
		});
		currentDays.add(shard.local_day);
	}
	const points = [...pointsByDay.values()];
	points.sort((left, right) => String(left.localDay).localeCompare(String(right.localDay)));
	return Response.json({
		resource: mapResource(resource),
		metricDefinitions: definitions.results.map(mapMetricDefinition),
		metricId,
		period: "day",
		points,
		oldestRetainedAt: oldest?.oldest ?? null,
		freshnessAt: points.reduce((latest, point) => Math.max(latest ?? 0, Number(point.revisedAt)), null)
	});
}
function mergeNumberObjects(left, right) {
	const output = { ...left && typeof left === "object" ? left : {} };
	for (const [key, value] of Object.entries(right)) output[key] = (output[key] ?? 0) + value;
	return output;
}
function mergeSampling(left, right) {
	const output = left && typeof left === "object" ? { ...left } : {};
	for (const [key, value] of Object.entries(right)) {
		const current = output[key];
		output[key] = current === null || value === null ? null : Math.max(current ?? 1, value);
	}
	return output;
}
function worstUsageQuality(left, right) {
	const rank = {
		complete: 0,
		sampled: 1,
		partial: 2,
		stale: 3,
		missing: 4
	};
	return (rank[left] ?? 4) >= (rank[right] ?? 4) ? left : right;
}
async function resourcesResponse(db, accountId, url) {
	const parent = url.searchParams.get("parent");
	const family = url.searchParams.get("family");
	const query = url.searchParams.get("q")?.trim().toLowerCase();
	const limit = Math.min(MAX_PAGE, Math.max(1, Number(url.searchParams.get("limit") ?? 250)));
	const cursor = parseResourceCursor(url.searchParams.get("cursor"));
	const [result, families] = await Promise.all([db.prepare(`SELECT r.*,
       (SELECT COUNT(*) FROM resources child WHERE child.parent_resource_id=r.id) AS child_count,
       (SELECT MAX(u.revised_at) FROM usage_daily u WHERE u.resource_id=r.id) AS usage_updated_at,
       (SELECT MIN(u.local_day) FROM usage_daily u WHERE u.resource_id=r.id) AS oldest_day,
       (SELECT COUNT(*) FROM alert_instances i WHERE i.target_resource_id=r.id AND i.status='open') AS open_alerts
     FROM resources r WHERE r.account_id=?1
       AND (?2 IS NULL OR r.parent_resource_id=?2)
       AND (?3 IS NULL OR r.product_family=?3)
       AND (?4 IS NULL OR lower(r.display_name) LIKE '%' || ?4 || '%' OR lower(r.cloudflare_id) LIKE '%' || ?4 || '%')
       AND (?5 IS NULL
         OR r.product_family>?5
         OR r.product_family=?5 AND r.resource_type>?6
         OR r.product_family=?5 AND r.resource_type=?6 AND r.display_name>?7
         OR r.product_family=?5 AND r.resource_type=?6 AND r.display_name=?7 AND r.id>?8)
     ORDER BY r.product_family,r.resource_type,r.display_name,r.id LIMIT ?9`).bind(accountId, parent, family, query, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, cursor?.[3] ?? null, limit + 1).all(), db.prepare(`SELECT DISTINCT product_family FROM resources WHERE account_id=?1 AND product_family!='account' ORDER BY product_family`).bind(accountId).all()]);
	const page = result.results.slice(0, limit);
	const last = page.at(-1);
	return Response.json({
		resources: page.map(mapResource),
		nextCursor: result.results.length > limit && last ? JSON.stringify([
			last.product_family,
			last.resource_type,
			last.display_name,
			last.id
		]) : null,
		families: families.results.map((row) => row.product_family),
		generatedAt: Date.now()
	});
}
function parseResourceCursor(value) {
	if (!value || value.length > 2e3) return null;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) && parsed.length === 4 && parsed.every((item) => typeof item === "string" && item.length <= 1e3) ? parsed : null;
	} catch {
		return null;
	}
}
async function coverageResponse(db, accountId) {
	const [capabilities, state] = await Promise.all([db.prepare(`SELECT * FROM collector_capabilities WHERE account_id=?1 ORDER BY collector_key,dataset`).bind(accountId).all(), db.prepare(`SELECT * FROM collector_state WHERE account_id=?1 ORDER BY collector_key,partition_key`).bind(accountId).all()]);
	return Response.json({
		generatedAt: Date.now(),
		capabilities: capabilities.results.map(mapCapability),
		collectors: state.results.map(mapCollectorState)
	});
}
async function monitoringCostResponse(db, accountId) {
	const [daily, runs, limits] = await Promise.all([
		db.prepare(`SELECT * FROM monitor_usage_daily WHERE account_id=?1 ORDER BY local_day DESC LIMIT 31`).bind(accountId).all(),
		db.prepare(`SELECT * FROM monitor_runs WHERE account_id=?1 ORDER BY started_at DESC LIMIT 100`).bind(accountId).all(),
		configuredLedgerRunLimits(db)
	]);
	return Response.json({
		generatedAt: Date.now(),
		daily: daily.results.map(camelRow),
		runs: runs.results.map(camelRow),
		limits,
		defaults: DEFAULT_LEDGER_RUN_LIMITS,
		hardMaximums: MAX_LEDGER_RUN_LIMITS
	});
}
async function monitoringLimitsResponse(db) {
	return Response.json({
		limits: await configuredLedgerRunLimits(db),
		defaults: DEFAULT_LEDGER_RUN_LIMITS,
		hardMaximums: MAX_LEDGER_RUN_LIMITS
	});
}
async function updateMonitoringLimits(request, db, actor) {
	const body = await request.json();
	const error = validateLedgerRunLimits(body);
	if (error) return Response.json({ error }, { status: 400 });
	const limits = await saveLedgerRunLimits(db, body);
	await audit$2(db, actor, "monitoring.limits.update", "ledger", limits);
	return Response.json({
		ok: true,
		limits
	});
}
async function retentionResponse(db, accountId) {
	const [oldest, counts, setting, backfill] = await Promise.all([
		db.prepare(`SELECT MIN(CASE WHEN r.resource_type NOT IN ('account','product') AND r.resource_type NOT LIKE '%:namespace' THEN u.local_day END) AS oldest_resource_day,
         MIN(CASE WHEN r.resource_type IN ('account','product') OR r.resource_type LIKE '%:namespace' THEN u.local_day END) AS oldest_aggregate_day
       FROM usage_daily u JOIN resources r ON r.id=u.resource_id WHERE r.account_id=?1`).bind(accountId).first(),
		db.prepare(`SELECT COUNT(*) AS daily_rows,SUM(length(metrics_json)+length(sampling_json)+160) AS projected_bytes
       FROM usage_daily WHERE resource_id IN (SELECT id FROM resources WHERE account_id=?1)`).bind(accountId).first(),
		db.prepare(`SELECT value FROM settings WHERE key='d1_capacity_bytes' LIMIT 1`).first(),
		db.prepare(`SELECT COUNT(*) AS pending FROM backfill_slices WHERE status IN ('pending','running')`).first()
	]);
	const capacityBytes = Number(setting?.value ?? 5e8);
	const projectedBytes = Number(counts?.projected_bytes ?? 0);
	return Response.json({
		generatedAt: Date.now(),
		oldestResourceDay: oldest?.oldest_resource_day ?? null,
		oldestAggregateDay: oldest?.oldest_aggregate_day ?? null,
		dailyRows: Number(counts?.daily_rows ?? 0),
		projectedBytes,
		capacityBytes,
		pressure: capacityBytes > 0 ? projectedBytes / capacityBytes : null,
		backfillPending: Number(backfill?.pending ?? 0),
		targetRetentionDays: 730
	});
}
async function backfillResponse(db, accountId) {
	const [jobs, slices] = await Promise.all([db.prepare(`SELECT * FROM backfill_jobs WHERE account_id=?1 ORDER BY created_at DESC LIMIT 20`).bind(accountId).all(), db.prepare(`SELECT s.* FROM backfill_slices s JOIN backfill_jobs j ON j.id=s.backfill_job_id
       WHERE j.account_id=?1 ORDER BY s.ends_at DESC LIMIT 500`).bind(accountId).all()]);
	return Response.json({
		jobs: jobs.results.map(camelRow),
		slices: slices.results.map(camelRow)
	});
}
async function createBackfill(request, db, accountId, actor) {
	const body = await request.json();
	const endsAt = finiteTimestamp(body.endsAt) ?? Date.now();
	const startsAt = finiteTimestamp(body.startsAt) ?? endsAt - 2592e6;
	if (startsAt >= endsAt || endsAt - startsAt > 7776e6) return Response.json({ error: "Backfill range must be between one day and 90 days" }, { status: 400 });
	const capabilities = await db.prepare(`SELECT DISTINCT collector_key FROM collector_capabilities WHERE account_id=?1 AND available=1 AND collector_key LIKE 'graphql:%' LIMIT 50`).bind(accountId).all();
	const collectors = capabilities.results.length ? capabilities.results.map((row) => row.collector_key) : ["graphql:durable-objects", "graphql:workers"];
	const id = crypto.randomUUID();
	const now = Date.now();
	const statements = [db.prepare(`INSERT INTO backfill_jobs(id,account_id,requested_start_at,requested_end_at,newest_first,status,created_at,updated_at)
       VALUES(?1,?2,?3,?4,1,'pending',?5,?5)`).bind(id, accountId, startsAt, endsAt, now)];
	for (let end = endsAt; end > startsAt; end -= 864e5) {
		const start = Math.max(startsAt, end - 864e5);
		for (const collector of collectors) statements.push(db.prepare(`INSERT INTO backfill_slices(
         id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,coverage_status,updated_at
       ) VALUES(?1,?2,?3,'',?4,?5,'pending','missing',?6)`).bind(crypto.randomUUID(), id, collector, start, end, now));
	}
	await runBatches(db, statements);
	await audit$2(db, actor, "backfill.create", id, {
		startsAt,
		endsAt,
		collectors
	});
	return Response.json({
		ok: true,
		id,
		slices: statements.length - 1
	}, { status: 201 });
}
async function rulesResponse(db, accountId) {
	const [rules, lines] = await Promise.all([db.prepare(`SELECT r.*,target.display_name AS target_display_name,target.resource_type AS target_resource_type
       FROM alert_rules r LEFT JOIN resources target ON target.id=r.target_resource_id
       WHERE r.account_id=?1 AND r.retired=0 ORDER BY r.created_at,r.id`).bind(accountId).all(), db.prepare(`SELECT l.* FROM alert_lines l JOIN alert_rules r ON r.id=l.alert_rule_id
       WHERE r.account_id=?1 AND r.retired=0 AND l.retired=0
       ORDER BY l.alert_rule_id,l.priority,l.created_at`).bind(accountId).all()]);
	const byRule = /* @__PURE__ */ new Map();
	for (const line of lines.results) byRule.set(String(line.alert_rule_id), [...byRule.get(String(line.alert_rule_id)) ?? [], mapLine(line)]);
	return Response.json({ rules: rules.results.map((row) => ({
		...mapRule(row),
		lines: byRule.get(String(row.id)) ?? []
	})) });
}
async function createRule(request, db, accountId, actor) {
	const body = await request.json();
	const error = await validateRule(db, accountId, body);
	if (error) return Response.json({ error }, { status: 400 });
	const id = body.id?.trim() || crypto.randomUUID();
	const now = Date.now();
	const levels = await loadAlertLevels(db);
	const lines = body.lines?.length ? body.lines : levels.map((level, index) => levelLine(level, levels.length, index + 1));
	const lineError = validateLines(lines, levels, true);
	if (lineError) return Response.json({ error: lineError }, { status: 400 });
	const statements = [ruleInsert(db, id, accountId, body, now)];
	for (const line of lines) statements.push(lineInsert(db, id, line, now));
	await runBatches(db, statements);
	await audit$2(db, actor, "alert_rule.create", id, {
		metricDefinitionId: body.metricDefinitionId,
		lines: lines.length
	});
	return Response.json({
		ok: true,
		id
	}, { status: 201 });
}
async function updateRule(request, db, id, accountId, actor) {
	const body = await request.json();
	const error = await validateRule(db, accountId, body);
	if (error) return Response.json({ error }, { status: 400 });
	const result = await db.prepare(`UPDATE alert_rules SET
       target_resource_id=?3,target_selector_json=?4,metric_definition_id=?5,measurement=?6,period=?7,
       notification_target_ids_json=?8,auto_quarantine=?9,auto_quarantine_contributors=?10,
       confirmation_window_ms=?11,enabled=?12,updated_at=?13
     WHERE id=?1 AND account_id=?2 AND retired=0`).bind(id, accountId, body.targetResourceId ?? null, body.targetSelector ? JSON.stringify(body.targetSelector) : null, body.metricDefinitionId, body.measurement, body.period, JSON.stringify(body.notificationTargetIds ?? []), body.autoQuarantine ? 1 : 0, body.autoQuarantineContributors ? 1 : 0, validConfirmation(body.confirmationWindowMs), body.enabled === false ? 0 : 1, Date.now()).run();
	if (Number(result.meta.changes ?? 0) !== 1) return Response.json({ error: "Alert rule not found" }, { status: 404 });
	await audit$2(db, actor, "alert_rule.update", id, body);
	return Response.json({ ok: true });
}
async function deleteRule(db, id, accountId, actor) {
	if (await db.prepare(`SELECT 1 AS present FROM alert_instances WHERE alert_rule_id=?1 AND status IN ('open','acknowledged') LIMIT 1`).bind(id).first()) return Response.json({ error: "Resolve or expire open alert instances before deleting this rule" }, { status: 409 });
	const history = await db.prepare(`SELECT 1 AS present FROM alert_instances WHERE alert_rule_id=?1 LIMIT 1`).bind(id).first();
	const now = Date.now();
	const results = history ? await db.batch([db.prepare(`UPDATE alert_lines SET enabled=0,retired=1,updated_at=?2 WHERE alert_rule_id=?1`).bind(id, now), db.prepare(`UPDATE alert_rules SET enabled=0,retired=1,updated_at=?3 WHERE id=?1 AND account_id=?2`).bind(id, accountId, now)]) : await db.batch([db.prepare(`DELETE FROM alert_lines WHERE alert_rule_id=?1`).bind(id), db.prepare(`DELETE FROM alert_rules WHERE id=?1 AND account_id=?2`).bind(id, accountId)]);
	if (Number(results[1]?.meta.changes ?? 0) !== 1) return Response.json({ error: "Alert rule not found" }, { status: 404 });
	await audit$2(db, actor, history ? "alert_rule.retire" : "alert_rule.delete", id, {});
	return Response.json({
		ok: true,
		retired: Boolean(history)
	});
}
async function updateLine(request, db, id, actor) {
	const line = await request.json();
	if (!Number.isFinite(line.thresholdValue) || Number(line.thresholdValue) < 0) return Response.json({ error: "Thresholds must be finite and nonnegative" }, { status: 400 });
	const result = await db.prepare(`UPDATE alert_lines SET threshold_value=?2,enabled=?3,updated_at=?4 WHERE id=?1 AND retired=0`).bind(id, line.thresholdValue, line.enabled === false ? 0 : 1, Date.now()).run();
	if (Number(result.meta.changes ?? 0) !== 1) return Response.json({ error: "Alert line not found" }, { status: 404 });
	await audit$2(db, actor, "alert_line.update", id, line);
	return Response.json({ ok: true });
}
async function instancesResponse(db, accountId, url) {
	const status = url.searchParams.get("status");
	const result = await db.prepare(`SELECT i.*,r.metric_definition_id,l.label,l.color,l.priority,target.display_name,target.product_family,target.cloudflare_id
     FROM alert_instances i JOIN alert_rules r ON r.id=i.alert_rule_id
     JOIN alert_lines l ON l.id=i.alert_line_id JOIN resources target ON target.id=i.target_resource_id
     WHERE r.account_id=?1 AND (?2 IS NULL OR i.status=?2)
     ORDER BY i.last_breached_at DESC LIMIT 500`).bind(accountId, status).all();
	return Response.json({ instances: result.results.map(camelRow) });
}
async function updateResourceProtection(request, db, id, actor) {
	const body = await request.json();
	if (body.policy !== void 0 && ![
		"inherit",
		"allow",
		"deny"
	].includes(body.policy)) return Response.json({ error: "Invalid automatic-quarantine policy" }, { status: 400 });
	if (body.tier !== void 0 && ![
		"control_plane",
		"critical",
		"standard",
		"disposable",
		"unclassified"
	].includes(body.tier)) return Response.json({ error: "Invalid resource tier" }, { status: 400 });
	const row = await db.prepare(`SELECT account_id,product_family,resource_type,cloudflare_id,excluded,tier
     FROM resources WHERE id=?1 LIMIT 1`).bind(id).first();
	if (!row) return Response.json({ error: "Resource not found" }, { status: 404 });
	if (row.tier === "control_plane" && body.tier !== void 0 && body.tier !== "control_plane") return Response.json({ error: "Brolly control-plane classification cannot be removed" }, { status: 409 });
	if ((row.excluded === 1 || row.tier === "control_plane") && (body.excluded === false || body.policy === "allow")) return Response.json({ error: "Brolly control-plane resources cannot be included in automatic control" }, { status: 409 });
	const statements = [db.prepare(`UPDATE resources SET auto_quarantine_policy=COALESCE(?2,auto_quarantine_policy),
         excluded=COALESCE(?3,excluded),tier=COALESCE(?4,tier) WHERE id=?1`).bind(id, body.policy ?? null, body.excluded === void 0 ? null : body.excluded ? 1 : 0, body.tier ?? null)];
	if (body.tier !== void 0 && isLegacyAssetResource(row.resource_type)) statements.push(db.prepare(`UPDATE assets SET tier=?4
       WHERE account_id=?1 AND family=?2 AND asset_id=?3`).bind(row.account_id, row.product_family, row.cloudflare_id, body.tier));
	await db.batch(statements);
	await audit$2(db, actor, "resource.protection.update", id, body);
	return Response.json({ ok: true });
}
function isLegacyAssetResource(resourceType) {
	return resourceType.endsWith(":resource") || resourceType.endsWith(":object") || resourceType.endsWith(":namespace");
}
async function validateRule(db, accountId, rule) {
	if (!rule.targetResourceId && !rule.targetSelector) return "Choose an exact resource or a target selector";
	if (rule.targetResourceId && rule.targetSelector) return "Choose one target form";
	if (!rule.metricDefinitionId) return "Choose an active metric definition";
	const metric = await db.prepare(`SELECT product_family FROM metric_definitions WHERE id=?1 AND active=1 LIMIT 1`).bind(rule.metricDefinitionId).first();
	if (!metric) return "Choose an active metric definition";
	if (!rule.measurement || ![
		"usage",
		"estimated_cost",
		"billed_cost"
	].includes(rule.measurement)) return "Choose a supported measurement";
	if (!rule.period || !["day", "billing_cycle"].includes(rule.period)) return "Choose a supported period";
	const target = rule.targetResourceId ? await db.prepare(`SELECT resource_type,product_family FROM resources WHERE id=?1 AND account_id=?2 LIMIT 1`).bind(rule.targetResourceId, accountId).first() : null;
	if (rule.targetResourceId && !target) return "Choose a resource from this account";
	if (target && target.resource_type !== "account" && target.product_family !== metric.product_family) return "Choose a metric from the target resource's product family";
	if (rule.targetSelector?.productFamily && rule.targetSelector.productFamily !== metric.product_family) return "Choose a metric from the selector's product family";
	if (rule.autoQuarantine && !rule.targetResourceId) return "Exact automatic quarantine requires an exact resource target";
	if (rule.autoQuarantine && target && !target.resource_type.endsWith(":object") && !target.resource_type.endsWith(":resource")) return "Exact automatic quarantine requires a Worker or Durable Object resource";
	if (rule.autoQuarantineContributors && !rule.targetResourceId) return "Contributor quarantine requires an aggregate resource target";
	if (rule.autoQuarantineContributors && rule.targetResourceId) {
		if (target?.resource_type.endsWith(":object") || target?.resource_type.endsWith(":resource")) return "Contributor quarantine applies to aggregate targets";
	}
	return null;
}
function validateLines(lines, levels, requireEveryLevel = false) {
	if (!lines.length) return "Add at least one threshold line";
	const levelIds = new Set(levels.map((level) => level.id));
	const seen = /* @__PURE__ */ new Set();
	for (const line of lines) {
		if (!line.levelId || !levelIds.has(line.levelId)) return "Each threshold must use a current alert level";
		if (seen.has(line.levelId)) return "Each alert level may appear once per rule";
		seen.add(line.levelId);
		if (!Number.isFinite(line.thresholdValue) || Number(line.thresholdValue) < 0) return "Thresholds must be finite and nonnegative";
	}
	if (requireEveryLevel && seen.size !== levels.length) return "Every current alert level needs a threshold";
	const ordered = levels.map((level) => lines.find((line) => line.levelId === level.id).thresholdValue);
	if (ordered.some((value, index) => index > 0 && value < ordered[index - 1])) return "Thresholds must increase with alert levels";
	return null;
}
function ruleInsert(db, id, accountId, body, now) {
	return db.prepare(`INSERT INTO alert_rules(
       id,account_id,target_resource_id,target_selector_json,metric_definition_id,measurement,period,
       notification_target_ids_json,auto_quarantine,auto_quarantine_contributors,
       confirmation_window_ms,enabled,created_at,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)`).bind(id, accountId, body.targetResourceId ?? null, body.targetSelector ? JSON.stringify(body.targetSelector) : null, body.metricDefinitionId, body.measurement, body.period, JSON.stringify(body.notificationTargetIds ?? []), body.autoQuarantine ? 1 : 0, body.autoQuarantineContributors ? 1 : 0, validConfirmation(body.confirmationWindowMs), body.enabled === false ? 0 : 1, now);
}
function lineInsert(db, ruleId, line, now) {
	return db.prepare(`INSERT INTO alert_lines(
       id,alert_rule_id,level_id,label,color,priority,threshold_value,action,repeat_interval_ms,enabled,created_at,updated_at
     ) VALUES(?1,?2,?3,?4,?5,?6,?7,'notify',NULL,?8,?9,?9)
     ON CONFLICT(alert_rule_id,level_id) DO UPDATE SET
       color=excluded.color,priority=excluded.priority,threshold_value=excluded.threshold_value,
       label=excluded.label,action='notify',repeat_interval_ms=NULL,
       enabled=excluded.enabled,retired=0,updated_at=excluded.updated_at`).bind(line.id?.trim() || crypto.randomUUID(), ruleId, line.levelId, line.label?.trim(), line.color, line.priority, line.thresholdValue, line.enabled === false ? 0 : 1, now);
}
function levelLine(level, count, thresholdValue) {
	const index = level.position;
	return {
		levelId: level.id,
		label: level.label,
		color: index === count - 1 ? "#ef4444" : index === count - 2 ? "#dc6b24" : "#f59e0b",
		priority: index * 10,
		thresholdValue,
		action: "notify",
		repeatIntervalMs: null,
		enabled: true
	};
}
async function audit$2(db, actor, action, target, detail) {
	await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
}
async function runBatches(db, statements) {
	for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
}
function validConfirmation(value) {
	return Number.isFinite(value) && Number(value) >= 6e4 ? Math.min(Number(value), 864e5) : 3e5;
}
function finiteTimestamp(value) {
	return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null;
}
function validDay(value) {
	return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
function mapResource(row) {
	return {
		id: row.id,
		accountId: row.account_id,
		parentResourceId: row.parent_resource_id,
		productFamily: row.product_family,
		resourceType: row.resource_type,
		cloudflareId: row.cloudflare_id,
		displayName: row.display_name,
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
		lastActiveAt: row.last_active_at,
		coverageStatus: row.coverage_status,
		controlCapability: row.control_capability,
		runtimeFuseStatus: row.runtime_fuse_status,
		autoQuarantinePolicy: row.auto_quarantine_policy,
		tier: row.tier,
		excluded: Number(row.excluded) === 1,
		metadata: parseObject(String(row.metadata_json ?? "{}")),
		childCount: Number(row.child_count ?? 0),
		usageUpdatedAt: row.usage_updated_at ?? null,
		oldestDay: row.oldest_day ?? null,
		openAlerts: Number(row.open_alerts ?? 0)
	};
}
function mapMetricDefinition(row) {
	return {
		id: row.id,
		productFamily: row.product_family,
		metricKey: row.metric_key,
		displayName: row.display_name,
		unit: row.unit,
		aggregationKind: row.aggregation_kind,
		billingMapping: row.billing_mapping,
		collectorKey: row.collector_key,
		finestScope: row.finest_scope,
		pricingVersionId: row.pricing_version_id,
		active: Number(row.active) === 1
	};
}
function mapCapability(row) {
	return {
		accountId: row.account_id,
		collectorKey: row.collector_key,
		dataset: row.dataset,
		available: Number(row.available) === 1,
		retentionDays: row.retention_days,
		samplingBehavior: row.sampling_behavior,
		finestScope: row.finest_scope,
		lastVerifiedAt: row.last_verified_at,
		errorCode: row.error_code,
		humanExplanation: row.human_explanation,
		state: row.state,
		watermarkAt: row.watermark_at
	};
}
function mapCollectorState(row) {
	return {
		accountId: row.account_id,
		collectorKey: row.collector_key,
		partitionKey: row.partition_key,
		cursor: row.cursor_json ? parseObject(String(row.cursor_json)) : null,
		highWatermarkAt: row.high_watermark_at,
		retryCount: row.retry_count,
		nextEligibleAt: row.next_eligible_at,
		lastStartedAt: row.last_started_at,
		lastCompletedAt: row.last_completed_at,
		lastError: row.last_error,
		status: row.last_status
	};
}
function mapRule(row) {
	return {
		id: row.id,
		accountId: row.account_id,
		targetResourceId: row.target_resource_id,
		targetDisplayName: row.target_display_name ?? null,
		targetResourceType: row.target_resource_type ?? null,
		targetSelector: row.target_selector_json ? parseObject(String(row.target_selector_json)) : null,
		metricDefinitionId: row.metric_definition_id,
		measurement: row.measurement,
		period: row.period,
		notificationTargetIds: parseArray(String(row.notification_target_ids_json ?? "[]")),
		autoQuarantine: Number(row.auto_quarantine) === 1,
		autoQuarantineContributors: Number(row.auto_quarantine_contributors) === 1,
		confirmationWindowMs: row.confirmation_window_ms,
		enabled: Number(row.enabled) === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}
function mapLine(row) {
	return {
		id: row.id,
		alertRuleId: row.alert_rule_id,
		levelId: row.level_id,
		label: row.label,
		color: row.color,
		priority: row.priority,
		thresholdValue: row.threshold_value,
		action: row.action,
		repeatIntervalMs: row.repeat_interval_ms,
		enabled: Number(row.enabled) === 1
	};
}
function usagePoint(row, metricId) {
	return {
		localDay: row.local_day,
		periodStartAt: row.period_start_at,
		periodEndAt: row.period_end_at,
		metrics: filterMetrics(parseNumberObject(String(row.metrics_json)), metricId),
		estimatedCostUsd: row.estimated_cost_usd,
		authoritativeCostUsd: row.authoritative_allocated_cost_usd,
		quality: row.completeness,
		sampling: parseObject(String(row.sampling_json)),
		sealed: Number(row.sealed) === 1,
		revision: row.revision,
		revisedAt: row.revised_at
	};
}
function accumulatorResource(value, resourceId) {
	try {
		return JSON.parse(value).resources?.[resourceId] ?? null;
	} catch {
		return null;
	}
}
function worstAccumulatorQuality(metrics) {
	const rank = {
		complete: 0,
		sampled: 1,
		partial: 2,
		stale: 3,
		missing: 4
	};
	return Object.values(metrics).reduce((worst, metric) => (rank[metric.quality] ?? 4) > (rank[worst] ?? 0) ? metric.quality : worst, "complete");
}
function filterMetrics(metrics, metricId) {
	if (!metricId) return metrics;
	return metrics[metricId] === void 0 ? {} : { [metricId]: metrics[metricId] };
}
function parseObject(value) {
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}
function parseNumberObject(value) {
	const parsed = parseObject(value);
	return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === "number"));
}
function parseArray(value) {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
function camelRow(row) {
	return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), jsonValue(value)]));
}
function jsonValue(value) {
	if (typeof value !== "string" || !/^[\[{]/.test(value)) return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}
//#endregion
//#region src/initial-ingestion.ts
var DAY_MS = 864e5;
var NINETY_DAYS_MS = 90 * DAY_MS;
var USAGE_SLICE_MS = DAY_MS;
/** Cloudflare's Billing Usage API accepts at most a 31-day query window. */
var BILLING_MAX_SLICE_MS = 31 * DAY_MS;
var INITIAL_USAGE_COLLECTORS = [
	{
		collector: "graphql:durable-objects",
		label: "Durable Objects",
		dataset: "durable-object-usage",
		retentionDays: 90
	},
	{
		collector: "graphql:workers",
		label: "Workers",
		dataset: "workersInvocationsAdaptive",
		retentionDays: 90
	},
	...PRODUCT_USAGE_DEFINITIONS.map((item) => ({
		collector: item.collector,
		label: item.label,
		dataset: item.datasets.map((dataset) => dataset.dataset).join("+"),
		retentionDays: item.retentionDays
	}))
];
var INITIAL_BILLING_COLLECTOR = {
	collector: "billing",
	label: "Billing",
	dataset: "billable-usage"
};
/** Return whether a Billing Read credential is available without making a network request. */
async function billingIngestionAvailable(env) {
	try {
		return Boolean(await configuredBillingToken(env));
	} catch {
		return false;
	}
}
/**
* Create the single initial job and its fixed 90-day slices.  The partial
* unique index in migration 0004 makes this safe when two onboarding tabs race.
*/
async function ensureInitialIngestionJob(db, accountId, options = {}) {
	const now = options.now ?? Date.now();
	const existing = await db.prepare(`SELECT id,status,updated_at FROM backfill_jobs
     WHERE account_id=?1 AND kind='initial' LIMIT 1`).bind(accountId).first();
	if (existing) {
		const count = await db.prepare(`SELECT COUNT(*) AS count FROM backfill_slices WHERE backfill_job_id=?1`).bind(existing.id).first();
		return {
			id: existing.id,
			created: false,
			status: existing.status,
			slices: Number(count?.count ?? 0)
		};
	}
	const startsAt = now - NINETY_DAYS_MS;
	const jobId = crypto.randomUUID();
	const slices = initialIngestionSlicePlan(now, options.billingAvailable === true);
	const statements = [db.prepare(`INSERT INTO backfill_jobs(
       id,account_id,kind,requested_start_at,requested_end_at,newest_first,status,created_at,updated_at
     ) VALUES(?1,?2,'initial',?3,?4,1,'pending',?5,?5)`).bind(jobId, accountId, startsAt, now, now)];
	for (const slice of slices) statements.push(db.prepare(`INSERT INTO backfill_slices(
         id,backfill_job_id,collector_key,scope_key,starts_at,ends_at,status,
         retry_count,next_eligible_at,coverage_status,updated_at
       ) VALUES(?1,?2,?3,'',?4,?5,'pending',0,?6,'missing',?7)`).bind(crypto.randomUUID(), jobId, slice.collector, slice.startsAt, slice.endsAt, now, now));
	try {
		for (let offset = 0; offset < statements.length; offset += 100) await db.batch(statements.slice(offset, offset + 100));
	} catch (error) {
		const raced = await db.prepare(`SELECT id,status,updated_at FROM backfill_jobs
       WHERE account_id=?1 AND kind='initial' LIMIT 1`).bind(accountId).first();
		if (!raced) throw error;
		const count = await db.prepare(`SELECT COUNT(*) AS count FROM backfill_slices WHERE backfill_job_id=?1`).bind(raced.id).first();
		return {
			id: raced.id,
			created: false,
			status: raced.status,
			slices: Number(count?.count ?? 0)
		};
	}
	return {
		id: jobId,
		created: true,
		status: "pending",
		slices: slices.length
	};
}
/** Return the immutable newest-first import plan for a given request time. */
function initialIngestionSlicePlan(now, billingAvailable) {
	const startsAt = now - NINETY_DAYS_MS;
	const slices = [];
	for (const collector of INITIAL_USAGE_COLLECTORS) {
		const availableStartsAt = Math.max(startsAt, now - collector.retentionDays * DAY_MS);
		for (let end = now; end > availableStartsAt;) {
			const start = Math.max(availableStartsAt, end - USAGE_SLICE_MS);
			slices.push({
				collector: collector.collector,
				startsAt: start,
				endsAt: end
			});
			end = start;
		}
	}
	if (billingAvailable) for (let end = now; end > startsAt;) {
		const start = Math.max(startsAt, end - BILLING_MAX_SLICE_MS);
		slices.push({
			collector: INITIAL_BILLING_COLLECTOR.collector,
			startsAt: start,
			endsAt: end
		});
		end = start;
	}
	return slices;
}
/** Build the progress response directly from backfill_slices counts. */
async function initialIngestionProgress(db, accountId) {
	const [job, rows] = await Promise.all([db.prepare(`SELECT id,status,created_at,updated_at FROM backfill_jobs
       WHERE account_id=?1 AND kind='initial' LIMIT 1`).bind(accountId).first(), db.prepare(`SELECT s.collector_key,
         COUNT(*) AS total,
         SUM(CASE WHEN s.status='complete' THEN 1 ELSE 0 END) AS complete,
         SUM(CASE WHEN s.status='failed' OR (s.status='complete' AND s.coverage_status!='complete') THEN 1 ELSE 0 END) AS failed,
         MIN(CASE WHEN s.status='complete' THEN s.starts_at END) AS oldest_complete_at
       FROM backfill_slices s JOIN backfill_jobs j ON j.id=s.backfill_job_id
       WHERE j.account_id=?1 AND j.kind='initial'
       GROUP BY s.collector_key ORDER BY s.collector_key`).bind(accountId).all()]);
	return {
		job: job ? {
			id: job.id,
			status: job.status,
			startedAt: job.created_at,
			updatedAt: job.updated_at
		} : null,
		collectors: rows.results.map((row) => ({
			collector: row.collector_key,
			label: collectorLabel(row.collector_key),
			total: Number(row.total ?? 0),
			complete: Number(row.complete ?? 0),
			failed: Number(row.failed ?? 0),
			oldestCompleteAt: row.oldest_complete_at == null ? null : Number(row.oldest_complete_at)
		}))
	};
}
/**
* Drain eligible slices for one initial job.  A fresh budget belongs to this
* invocation and is never shared with the recurring monitor.
*/
async function runInitialIngestion(env, jobId, now = Date.now()) {
	const ledgerBudget = new LedgerRunBudget(INITIAL_INGESTION_LIMITS);
	const budget = new RunBudget({
		apiCalls: INITIAL_INGESTION_LIMITS.graphqlQueries + INITIAL_INGESTION_LIMITS.restRequests,
		databaseRows: INITIAL_INGESTION_LIMITS.d1RowsRead + INITIAL_INGESTION_LIMITS.d1RowsWritten,
		samples: 1e5,
		wallMs: INITIAL_INGESTION_LIMITS.wallMs
	});
	const client = new CloudflareClient(env, budget, ledgerBudget);
	const ledger = new LedgerStore(env.DB, ledgerBudget);
	const timeZone = env.BROLLY_TIMEZONE ?? "UTC";
	while (true) {
		if (ledgerBudget.remaining("wallMs") < 8e3 || budget.remaining("wallMs") < 8e3) break;
		if (!(await runOneBackfillSlice(env, client, ledger, ledgerBudget, timeZone, {
			jobId,
			kind: "initial"
		})).worked) break;
	}
}
function collectorLabel(collector) {
	if (collector === INITIAL_BILLING_COLLECTOR.collector) return INITIAL_BILLING_COLLECTOR.label;
	return INITIAL_USAGE_COLLECTORS.find((item) => item.collector === collector)?.label ?? collector;
}
//#endregion
//#region src/notification-api.ts
var PROVIDER_KINDS = [
	"twilio",
	"cloudflare_email",
	"resend",
	"postmark"
];
var TARGET_KINDS = [
	"cloudflare_email",
	"discord",
	"postmark",
	"resend",
	"slack",
	"twilio",
	"webhook"
];
var EMAIL_KINDS = [
	"cloudflare_email",
	"postmark",
	"resend"
];
var MAX_EMAIL_RECIPIENTS = 50;
async function notificationApiRoute(request, env, actor, fetcher = fetch) {
	const url = new URL(request.url);
	if (url.pathname === "/api/providers" && request.method === "GET") return Response.json({ providers: await listProviders(env) }, { headers: { "cache-control": "no-store" } });
	const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
	if (providerMatch && (request.method === "PATCH" || request.method === "DELETE")) {
		const kind = decodeURIComponent(providerMatch[1]);
		if (!isProviderKind(kind)) return Response.json({ error: "Unknown notification account kind" }, { status: 404 });
		if (request.method === "DELETE") return removeProvider(env, actor, kind);
		const body = await request.json();
		return replaceProvider(env, actor, kind, body.config && typeof body.config === "object" ? body.config : body, fetcher);
	}
	if (url.pathname === "/api/targets" && request.method === "GET") {
		const result = await env.DB.prepare(`SELECT t.id,t.kind,t.label,t.enabled,t.provider_id,t.created_at,t.updated_at,
         (SELECT created_at FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_delivery_at,
         (SELECT ok FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_delivery_ok,
         (SELECT error FROM notification_deliveries d WHERE d.target_id=t.id ORDER BY created_at DESC LIMIT 1) AS last_delivery_error
       FROM notification_targets t ORDER BY lower(t.label),t.created_at`).all();
		return Response.json({
			credentialStorageReady: Boolean(env.BROLLY_CREDENTIAL_KEY),
			targets: result.results.map((row) => ({
				id: String(row.id),
				kind: String(row.kind),
				label: String(row.label),
				enabled: Number(row.enabled) === 1,
				providerId: row.provider_id == null ? null : String(row.provider_id),
				createdAt: Number(row.created_at),
				updatedAt: Number(row.updated_at),
				lastDeliveryAt: row.last_delivery_at == null ? null : Number(row.last_delivery_at),
				lastDeliveryOk: row.last_delivery_ok == null ? null : Number(row.last_delivery_ok) === 1,
				lastDeliveryError: row.last_delivery_error == null ? null : String(row.last_delivery_error)
			}))
		}, { headers: { "cache-control": "no-store" } });
	}
	if (url.pathname === "/api/targets" && request.method === "POST") return saveTarget(request, env, actor, fetcher);
	const targetMatch = url.pathname.match(/^\/api\/targets\/([^/]+)$/);
	if (targetMatch && request.method === "PATCH") {
		const id = decodeURIComponent(targetMatch[1]);
		const body = await request.json();
		if (body.label === void 0) return Response.json({ error: "No channel change supplied" }, { status: 400 });
		const label = normalizeTargetLabel(body.label);
		if (typeof label !== "string") return Response.json({ error: labelError(label) }, { status: 400 });
		if (await duplicateTargetLabel(env.DB, label, id)) return Response.json({ error: "Another alert channel uses this label" }, { status: 400 });
		const result = await env.DB.prepare(`UPDATE notification_targets SET label=?2,updated_at=?3 WHERE id=?1`).bind(id, label, Date.now()).run();
		if (Number(result.meta.changes ?? 0) === 0) return Response.json({ error: "Notification target not found" }, { status: 404 });
		await audit$1(env.DB, actor, "notification_target.update", id, { label });
		return Response.json({
			ok: true,
			id
		});
	}
	if (targetMatch && request.method === "DELETE") {
		const id = decodeURIComponent(targetMatch[1]);
		const result = await env.DB.prepare(`DELETE FROM notification_targets WHERE id=?1`).bind(id).run();
		if (Number(result.meta.changes ?? 0) === 0) return Response.json({ error: "Notification target not found" }, { status: 404 });
		await audit$1(env.DB, actor, "notification_target.delete", id, {});
		return Response.json({
			ok: true,
			id
		});
	}
	return null;
}
async function saveTarget(request, env, actor, fetcher) {
	const body = await request.json();
	if (!TARGET_KINDS.includes(body.kind)) return Response.json({ error: "Invalid notification target kind" }, { status: 400 });
	const label = normalizeTargetLabel(body.label);
	if (typeof label !== "string") return Response.json({ error: labelError(label) }, { status: 400 });
	if (!env.BROLLY_CREDENTIAL_KEY) return Response.json({ error: "BROLLY_CREDENTIAL_KEY is required; target credentials will never be stored in plaintext" }, { status: 503 });
	const id = body.id ?? crypto.randomUUID();
	if (await duplicateTargetLabel(env.DB, label, id)) return Response.json({ error: "Another alert channel uses this label" }, { status: 400 });
	let providerId = null;
	let config;
	const now = Date.now();
	if (isProviderKind(body.kind)) {
		const destination = { to: normalizeDestination(body.kind, body.destination?.to) };
		let providerConfig;
		if (body.provider) {
			providerConfig = body.provider.config ?? {};
			const providerError = validateProviderConfig(body.kind, providerConfig, env.BROLLY_ACCOUNT_ID);
			if (providerError) return Response.json({ error: providerError }, { status: 400 });
			const mergedError = validateNotificationConfig(body.kind, {
				...providerConfig,
				...destination
			});
			if (mergedError) return Response.json({ error: mergedError }, { status: 400 });
			if (body.kind === "cloudflare_email") try {
				await verifyCloudflareEmailToken(String(providerConfig.token), fetcher);
			} catch (error) {
				return Response.json({ error: errorMessage(error) }, { status: 400 });
			}
			const replacement = await replaceProvider(env, actor, body.kind, providerConfig, fetcher, true);
			if (!replacement.ok) return replacement;
			providerId = providerIdFor(body.kind);
		} else {
			const row = await env.DB.prepare(`SELECT id,config_json FROM notification_providers WHERE kind=?1 LIMIT 1`).bind(body.kind).first();
			if (!row) return Response.json({ error: providerRequiredMessage(body.kind) }, { status: 400 });
			providerId = row.id;
			providerConfig = await openJson(row.config_json, env.BROLLY_CREDENTIAL_KEY);
		}
		config = {
			...providerConfig,
			...destination
		};
	} else config = body.config ?? {};
	const configError = validateNotificationConfig(body.kind, config);
	if (configError) return Response.json({ error: configError }, { status: 400 });
	await env.DB.prepare(`INSERT INTO notification_targets(id,kind,label,config_json,enabled,provider_id,created_at,updated_at)
     VALUES(?1,?2,?3,?4,1,?5,?6,?6)
     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,label=excluded.label,config_json=excluded.config_json,
       enabled=1,provider_id=excluded.provider_id,updated_at=excluded.updated_at`).bind(id, body.kind, label, await sealJson(config, env.BROLLY_CREDENTIAL_KEY), providerId, now).run();
	await audit$1(env.DB, actor, "notification_target.upsert", id, {
		kind: body.kind,
		label,
		providerId
	});
	return Response.json({
		ok: true,
		id
	});
}
async function listProviders(env) {
	if (!env.BROLLY_CREDENTIAL_KEY) return [];
	const result = await env.DB.prepare(`SELECT id,kind,config_json,updated_at FROM notification_providers ORDER BY kind`).all();
	return Promise.all(result.results.map(async (row) => {
		const config = await openJson(row.config_json, env.BROLLY_CREDENTIAL_KEY);
		return {
			kind: row.kind,
			from: String(config.from ?? ""),
			updatedAt: Number(row.updated_at)
		};
	}));
}
async function replaceProvider(env, actor, kind, config, fetcher, verified = false) {
	if (!env.BROLLY_CREDENTIAL_KEY) return Response.json({ error: "Credential encryption is not configured" }, { status: 503 });
	const providerError = verified ? null : validateProviderConfig(kind, config, env.BROLLY_ACCOUNT_ID);
	if (providerError) return Response.json({ error: providerError }, { status: 400 });
	if (!verified && kind === "cloudflare_email") try {
		await verifyCloudflareEmailToken(String(config.token), fetcher);
	} catch (error) {
		return Response.json({ error: errorMessage(error) }, { status: 400 });
	}
	const providerId = (await env.DB.prepare(`SELECT id FROM notification_providers WHERE kind=?1 LIMIT 1`).bind(kind).first())?.id ?? providerIdFor(kind);
	const targets = await env.DB.prepare(`SELECT id,config_json FROM notification_targets WHERE provider_id=?1 ORDER BY id`).bind(providerId).all();
	const now = Date.now();
	const statements = [env.DB.prepare(`INSERT INTO notification_providers(id,kind,config_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)
     ON CONFLICT(kind) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at`).bind(providerId, kind, await sealJson(config, env.BROLLY_CREDENTIAL_KEY), now)];
	for (const target of targets.results) {
		const current = await openJson(target.config_json, env.BROLLY_CREDENTIAL_KEY);
		const merged = {
			...config,
			to: current.to
		};
		const error = validateNotificationConfig(kind, merged);
		if (error) return Response.json({ error }, { status: 400 });
		statements.push(env.DB.prepare(`UPDATE notification_targets SET config_json=?2,updated_at=?3 WHERE id=?1`).bind(target.id, await sealJson(merged, env.BROLLY_CREDENTIAL_KEY), now));
	}
	await env.DB.batch(statements);
	await audit$1(env.DB, actor, "notification_provider.update", kind, { channels: targets.results.length });
	return Response.json({
		ok: true,
		kind,
		channels: targets.results.length
	});
}
async function removeProvider(env, actor, kind) {
	const row = await env.DB.prepare(`SELECT id FROM notification_providers WHERE kind=?1 LIMIT 1`).bind(kind).first();
	if (!row) return Response.json({ error: "Notification account not found" }, { status: 404 });
	const used = await env.DB.prepare(`SELECT COUNT(*) AS count FROM notification_targets WHERE provider_id=?1`).bind(row.id).first();
	if (Number(used?.count ?? 0) > 0) return Response.json({ error: "Remove this account's alert channels before removing the account" }, { status: 409 });
	await env.DB.prepare(`DELETE FROM notification_providers WHERE id=?1`).bind(row.id).run();
	await audit$1(env.DB, actor, "notification_provider.delete", kind, {});
	return Response.json({
		ok: true,
		kind
	});
}
function validateProviderConfig(kind, config, accountId) {
	if (!config || typeof config !== "object") return "Account details are required";
	const present = (key) => typeof config[key] === "string" && String(config[key]).trim().length > 0;
	if (kind === "twilio" && ![
		"accountSid",
		"token",
		"from"
	].every(present)) return "Twilio account SID, auth token, and from number are required";
	if ((kind === "resend" || kind === "postmark") && !["token", "from"].every(present)) return `${displayKind(kind)} API token and from address are required`;
	if (kind === "cloudflare_email" && ![
		"accountId",
		"token",
		"from"
	].every(present)) return "Cloudflare account, API token, and from address are required";
	if (kind === "cloudflare_email" && accountId && String(config.accountId) !== accountId) return "Cloudflare Email must use the connected account";
	if (!isProviderKind(kind)) return "This channel does not use a saved account";
	return null;
}
function validateNotificationConfig(kind, config) {
	if (!config || typeof config !== "object") return "Notification configuration is required";
	const present = (key) => typeof config[key] === "string" && String(config[key]).trim().length > 0;
	if ((kind === "discord" || kind === "slack" || kind === "webhook") && !present("url")) return `${kind} webhook URL is required`;
	if (kind === "discord" || kind === "slack" || kind === "webhook") try {
		notificationWebhookUrl(kind, String(config.url));
	} catch (error) {
		return errorMessage(error);
	}
	if (kind === "twilio" && ![
		"accountSid",
		"token",
		"from",
		"to"
	].every(present)) return "Twilio account SID, auth token, from number, and destination number are required";
	if (isEmailKind(kind)) {
		if (!validEmailRecipients(config.to)) return `Email channels require between 1 and ${MAX_EMAIL_RECIPIENTS} recipient addresses`;
		if ((kind === "resend" || kind === "postmark") && !["token", "from"].every(present)) return `${displayKind(kind)} API token and from address are required`;
		if (kind === "cloudflare_email" && ![
			"accountId",
			"token",
			"from"
		].every(present)) return "Cloudflare account, API token, and from address are required";
	}
	return null;
}
function isEmailKind(kind) {
	return EMAIL_KINDS.includes(kind);
}
function normalizeDestination(kind, value) {
	if (!isEmailKind(kind)) return typeof value === "string" ? value.trim() : value;
	const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	const seen = /* @__PURE__ */ new Set();
	return source.map((recipient) => recipient.trim()).filter((recipient) => {
		const key = recipient.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
function validEmailRecipients(value) {
	const recipients = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return recipients.length >= 1 && recipients.length <= MAX_EMAIL_RECIPIENTS && recipients.every((recipient) => typeof recipient === "string" && recipient.trim().length > 0);
}
async function verifyCloudflareEmailToken(token, fetcher = fetch) {
	const response = await fetcher("https://api.cloudflare.com/client/v4/user/tokens/verify", {
		headers: { authorization: `Bearer ${token}` },
		redirect: "error",
		signal: AbortSignal.timeout(8e3)
	});
	if (!response.ok) throw new Error(`Cloudflare rejected this API token (${response.status})`);
	const payload = await response.json();
	if (!payload.success) throw new Error(payload.errors?.map((error) => error.message).filter(Boolean).join("; ") || "Cloudflare rejected this API token");
	if (payload.result?.status !== "active") throw new Error("Cloudflare reports that this API token is inactive");
}
function isProviderKind(kind) {
	return PROVIDER_KINDS.includes(kind);
}
function providerIdFor(kind) {
	return `provider:${kind}`;
}
function providerRequiredMessage(kind) {
	if (kind === "twilio") return "Twilio account details are required";
	if (kind === "cloudflare_email") return "Cloudflare Email account details are required";
	return `${displayKind(kind)} account details are required`;
}
function displayKind(kind) {
	return kind === "postmark" ? "Postmark" : kind === "resend" ? "Resend" : kind;
}
function normalizeTargetLabel(label) {
	if (label == null) return null;
	const trimmed = String(label).trim();
	if (!trimmed || trimmed.length > 80) return false;
	return trimmed;
}
function labelError(label) {
	return label === null ? "Channel label is required" : "Channel label must contain 1 to 80 characters";
}
async function duplicateTargetLabel(db, label, exceptId) {
	const row = await db.prepare(`SELECT 1 AS present FROM notification_targets WHERE label=?1 COLLATE NOCASE AND id!=?2 LIMIT 1`).bind(label, exceptId).first();
	return Boolean(row);
}
async function audit$1(db, actor, action, target, detail) {
	await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
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
	async fetch(request, env, ctx) {
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
		const notificationResponse = await notificationApiRoute(request, env, actor.actor);
		if (notificationResponse) return notificationResponse;
		const alertLevelsResponse = await alertLevelsApiRoute(request, env, actor.actor);
		if (alertLevelsResponse) return alertLevelsResponse;
		const ledgerResponse = await ledgerApiRoute(request, env, actor.actor);
		if (ledgerResponse) return ledgerResponse;
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
		if (url.pathname === "/api/cloudflare-zones" && request.method === "GET") {
			const budget = new RunBudget({
				apiCalls: 10,
				databaseRows: 0,
				samples: 500,
				wallMs: 1e4
			});
			return Response.json({
				accountId: env.BROLLY_ACCOUNT_ID,
				zones: await new CloudflareClient(env, budget).zones()
			}, { headers: { "cache-control": "no-store" } });
		}
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
		if (url.pathname === "/api/onboarding/ingest" && request.method === "GET") return Response.json(await initialIngestionProgress(env.DB, env.BROLLY_ACCOUNT_ID), { headers: { "cache-control": "no-store" } });
		if (url.pathname === "/api/onboarding/ingest" && request.method === "POST") {
			const job = await ensureInitialIngestionJob(env.DB, env.BROLLY_ACCOUNT_ID, { billingAvailable: await billingIngestionAvailable(env) });
			if (job.created || job.status === "pending" || job.status === "running") {
				const work = runInitialIngestion(env, job.id).catch(() => void 0);
				if (ctx) ctx.waitUntil(work);
			}
			return Response.json({
				ok: true,
				job
			}, {
				status: job.created ? 202 : 200,
				headers: { "cache-control": "no-store" }
			});
		}
		if (url.pathname === "/api/onboarding/estimates" && request.method === "POST") try {
			return Response.json(await onboardingBudgetEstimates(env), { headers: { "cache-control": "no-store" } });
		} catch (error) {
			return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof BudgetEstimateInProgressError ? 429 : 400 });
		}
		const billingAccessRoute = url.pathname === "/api/billing-access" || url.pathname === "/api/onboarding/billing-access";
		if (billingAccessRoute && request.method === "GET") return Response.json(await billingAccessConfiguration(env), { headers: { "cache-control": "no-store" } });
		if (billingAccessRoute && request.method === "PUT") {
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
		if (billingAccessRoute && request.method === "DELETE") {
			if (env.CLOUDFLARE_BILLING_TOKEN) return Response.json({ error: "Billing access is supplied as a Worker secret and must be removed in Cloudflare" }, { status: 409 });
			await removeOnboardingBillingAccess(env);
			await audit(env.DB, actor.actor, "billing_access.remove", env.BROLLY_ACCOUNT_ID, {});
			return Response.json({ ok: true });
		}
		if (url.pathname === "/api/onboarding" && request.method === "POST") {
			const body = await request.json();
			const alertLevels = await loadAlertLevels(env.DB);
			if (!validPolicy(body.policy, true, alertLevels.map((level) => level.id))) return Response.json({ error: "Policy limits and risk tolerance must be finite, in range, and ordered by alert level" }, { status: 400 });
			const scopedAssets = await env.DB.prepare(`SELECT family,asset_id,scope,metadata_json FROM assets WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace') LIMIT 2500`).all();
			const missingScopedBudgets = scopedAssets.results.filter((asset) => !body.policy.assetDailySpend?.[assetBudgetKey({
				family: asset.family,
				scope: asset.scope,
				id: asset.asset_id
			})]);
			if (missingScopedBudgets.length) return Response.json({ error: `Set limits for every discovered Worker and Durable Object namespace (${missingScopedBudgets.length} missing)` }, { status: 400 });
			const now = Date.now();
			const integrationUpdates = prepareRuntimeIntegrationUpdates(env, scopedAssets.results, body.integrations ?? [], now);
			if ("error" in integrationUpdates) return Response.json({ error: integrationUpdates.error }, { status: integrationUpdates.status });
			await env.DB.batch([env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('policy',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(JSON.stringify(body.policy), now), env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('onboarding_complete','true',?1) ON CONFLICT(key) DO UPDATE SET value='true',updated_at=excluded.updated_at`).bind(now)]);
			for (let index = 0; index < integrationUpdates.statements.length; index += 100) await env.DB.batch(integrationUpdates.statements.slice(index, index + 100));
			await new LedgerStore(env.DB).syncMetricCatalog();
			await migrateLegacyPolicyRules(env.DB, env.BROLLY_ACCOUNT_ID, body.policy, true);
			const initialIngestion = await ensureInitialIngestionJob(env.DB, env.BROLLY_ACCOUNT_ID, {
				billingAvailable: await billingIngestionAvailable(env),
				now
			});
			if (initialIngestion.created || initialIngestion.status === "pending" || initialIngestion.status === "running") {
				const work = runInitialIngestion(env, initialIngestion.id, now).catch(() => void 0);
				if (ctx) ctx.waitUntil(work);
			}
			await audit(env.DB, "admin", "onboarding.complete", body.policy.version, {
				levels: alertLevels.length,
				families: Object.keys(body.policy.familyDailySpend ?? {}).length,
				scopedAssets: Object.keys(body.policy.assetDailySpend ?? {}).length,
				runtimeIntegrations: body.integrations?.filter((item) => item.installed).length ?? 0,
				thresholds: body.policy.thresholds.length
			});
			return Response.json({
				ok: true,
				policy: body.policy,
				initialIngestion
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
			await runMonitor(env, { force: true });
			const [lastRun, collectors, runLimits] = await Promise.all([
				env.DB.prepare(`SELECT id,started_at,completed_at,status,coverage_status,graphql_queries,rest_requests,
             d1_rows_read,d1_rows_written,continuation_json
           FROM monitor_runs WHERE account_id=?1 ORDER BY started_at DESC LIMIT 1`).bind(env.BROLLY_ACCOUNT_ID).first(),
				env.DB.prepare(`SELECT collector_key,dataset,watermark_at,state FROM collector_capabilities
           WHERE account_id=?1 ORDER BY collector_key,dataset`).bind(env.BROLLY_ACCOUNT_ID).all(),
				configuredLedgerRunLimits(env.DB)
			]);
			return Response.json({
				ok: true,
				budget: runLimits,
				datasets: collectors.results.map((row) => ({
					collectorKey: row.collector_key,
					dataset: row.dataset,
					watermarkAt: row.watermark_at,
					state: row.state
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
					continuation: lastRun.continuation_json ? JSON.parse(String(lastRun.continuation_json)) : null
				} : null
			});
		}
		if (url.pathname === "/api/policy" && request.method === "GET") {
			const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='policy' LIMIT 1`).first();
			return Response.json(row ? JSON.parse(row.value) : DEFAULT_POLICY);
		}
		if (url.pathname === "/api/policy" && request.method === "PUT") {
			const body = await request.json();
			const policy = "policy" in body ? body.policy : body;
			const integrations = "policy" in body ? body.integrations ?? [] : [];
			const alertLevels = await loadAlertLevels(env.DB);
			if (!validPolicy(policy, false, alertLevels.map((level) => level.id))) return Response.json({ error: "Invalid policy" }, { status: 400 });
			const now = Date.now();
			const scopedAssets = integrations.length ? await env.DB.prepare(`SELECT family,asset_id,scope,metadata_json FROM assets WHERE (family='workers' AND scope='resource') OR (family='durable_objects' AND scope='namespace') LIMIT 2500`).all() : { results: [] };
			const integrationUpdates = prepareRuntimeIntegrationUpdates(env, scopedAssets.results, integrations, now);
			if ("error" in integrationUpdates) return Response.json({ error: integrationUpdates.error }, { status: integrationUpdates.status });
			await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('policy',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(JSON.stringify(policy), now).run();
			for (let index = 0; index < integrationUpdates.statements.length; index += 100) await env.DB.batch(integrationUpdates.statements.slice(index, index + 100));
			await new LedgerStore(env.DB).syncMetricCatalog();
			await migrateLegacyPolicyRules(env.DB, env.BROLLY_ACCOUNT_ID, policy, true);
			await audit(env.DB, "admin", "policy.update", policy.version, {
				levels: alertLevels.length,
				thresholds: policy.thresholds.length,
				runtimeIntegrations: integrations.filter((item) => item.installed).length
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
			const now = Date.now();
			if (((await env.DB.batch([env.DB.prepare(`UPDATE assets SET tier=?4,metadata_json=json_patch(metadata_json,?5),
             name=COALESCE(?6,name),seen_at=?7
           WHERE account_id=?1 AND family=?2 AND asset_id=?3`).bind(env.BROLLY_ACCOUNT_ID, family, id, body.tier, JSON.stringify(body.tags ?? {}), body.name ?? null, now), env.DB.prepare(`UPDATE resources SET tier=?4,metadata_json=json_patch(metadata_json,?5),
             display_name=COALESCE(?6,display_name),last_seen_at=MAX(last_seen_at,?7)
           WHERE account_id=?1 AND product_family=?2 AND cloudflare_id=?3
             AND resource_type NOT IN ('account','product')`).bind(env.BROLLY_ACCOUNT_ID, family, id, body.tier, JSON.stringify(body.tags ?? {}), body.name ?? null, now)]))[0]?.meta.changes ?? 0) === 0) return Response.json({ error: "Asset not found" }, { status: 404 });
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
		const incident = await env.DB.prepare(`SELECT severity,status,last_seen FROM incidents WHERE id=?1 LIMIT 1`).bind(action.incidentId).first();
		if (incident) {
			const incidentError = executableIncidentError(incident);
			if (incidentError) return Response.json({ error: incidentError }, { status: 409 });
		} else {
			const alertError = executableAlertInstanceError(await env.DB.prepare(`SELECT status,historical,period_end_at,last_breached_at,data_quality
         FROM alert_instances WHERE id=?1 LIMIT 1`).bind(action.incidentId).first());
			if (alertError) return Response.json({ error: alertError }, { status: 409 });
		}
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
function executableAlertInstanceError(instance, now = Date.now()) {
	if (!instance) return "The source alert instance no longer exists; no control was applied";
	if (!["open", "acknowledged"].includes(String(instance.status)) || Number(instance.historical) === 1 || Number(instance.period_end_at) <= now) return "The source alert instance is inactive; no control was applied";
	if (["missing", "stale"].includes(String(instance.data_quality))) return "The source alert evidence is unavailable or stale; run a fresh scan before applying control";
	const lastBreachedAt = Number(instance.last_breached_at);
	if (!Number.isFinite(lastBreachedAt) || lastBreachedAt < now - ACTION_INCIDENT_MAX_AGE_MS) return "The source alert evidence is stale; run a fresh scan before applying control";
	return null;
}
async function assetFromRows(env, primary, asset) {
	const current = await env.DB.prepare(`SELECT r.*,p.cloudflare_id AS parent_cloudflare_id,p.tier AS parent_tier,
       p.metadata_json AS parent_metadata_json
     FROM resources r LEFT JOIN resources p ON p.id=r.parent_resource_id
     WHERE r.account_id=?1 AND r.product_family=?2 AND r.cloudflare_id=?3
       AND (r.resource_type LIKE '%:resource' OR r.resource_type LIKE '%:object')
     ORDER BY CASE WHEN r.resource_type LIKE '%:object' THEN 0 ELSE 1 END LIMIT 1`).bind(String(primary.account_id), String(primary.family), String(primary.asset_id)).first();
	if (current) return assetFromResourceRow(current);
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
function assetFromResourceRow(row) {
	const directTags = parseStringRecord(row.metadata_json);
	const parentTags = parseStringRecord(row.parent_metadata_json);
	const directTier = String(row.tier);
	const parentTier = row.parent_tier == null ? void 0 : String(row.parent_tier);
	const suffix = String(row.resource_type).split(":").at(-1);
	return {
		accountId: String(row.account_id),
		family: String(row.product_family),
		id: String(row.cloudflare_id),
		parentId: row.parent_cloudflare_id == null ? void 0 : String(row.parent_cloudflare_id),
		name: row.display_name == null ? void 0 : String(row.display_name),
		scope: suffix === "object" || suffix === "namespace" || suffix === "resource" || suffix === "zone" || suffix === "account" ? suffix : "resource",
		tier: directTier !== "unclassified" ? directTier : parentTier ?? directTier,
		tags: {
			...parentTags,
			...directTags
		}
	};
}
function parseStringRecord(value) {
	try {
		const parsed = JSON.parse(String(value ?? "{}"));
		return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === "string"));
	} catch {
		return {};
	}
}
function authoritativeWorkerScript(asset) {
	if (asset.family === "workers" && asset.scope === "resource") return asset.id;
	if (asset.family === "durable_objects" && asset.scope === "object") return asset.tags?.cloudflareWorkerScript;
}
function isBrollyWorker(env, family, id) {
	if (family !== "workers") return false;
	return id === (env.BROLLY_SELF_WORKER_NAME ?? "brolly-guard") || id === "brolly-guard" || id.startsWith("brolly-guard-");
}
function prepareRuntimeIntegrationUpdates(env, assets, integrations, now) {
	const knownAssets = new Map(assets.map((asset) => [`${asset.family}:${asset.asset_id}`, asset]));
	const statements = [];
	for (const integration of integrations) {
		const asset = knownAssets.get(`${integration.family}:${integration.id}`);
		if (!asset) return {
			error: `Unknown runtime integration target ${integration.family}/${integration.id}`,
			status: 400
		};
		const workerScript = integration.workerScript?.trim();
		if (workerScript && !/^[A-Za-z0-9_-]+$/.test(workerScript)) return {
			error: `Invalid Worker script name for ${integration.id}`,
			status: 400
		};
		let tags;
		try {
			tags = JSON.parse(asset.metadata_json || "{}");
		} catch {
			tags = {};
		}
		const discoveredWorker = integration.family === "workers" ? integration.id : tags.cloudflareWorkerScript;
		if (workerScript && discoveredWorker && workerScript !== discoveredWorker) return {
			error: `Cloudflare maps ${integration.id} to ${discoveredWorker}, not ${workerScript}`,
			status: 409
		};
		delete tags.workerScript;
		if (integration.installed && discoveredWorker) tags.brollyFuse = "true";
		else delete tags.brollyFuse;
		statements.push(env.DB.prepare(`UPDATE assets SET metadata_json=?3,seen_at=?4 WHERE family=?1 AND asset_id=?2 AND account_id=?5`).bind(integration.family, integration.id, JSON.stringify(tags), now, env.BROLLY_ACCOUNT_ID));
	}
	return { statements };
}
async function audit(db, actor, action, target, detail) {
	await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
}
function validPolicy(policy, requireEveryFamily = false, levelIds = [
	"warning",
	"critical",
	"emergency"
]) {
	const finiteNonnegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
	const validSpend = (spend) => Boolean(spend) && levelIds.every((levelId) => finiteNonnegative(spend?.[levelId])) && levelIds.every((levelId, index) => index === 0 || spend[levelIds[index - 1]] <= spend[levelId]);
	if (typeof policy?.version !== "string" || !policy.version || !Array.isArray(policy.thresholds) || !levelIds.length) return false;
	if (!validSpend(policy.accountDailySpend)) return false;
	const familySpend = policy.familyDailySpend ?? {};
	if (requireEveryFamily && METRIC_CATALOG.some((definition) => !familySpend[definition.family])) return false;
	if (Object.values(familySpend).some((limit) => !validSpend(limit))) return false;
	if (Object.values(policy.assetDailySpend ?? {}).some((limit) => !validSpend(limit))) return false;
	if (policy.riskTolerance) {
		const tolerance = policy.riskTolerance;
		if (![
			"conservative",
			"balanced",
			"growth",
			"custom"
		].includes(tolerance.preset)) return false;
		if (!tolerance.percentOfTypical || !levelIds.every((levelId) => {
			const value = tolerance.percentOfTypical[levelId];
			return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 1e4;
		})) return false;
		if (!levelIds.every((levelId, index) => index === 0 || tolerance.percentOfTypical[levelIds[index - 1]] < tolerance.percentOfTypical[levelId])) return false;
		if (!tolerance.baseline || !finiteNonnegative(tolerance.baseline.computedAt) || !finiteNonnegative(tolerance.baseline.windowDays) || tolerance.baseline.windowDays <= 0) return false;
	}
	if (policy.limits) {
		if (!policy.limits.day || !policy.limits.cycle) return false;
		const validOptionalSpend = (spend) => !spend || Object.keys(spend).length === 0 || validSpend(spend);
		const validBooleanMap = (values) => !values || Object.values(values).every((value) => typeof value === "boolean");
		for (const scopes of [policy.limits.day, policy.limits.cycle]) {
			if (!scopes || typeof scopes !== "object") return false;
			for (const scope of Object.values(scopes)) {
				if (!scope || !validOptionalSpend(scope.cost) || !scope.usage || Object.values(scope.usage).some((value) => !validOptionalSpend(value))) return false;
				if (scope.costEnabled !== void 0 && typeof scope.costEnabled !== "boolean") return false;
				if (scope.enabled !== void 0 && typeof scope.enabled !== "boolean") return false;
				if (!validBooleanMap(scope.usageEnabled) || !validBooleanMap(scope.costLevelEnabled)) return false;
				if (scope.usageLevelEnabled && Object.values(scope.usageLevelEnabled).some((value) => !validBooleanMap(value))) return false;
			}
		}
	}
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
export { worker_entry_default as default, executableAlertInstanceError, executableIncidentError, validPolicy, validateNotificationConfig, validateProviderConfig };
