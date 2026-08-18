#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const API_URL = "https://api.cloudflare.com/client/v4";
const DATASET_FILE = resolve(ROOT, "docs/cloudflare-datasets.json");
const BILLING_DAYS = 35;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BILLING_RECORDS = 20_000;

const SPECIALIZED_DATASETS = new Set([
  "workersInvocationsAdaptive",
  "durableObjectsInvocationsAdaptiveGroups",
  "durableObjectsPeriodicGroups",
  "durableObjectsSqlStorageGroups",
  "durableObjectsStorageGroups",
]);

const CANDIDATES = [
  ["Workers Logs / Observability", ["logexplorer", "logpush", "observability"]],
  ["Access / Zero Trust seats", ["accesslogin", "cf1access", "zerotrust"]],
  ["Load Balancing", ["loadbalancing"]],
  ["Argo Smart Routing", ["argo"]],
  ["Rate Limiting", ["ratelimiting"]],
  ["Bot Management", ["botmanagement"]],
  ["Waiting Room", ["waitingroom"]],
  ["Spectrum", ["spectrum"]],
  ["Magic Transit", ["magictransit"]],
  ["Calls / RealtimeKit", ["callsusage", "callsturn", "realtimekit"]],
  ["Turnstile", ["turnstile"]],
  ["Web Analytics", ["rumpageload", "rumperformance", "rumwebvitals"]],
  ["Cloudflare Tunnel", ["cloudflaretunnels"]],
  ["Pipelines", ["pipelines"]],
  ["Secrets Store", ["secretsstore"]],
  ["R2 Data Catalog", ["r2catalog"]],
  ["Workers VPC", ["workersvpc"]],
];

const INTROSPECTION_QUERY = `
  query BrollyProductCoverageSchema {
    __schema {
      queryType { name }
      types {
        name
        kind
        fields {
          name
          type { ...TypeRef }
          args { name type { ...TypeRef } }
        }
      }
    }
  }
  fragment TypeRef on __Type {
    kind
    name
    ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
  }
`;

function loadDotEnv(path) {
  return readFile(path, "utf8").then(text => {
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }).catch(() => undefined);
}

async function loadRegistry(modulePath) {
  const source = await readFile(modulePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: modulePath,
  }).outputText;
  const url = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
  return import(`${url}#${createHash("sha256").update(source).digest("hex")}`);
}

function tokenFor(kind) {
  if (kind === "billing") return process.env.CLOUDFLARE_BILLING_TOKEN || tokenFor("graphql");
  return process.env.CLOUDFLARE_API_TOKEN
    || process.env.CLOUDFLARE_OAUTH_TOKEN
    || process.env.BROLLY_CLOUDFLARE_OAUTH_TOKEN;
}

function accountId() {
  return process.env.CLOUDFLARE_ACCOUNT_ID || process.env.BROLLY_ACCOUNT_ID;
}

function headers(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function requestJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.errors?.map(item => item.message).join("; ") || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function namedType(type) {
  let current = type;
  while (current?.ofType) current = current.ofType;
  return current?.name;
}

function typeByName(types, name) {
  return types.find(type => type.name === name);
}

function fieldByName(type, name) {
  return type?.fields?.find(field => field.name === name);
}

function rootObjectType(schema, rootField) {
  const queryType = typeByName(schema.types, schema.queryType?.name);
  const root = fieldByName(queryType, rootField);
  return typeByName(schema.types, namedType(root?.type));
}

function rootDatasetType(schema, rootType, datasetField) {
  const field = fieldByName(rootType, datasetField);
  return typeByName(schema.types, namedType(field?.type));
}

function looksLikeTime(name, typeName) {
  return /^(date|datetime|time|timestamp)/i.test(name) || /date|time/i.test(typeName || "");
}

function describeDataset(schema, root, rootType, field) {
  const resultType = rootDatasetType(schema, rootType, field.name);
  const resultFields = resultType?.fields || [];
  const dimensionsField = resultFields.find(item => item.name === "dimensions");
  const dimensionsType = typeByName(schema.types, namedType(dimensionsField?.type));
  const dimensionNames = (dimensionsType?.fields || []).map(item => item.name).sort();
  const timeFields = dimensionNames.filter(name => looksLikeTime(name));
  for (const item of resultFields) {
    if (looksLikeTime(item.name, namedType(item.type)) && !timeFields.includes(item.name)) timeFields.push(item.name);
  }
  return {
    root,
    dataset: field.name,
    graphqlType: namedType(field.type) || null,
    dimensions: dimensionNames.filter(name => !timeFields.includes(name)),
    timeFields: timeFields.sort(),
  };
}

function datasetsFromSchema(schema) {
  const viewer = rootObjectType(schema, "viewer");
  const accountRoot = rootObjectType(viewer ? { ...schema, queryType: { name: viewer.name } } : schema, "accounts");
  const zoneRoot = rootObjectType(viewer ? { ...schema, queryType: { name: viewer.name } } : schema, "zones");
  const fieldsFor = (root, type) => (type?.fields || [])
    .filter(field => field.name.endsWith("Groups"))
    .map(field => describeDataset(schema, root, type, field));
  const datasets = [...fieldsFor("account", accountRoot), ...fieldsFor("zone", zoneRoot)];
  const unique = new Map();
  for (const item of datasets) unique.set(`${item.root}:${item.dataset}`, item);
  return [...unique.values()].sort((left, right) => `${left.root}:${left.dataset}`.localeCompare(`${right.root}:${right.dataset}`));
}

async function introspect(token) {
  const payload = await requestJson(GRAPHQL_URL, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });
  if (payload.errors?.length) throw new Error(payload.errors.map(item => item.message).join("; "));
  if (!payload.data?.__schema) throw new Error("Cloudflare returned no GraphQL schema");
  return datasetsFromSchema(payload.data.__schema);
}

