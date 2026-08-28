import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DEFAULT_DB = ".wrangler/state/account-dev/v3/d1/miniflare-D1DatabaseObject/73646d9cff124e92005d9938e8e9451ed6e56f1ac13e6c82510bd125fc7789e3.sqlite";
const EMAIL_DATASETS = new Set(["emailSendingAdaptiveGroups", "emailRoutingAdaptiveGroups"]);

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(`Usage: pnpm probe:graphql -- [options]

Read-only probe for Cloudflare's GraphQL Analytics limiter. Credentials are
decrypted in memory and never printed. Imported Brolly data is never changed.

Options:
  --mode=batch|exact       Nested account batch or one exact zone (default: batch)
  --dataset=<name>         Email Analytics dataset (default: emailSendingAdaptiveGroups)
  --count=<n>              Requests to send (default: 1, maximum: 100)
  --interval-ms=<n>        Delay between requests (default: 3000, minimum: 1000)
  --zones=<n>              Zones per nested batch (default: 10, maximum: 10)
  --db=<path>              Local D1 SQLite path
  --help                   Show this help
`);
  process.exit(0);
}

if (!EMAIL_DATASETS.has(options.dataset)) throw new Error(`Unsupported probe dataset ${options.dataset}`);

const database = new DatabaseSync(path.resolve(options.db), { readOnly: true });
try {
  const accountId = setting(database, "account_id");
  const encrypted = setting(database, "oauth_credentials");
  const credentialKey = devVariable("BROLLY_CREDENTIAL_KEY");
  const oauth = await decryptJson(encrypted, credentialKey);
  if (typeof oauth.accessToken !== "string" || !oauth.accessToken) throw new Error("Stored OAuth access token is unavailable");
  if (Number(oauth.expiresAt ?? Infinity) <= Date.now()) throw new Error("Stored OAuth access token has expired; start Brolly once to refresh it");

  const pending = database.prepare(
    `SELECT scope_key,starts_at,ends_at FROM backfill_slices
     WHERE collector_key='graphql:email' AND status='pending'
     ORDER BY ends_at DESC,id`,
  ).all().flatMap(row => {
    const metadata = JSON.parse(String(row.scope_key));
    return metadata.dataset === options.dataset && metadata.availability === "available" && metadata.zoneIds?.[0]
      ? [{ zoneId: String(metadata.zoneIds[0]), startsAt: Number(row.starts_at), endsAt: Number(row.ends_at) }]
      : [];
  });
  const unique = [...new Map(pending.map(item => [item.zoneId, item])).values()];
  if (!unique.length) throw new Error(`No pending ${options.dataset} zone windows are available to probe`);

  for (let index = 0; index < options.count; index += 1) {
    const offset = options.mode === "batch" ? index * options.zones % unique.length : index % unique.length;
    const selected = options.mode === "batch"
      ? Array.from({ length: Math.min(options.zones, unique.length) }, (_, itemIndex) => unique[(offset + itemIndex) % unique.length])
      : [unique[offset]];
    const first = selected[0];
    const query = options.mode === "batch"
      ? batchQuery(options.dataset)
      : exactQuery(options.dataset);
    const variables = options.mode === "batch"
      ? { account: accountId, zones: selected.map(item => item.zoneId), start: new Date(first.startsAt).toISOString(), end: new Date(first.endsAt).toISOString() }
      : { zone: first.zoneId, start: new Date(first.startsAt).toISOString(), end: new Date(first.endsAt).toISOString() };
    const startedAt = Date.now();
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        "content-type": "application/json",
        "x-rate-limit-type": "account-based",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => ({}));
    const roots = options.mode === "batch"
      ? payload.data?.viewer?.accounts?.[0]?.zones ?? []
      : payload.data?.viewer?.zones ?? [];
    const report = {
      request: index + 1,
      mode: options.mode,
      zonesRequested: selected.length,
      status: response.status,
      durationMs: Date.now() - startedAt,
      zonesReturned: Array.isArray(roots) ? roots.length : 0,
      rowsReturned: Array.isArray(roots)
        ? roots.reduce((sum, root) => sum + (Array.isArray(root.probe) ? root.probe.length : 0), 0)
        : 0,
      rateLimit: response.headers.get("ratelimit"),
      rateLimitPolicy: response.headers.get("ratelimit-policy"),
      retryAfter: response.headers.get("retry-after"),
      rayId: response.headers.get("cf-ray"),
      errors: Array.isArray(payload.errors) ? payload.errors.map(error => error?.message).filter(Boolean) : [],
    };
    console.log(JSON.stringify(report));
    if (response.status === 429 || report.errors.some(message => /rate limit|budget depleted|excessive resources/i.test(message))) break;
    if (index + 1 < options.count) await new Promise(resolve => setTimeout(resolve, options.intervalMs));
  }
} finally {
  database.close();
}

function batchQuery(dataset) {
  return `query BrollyRateProbe($account: String!, $zones: [string!]!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        zones(filter: { zoneTag_in: $zones }) {
          zoneTag
          probe: ${dataset}(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) {
            dimensions { date }
            count
          }
        }
      }
    }
  }`;
}

function exactQuery(dataset) {
  return `query BrollyRateProbe($zone: string!, $start: Time!, $end: Time!) {
    viewer {
      zones(filter: { zoneTag: $zone }) {
        zoneTag
        probe: ${dataset}(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) {
          dimensions { date }
          count
        }
      }
    }
  }`;
}

function setting(database, key) {
  const row = database.prepare("SELECT value FROM settings WHERE key=? LIMIT 1").get(key);
  if (!row?.value) throw new Error(`Missing local D1 setting ${key}`);
  return String(row.value);
}

function devVariable(name) {
  const contents = readFileSync(path.resolve(".dev.vars"), "utf8");
  const line = contents.split(/\r?\n/).find(value => value.trimStart().startsWith(`${name}=`));
  if (!line) throw new Error(`Missing ${name} in .dev.vars`);
  const value = line.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!value) throw new Error(`Missing ${name} in .dev.vars`);
  return value;
}

async function decryptJson(value, secret) {
  const envelope = JSON.parse(value);
  const key = await webcrypto.subtle.importKey("raw", decode(secret), "AES-GCM", false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: decode(envelope.iv) }, key, decode(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function decode(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function parseArgs(values) {
  const result = {
    help: false,
    mode: "batch",
    dataset: "emailSendingAdaptiveGroups",
    count: 1,
    intervalMs: 3000,
    zones: 10,
    db: DEFAULT_DB,
  };
  for (const value of values) {
    if (value === "--") continue;
    if (value === "--help") result.help = true;
    else if (value.startsWith("--mode=")) result.mode = value.slice(7);
    else if (value.startsWith("--dataset=")) result.dataset = value.slice(10);
    else if (value.startsWith("--count=")) result.count = boundedInteger(value.slice(8), 1, 100, "count");
    else if (value.startsWith("--interval-ms=")) result.intervalMs = boundedInteger(value.slice(14), 1000, 60_000, "interval-ms");
    else if (value.startsWith("--zones=")) result.zones = boundedInteger(value.slice(8), 1, 10, "zones");
    else if (value.startsWith("--db=")) result.db = value.slice(5);
    else throw new Error(`Unknown argument ${value}`);
  }
  if (result.mode !== "batch" && result.mode !== "exact") throw new Error("mode must be batch or exact");
  return result;
}

function boundedInteger(value, minimum, maximum, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}
