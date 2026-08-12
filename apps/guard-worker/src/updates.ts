import type { Env } from "./env.js";
import { BROLLY_RELEASE } from "./release.js";

const RELEASE_URL = "https://raw.githubusercontent.com/standardagents/brolly/deploy-template/brolly-release.json";
const CACHE_KEY = "brolly_release_cache";
const REPOSITORY_KEY = "update_repository";
const LEASE_NAME = "release-check";
const CACHE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_MANIFEST_BYTES = 8_192;

export interface BrollyReleaseManifest {
  schemaVersion: 1;
  release: string;
  displayVersion: string;
  publishedAt: string;
  notesUrl: string;
  workflowFile: "brolly-update.yml";
  configVersion: 1;
}

interface CachedRelease {
  manifest?: BrollyReleaseManifest;
  checkedAt: number;
  error?: string;
}

export interface ReleaseStatus {
  currentRelease: string;
  latestRelease: string | null;
  displayVersion: string | null;
  publishedAt: string | null;
  notesUrl: string | null;
  available: boolean;
  checkedAt: number | null;
  stale: boolean;
  checking: boolean;
  repository: string | null;
  updateUrl: string | null;
  error?: string;
}

export async function releaseStatus(env: Env): Promise<ReleaseStatus> {
  const now = Date.now();
  const [cacheRow, repositoryRow] = await Promise.all([
    env.DB.prepare(`SELECT value,updated_at FROM settings WHERE key=?1 LIMIT 1`).bind(CACHE_KEY).first<{ value: string; updated_at: number }>(),
    env.DB.prepare(`SELECT value FROM settings WHERE key=?1 LIMIT 1`).bind(REPOSITORY_KEY).first<{ value: string }>(),
  ]);
  const repository = repositoryRow?.value && validRepository(repositoryRow.value) ? repositoryRow.value : null;
  const cached = parseCache(cacheRow?.value);
  if (cached && now - cached.checkedAt < CACHE_MS) return toStatus(cached, repository, Boolean(cached.error), false);

  const holder = crypto.randomUUID();
  const lease = await env.DB.prepare(
    `INSERT INTO cron_lease(name,holder,expires_at) VALUES(?1,?2,?3)
     ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,expires_at=excluded.expires_at
     WHERE cron_lease.expires_at<?4`,
  ).bind(LEASE_NAME, holder, now + 20_000, now).run();
  if ((lease.meta.changes ?? 0) === 0) {
    return cached
      ? toStatus(cached, repository, true, true)
      : emptyStatus(repository, { checking: true, stale: true });
  }

  try {
    const manifest = await fetchReleaseManifest();
    const next: CachedRelease = { manifest, checkedAt: Date.now() };
    await saveCache(env.DB, next);
    return toStatus(next, repository, false, false);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const failed: CachedRelease = { manifest: cached?.manifest, checkedAt: Date.now(), error };
    await saveCache(env.DB, failed);
    return toStatus(failed, repository, true, false);
  } finally {
    await env.DB.prepare(`DELETE FROM cron_lease WHERE name=?1 AND holder=?2`).bind(LEASE_NAME, holder).run();
  }
}

export async function saveUpdateRepository(env: Env, repository: string): Promise<string | null> {
  const normalized = repository.trim();
  if (normalized && !validRepository(normalized)) throw new Error("Use a GitHub repository in owner/repository format");
  if (!normalized) {
    await env.DB.prepare(`DELETE FROM settings WHERE key=?1`).bind(REPOSITORY_KEY).run();
    return null;
  }
  await env.DB.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).bind(REPOSITORY_KEY, normalized, Date.now()).run();
  return normalized;
}

export function parseReleaseManifest(value: unknown): BrollyReleaseManifest {
  if (!value || typeof value !== "object") throw new Error("Brolly release manifest is not an object");
  const manifest = value as Partial<BrollyReleaseManifest>;
  if (manifest.schemaVersion !== 1 || manifest.configVersion !== 1 || manifest.workflowFile !== "brolly-update.yml") {
    throw new Error("Brolly release manifest uses an unsupported format");
  }
  if (typeof manifest.release !== "string" || !/^[a-f0-9]{40}$/.test(manifest.release)) throw new Error("Brolly release identifier is invalid");
  if (typeof manifest.displayVersion !== "string" || !/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-f0-9]{7}$/.test(manifest.displayVersion)) throw new Error("Brolly release version is invalid");
  if (typeof manifest.publishedAt !== "string" || !Number.isFinite(Date.parse(manifest.publishedAt))) throw new Error("Brolly release date is invalid");
  if (typeof manifest.notesUrl !== "string") throw new Error("Brolly release notes URL is missing");
  const notesUrl = new URL(manifest.notesUrl);
  if (notesUrl.protocol !== "https:" || notesUrl.hostname !== "github.com" || !notesUrl.pathname.startsWith("/standardagents/brolly/")) {
    throw new Error("Brolly release notes URL is not trusted");
  }
  return manifest as BrollyReleaseManifest;
}

export function validRepository(value: string): boolean {
  if (value.length > 200 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return false;
  return value.split("/").every(segment => segment !== "." && segment !== "..");
}

async function fetchReleaseManifest(): Promise<BrollyReleaseManifest> {
  const response = await fetch(RELEASE_URL, {
    headers: { accept: "application/json", "user-agent": "brolly-release-check" },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Release check returned HTTP ${response.status}`);
  if (response.type === "opaqueredirect" || response.status >= 300) throw new Error("Release check refused an unexpected redirect");
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_MANIFEST_BYTES) throw new Error("Release manifest is unexpectedly large");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) throw new Error("Release manifest is unexpectedly large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Release manifest is not valid JSON"); }
  return parseReleaseManifest(value);
}

function parseCache(value: string | undefined): CachedRelease | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CachedRelease>;
    if (typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt)) return null;
    const manifest = parsed.manifest === undefined ? undefined : parseReleaseManifest(parsed.manifest);
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    return { checkedAt: parsed.checkedAt, manifest, error };
  } catch {
    return null;
  }
}

function toStatus(cache: CachedRelease, repository: string | null, stale: boolean, checking: boolean): ReleaseStatus {
  if (!cache.manifest) return emptyStatus(repository, { checkedAt: cache.checkedAt, stale, checking, ...(cache.error ? { error: cache.error } : {}) });
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
    ...(cache.error ? { error: cache.error } : {}),
  };
}

async function saveCache(db: D1Database, cache: CachedRelease): Promise<void> {
  await db.prepare(
    `INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ).bind(CACHE_KEY, JSON.stringify(cache), cache.checkedAt).run();
}

function emptyStatus(repository: string | null, extra: Partial<ReleaseStatus>): ReleaseStatus {
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
    ...extra,
  };
}