function normalizeFamily(value) {
  const normalized = String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
  return {
    durable_objects: "durable_objects",
    workers_kv: "kv",
    workers_ai: "workers_ai",
    ai_gateway: "ai_gateway",
    browser_rendering: "browser_rendering",
    worker_builds: "worker_builds",
  }[normalized] || normalized;
}

async function billingFamilies(token, id) {
  if (!token || !id) return { families: [], status: "credentials_unavailable" };
  const until = new Date();
  const since = new Date(until.getTime() - BILLING_DAYS * 86_400_000);
  const params = new URLSearchParams({ from: since.toISOString().slice(0, 10), to: until.toISOString().slice(0, 10) });
  const paths = [
    `/accounts/${encodeURIComponent(id)}/billable/usage?${params}`,
    `/accounts/${encodeURIComponent(id)}/billable-usage?${params}`,
  ];
  let lastError;
  for (const [index, path] of paths.entries()) {
    try {
      const payload = await requestJson(`${API_URL}${path}`, { headers: { authorization: `Bearer ${token}` } });
      const records = Array.isArray(payload.result) ? payload.result.slice(0, MAX_BILLING_RECORDS) : [];
      const families = [...new Set(records.map(record => normalizeFamily(record.x_ProductFamilyId || record.x_ProductFamilyName || record.ServiceFamilyName || record.ServiceName)).filter(Boolean))].sort();
      return { families, status: index === 0 ? "billable_usage" : "paygo_billable_usage", records: records.length, truncated: Array.isArray(payload.result) && payload.result.length > MAX_BILLING_RECORDS };
    } catch (error) {
      lastError = error;
      if (index === 0 && ![403, 404].includes(error.status)) break;
    }
  }
  return { families: [], status: "unavailable", error: lastError?.message || "billing request failed" };
}

function table(title, headersList, rows) {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log("  (none)");
    return;
  }
  const values = [headersList, ...rows].map(row => row.map(value => String(value ?? "")));
  const widths = headersList.map((_, index) => Math.max(...values.map(row => row[index].length)));
  for (const row of values) console.log(`  ${row.map((value, index) => value.padEnd(widths[index])).join("  ")}`);
}

function candidateOutcomes(datasets, families, schemaAvailable, billingAvailable) {
  const compact = value => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return CANDIDATES.map(([name, needles]) => {
    const datasetMatches = datasets
      .filter(item => needles.some(needle => compact(item.dataset).includes(needle)))
      .map(datasetKey);
    const billingMatches = families.filter(family => needles.some(needle => compact(family).includes(needle)));
    const datasetObserved = datasetMatches.length > 0;
    const billingObserved = billingMatches.length > 0;
    let status = "not-audited";
    let evidence = "schema and billing evidence were unavailable";
    if (billingObserved) {
      status = "billing-observed";
      evidence = "a billing family name matched";
    } else if (datasetObserved) {
      status = billingAvailable ? "dataset-only" : "dataset-observed-billing-unverified";
      evidence = billingAvailable
        ? "a dataset matched and no billing family matched"
        : "a dataset matched; billing access was unavailable";
    } else if (schemaAvailable || billingAvailable) {
      status = "not-observed-in-account";
      evidence = "no matching dataset or billing family appeared in the bounded result";
    }
    return {
      product: name,
      status,
      evidence,
      datasetMatches,
      billingMatches,
    };
  });
}

function datasetKey(item) {
  return `${item.root}:${item.dataset}`;
}

function classifyDatasets(datasets, usage) {
  const adapterKeys = new Set(usage.PRODUCT_USAGE_DEFINITIONS.flatMap(definition =>
    definition.datasets.map(source => `${source.root ?? "account"}:${source.dataset}`),
  ));
  const specializedKeys = new Set([...SPECIALIZED_DATASETS].map(dataset => `account:${dataset}`));
  return datasets.map(item => {
    const key = datasetKey(item);
    const coverage = adapterKeys.has(key) ? "adapter" : specializedKeys.has(key) ? "specialized" : "unclassified";
    return { ...item, coverage, billable: coverage !== "unclassified" };
  });
}

async function main() {
  await loadDotEnv(resolve(ROOT, ".env"));
  await loadDotEnv(resolve(ROOT, "apps/guard-worker/.dev.vars"));
  const core = await loadRegistry(resolve(ROOT, "packages/core/src/catalog.ts"));
  const usage = await loadRegistry(resolve(ROOT, "apps/guard-worker/src/product-usage.ts"));
  const catalogFamilies = new Set(core.METRIC_CATALOG.map(item => item.family).filter(item => item !== "unknown"));
  const token = tokenFor("graphql");
  const billingToken = tokenFor("billing");
  let datasets = [];
  let schemaStatus = "credentials_unavailable";
  let schemaError;
  if (token) {
    try {
      datasets = classifyDatasets(await introspect(token), usage);
      schemaStatus = "introspected";
    } catch (error) {
      schemaStatus = "unavailable";
      schemaError = error instanceof Error ? error.message : String(error);
    }
  }
  const billing = await billingFamilies(billingToken, accountId());
  const datasetFamilies = new Set(datasets.map(item => {
    const definition = usage.PRODUCT_USAGE_DEFINITIONS.find(def => def.datasets.some(source => source.dataset === item.dataset));
    return definition?.family;
  }).filter(Boolean));
  const noAdapter = datasets.filter(item => item.coverage === "unclassified");
  const billingWithoutCatalog = billing.families.filter(family => !catalogFamilies.has(family));
  const stale = billing.status === "credentials_unavailable" || billing.status === "unavailable"
    ? []
    : [...catalogFamilies].filter(family => !datasetFamilies.has(family) && !billing.families.includes(family)).sort();
  table("Datasets with no adapter", ["root", "dataset", "dimensions", "time fields"], noAdapter.map(item => [item.root, item.dataset, item.dimensions.join(", "), item.timeFields.join(", ")]));
  table("Billing families with no catalog family", ["family"], billingWithoutCatalog.map(family => [family]));
  table("Catalog families with neither a dataset nor a billing family", ["family"], stale.map(family => [family]));
  const billingAvailable = billing.status === "billable_usage" || billing.status === "paygo_billable_usage";
  const outcomes = candidateOutcomes(datasets, billing.families, schemaStatus === "introspected", billingAvailable);
  table("Known candidate outcomes", ["product", "status", "evidence"], outcomes.map(item => [item.product, item.status, item.evidence]));
  console.log(`\nGraphQL schema: ${schemaStatus}${schemaError ? ` (${schemaError})` : ""}`);
  console.log(`Billing usage: ${billing.status}${billing.records !== undefined ? ` (${billing.records} records, last ${BILLING_DAYS} days)` : ""}${billing.error ? ` (${billing.error})` : ""}`);
  if (!token) console.log("Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_OAUTH_TOKEN to run the bounded GraphQL introspection.");
  if (!accountId()) console.log("Set CLOUDFLARE_ACCOUNT_ID or BROLLY_ACCOUNT_ID to run the bounded billing export.");

  if (schemaStatus === "introspected") {
    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: { endpoint: GRAPHQL_URL, accountScope: "account and zone schema fields ending in Groups", billingWindowDays: BILLING_DAYS },
      datasets,
      candidateOutcomes: outcomes,
      billing: { status: billing.status, families: billing.families, records: billing.records ?? 0, truncated: billing.truncated ?? false },
    };
    await writeFile(DATASET_FILE, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`\nWrote ${DATASET_FILE}`);
  } else {
    console.log(`\nNo dataset file was written because the schema was not introspected.`);
  }
}

main().catch(error => {
  console.error(`Product coverage audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
