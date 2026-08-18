import type { Env } from "./env.js";

export const REPEAT_INTERVALS = [null, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000, 24 * 60 * 60_000] as const;
export const ALERT_ENTRY_KINDS = ["channel", "prepare_stop", "prepare_quarantine", "auto_pause", "auto_quarantine"] as const;

export type AlertEntryKind = typeof ALERT_ENTRY_KINDS[number];

export interface AlertLevel {
  id: string;
  position: number;
  label: string;
  entries: AlertLevelEntry[];
}

export interface AlertLevelEntry {
  id: string;
  levelId: string;
  kind: AlertEntryKind;
  targetId: string | null;
  repeatIntervalMs: number | null;
  position: number;
}

export interface EffectiveLevelConfiguration {
  channels: Array<{ targetId: string; repeatIntervalMs: number | null }>;
  stopOrPause: "prepare" | "auto" | null;
  quarantine: "prepare" | "auto" | null;
}

export async function alertLevelsApiRoute(request: Request, env: Env, actor: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/alert-levels" && request.method === "GET") {
    return Response.json({ levels: await loadAlertLevels(env.DB) }, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname === "/api/alert-levels" && request.method === "POST") {
    const body = await request.json<{ label?: string; afterLevelId?: string | null }>();
    const label = normalizedLabel(body.label);
    if (!label) return Response.json({ error: "Level name must contain 1 to 40 characters" }, { status: 400 });
    const levels = await loadAlertLevels(env.DB);
    if (levels.length >= 8) return Response.json({ error: "Brolly supports up to eight alert levels" }, { status: 400 });
    if (levels.some(level => sameLabel(level.label, label))) return Response.json({ error: "Alert level names must be unique" }, { status: 400 });
    let insertAt = 0;
    if (body.afterLevelId != null) {
      const after = levels.findIndex(level => level.id === body.afterLevelId);
      if (after === -1) return Response.json({ error: "Previous alert level not found" }, { status: 400 });
      insertAt = after + 1;
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO alert_levels(id,position,label,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)`)
      .bind(id, 10_000 + levels.length, label, now).run();
    const ordered = [...levels];
    ordered.splice(insertAt, 0, { id, position: insertAt, label, entries: [] });
    await writeLevelPositions(env.DB, ordered.map(level => level.id), now);
    await audit(env.DB, actor, "alert_level.create", id, { label, position: insertAt });
    return Response.json({ ok: true, level: (await loadAlertLevels(env.DB)).find(level => level.id === id) }, { status: 201 });
  }

  const levelMatch = url.pathname.match(/^\/api\/alert-levels\/([^/]+)$/);
  if (levelMatch && request.method === "PATCH") {
    const id = decodeURIComponent(levelMatch[1]!);
    const body = await request.json<{ label?: string; position?: number }>();
    if (body.label === undefined && body.position === undefined) return Response.json({ error: "No level change supplied" }, { status: 400 });
    const levels = await loadAlertLevels(env.DB);
    const currentIndex = levels.findIndex(level => level.id === id);
    if (currentIndex === -1) return Response.json({ error: "Alert level not found" }, { status: 404 });
    const now = Date.now();
    if (body.label !== undefined) {
      const label = normalizedLabel(body.label);
      if (!label) return Response.json({ error: "Level name must contain 1 to 40 characters" }, { status: 400 });
      if (levels.some(level => level.id !== id && sameLabel(level.label, label))) return Response.json({ error: "Alert level names must be unique" }, { status: 400 });
      await env.DB.batch([
        env.DB.prepare(`UPDATE alert_levels SET label=?2,updated_at=?3 WHERE id=?1`).bind(id, label, now),
        env.DB.prepare(`UPDATE alert_lines SET label=?2,updated_at=?3 WHERE level_id=?1`).bind(id, label, now),
      ]);
    }
    if (body.position !== undefined) {
      if (!Number.isInteger(body.position) || body.position < 0 || body.position >= levels.length) {
        return Response.json({ error: "Level position is outside the board" }, { status: 400 });
      }
      const [moved] = levels.splice(currentIndex, 1);
      levels.splice(body.position, 0, moved!);
      await writeLevelPositions(env.DB, levels.map(level => level.id), now);
      await synchronizeLinePriorities(env.DB, levels, now);
    }
    await audit(env.DB, actor, "alert_level.update", id, body);
    return Response.json({ ok: true, level: (await loadAlertLevels(env.DB)).find(level => level.id === id) });
  }

  if (levelMatch && request.method === "DELETE") {
    const id = decodeURIComponent(levelMatch[1]!);
    const levels = await loadAlertLevels(env.DB);
    if (!levels.some(level => level.id === id)) return Response.json({ error: "Alert level not found" }, { status: 404 });
    if (levels.length === 1) return Response.json({ error: "At least one alert level must remain" }, { status: 409 });
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`UPDATE alert_lines SET retired=1,updated_at=?2 WHERE level_id=?1`).bind(id, now),
      env.DB.prepare(`DELETE FROM alert_levels WHERE id=?1`).bind(id),
    ]);
    const remaining = levels.filter(level => level.id !== id);
    await writeLevelPositions(env.DB, remaining.map(level => level.id), now);
    await synchronizeLinePriorities(env.DB, remaining, now);
    await audit(env.DB, actor, "alert_level.delete", id, {});
    return Response.json({ ok: true, id });
  }

  const entriesMatch = url.pathname.match(/^\/api\/alert-levels\/([^/]+)\/entries(?:\/([^/]+))?$/);
  if (!entriesMatch) return null;
  const levelId = decodeURIComponent(entriesMatch[1]!);
  const entryId = entriesMatch[2] ? decodeURIComponent(entriesMatch[2]) : null;
  if (!await env.DB.prepare(`SELECT 1 AS present FROM alert_levels WHERE id=?1 LIMIT 1`).bind(levelId).first()) {
    return Response.json({ error: "Alert level not found" }, { status: 404 });
  }

  if (!entryId && request.method === "POST") {
    const body = await request.json<{ kind?: string; targetId?: string; repeatIntervalMs?: number | null }>();
    if (!ALERT_ENTRY_KINDS.includes(body.kind as AlertEntryKind)) return Response.json({ error: "Invalid alert level entry" }, { status: 400 });
    const kind = body.kind as AlertEntryKind;
    const repeatIntervalMs = body.repeatIntervalMs ?? null;
    if (kind === "channel") {
      if (!body.targetId) return Response.json({ error: "Channel entry requires a target" }, { status: 400 });
      if (!isRepeatInterval(repeatIntervalMs)) return Response.json({ error: "Invalid repeat interval" }, { status: 400 });
      if (!await env.DB.prepare(`SELECT 1 AS present FROM notification_targets WHERE id=?1 LIMIT 1`).bind(body.targetId).first()) {
        return Response.json({ error: "Notification target not found" }, { status: 400 });
      }
    } else if (body.targetId != null || body.repeatIntervalMs != null) {
      return Response.json({ error: "Action entries do not use a channel or interval" }, { status: 400 });
    }
    const duplicate = await env.DB.prepare(
      `SELECT 1 AS present FROM alert_level_entries WHERE level_id=?1 AND kind=?2 AND COALESCE(target_id,'')=COALESCE(?3,'') LIMIT 1`,
    ).bind(levelId, kind, kind === "channel" ? body.targetId : null).first();
    if (duplicate) return Response.json({ error: "This entry is already in the level" }, { status: 409 });
    const position = Number((await env.DB.prepare(`SELECT COALESCE(MAX(position),-1)+1 AS position FROM alert_level_entries WHERE level_id=?1`)
      .bind(levelId).first<{ position: number }>())?.position ?? 0);
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO alert_level_entries(id,level_id,kind,target_id,repeat_interval_ms,position,created_at,updated_at)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?7)`,
    ).bind(id, levelId, kind, kind === "channel" ? body.targetId : null, kind === "channel" ? repeatIntervalMs : null, position, now).run();
    await audit(env.DB, actor, "alert_level_entry.create", id, { levelId, kind, targetId: body.targetId ?? null, repeatIntervalMs });
    return Response.json({ ok: true, entry: (await loadAlertLevels(env.DB)).find(level => level.id === levelId)?.entries.find(entry => entry.id === id) }, { status: 201 });
  }

  if (entryId && request.method === "PATCH") {
    const body = await request.json<{ repeatIntervalMs?: number | null; position?: number }>();
    if (body.repeatIntervalMs === undefined && body.position === undefined) return Response.json({ error: "No entry change supplied" }, { status: 400 });
    const current = await env.DB.prepare(`SELECT kind FROM alert_level_entries WHERE id=?1 AND level_id=?2 LIMIT 1`)
      .bind(entryId, levelId).first<{ kind: AlertEntryKind }>();
    if (!current) return Response.json({ error: "Alert level entry not found" }, { status: 404 });
    if (body.repeatIntervalMs !== undefined && (current.kind !== "channel" || !isRepeatInterval(body.repeatIntervalMs))) {
      return Response.json({ error: "Invalid repeat interval" }, { status: 400 });
    }
    const entries = (await loadAlertLevels(env.DB)).find(level => level.id === levelId)!.entries;
    const currentIndex = entries.findIndex(entry => entry.id === entryId);
    if (body.position !== undefined && (!Number.isInteger(body.position) || body.position < 0 || body.position >= entries.length)) {
      return Response.json({ error: "Entry position is outside the level" }, { status: 400 });
    }
    const now = Date.now();
    if (body.repeatIntervalMs !== undefined) {
      await env.DB.prepare(`UPDATE alert_level_entries SET repeat_interval_ms=?3,updated_at=?4 WHERE id=?1 AND level_id=?2`)
        .bind(entryId, levelId, body.repeatIntervalMs, now).run();
    }
    if (body.position !== undefined) {
      const [moved] = entries.splice(currentIndex, 1);
      entries.splice(body.position, 0, moved!);
      await writeEntryPositions(env.DB, entries.map(entry => entry.id), now);
    }
    await audit(env.DB, actor, "alert_level_entry.update", entryId, { levelId, ...body });
    return Response.json({ ok: true, entry: (await loadAlertLevels(env.DB)).find(level => level.id === levelId)?.entries.find(entry => entry.id === entryId) });
  }

  if (entryId && request.method === "DELETE") {
    const result = await env.DB.prepare(`DELETE FROM alert_level_entries WHERE id=?1 AND level_id=?2`).bind(entryId, levelId).run();
    if (Number(result.meta.changes ?? 0) === 0) return Response.json({ error: "Alert level entry not found" }, { status: 404 });
    await audit(env.DB, actor, "alert_level_entry.delete", entryId, { levelId });
    return Response.json({ ok: true, id: entryId });
  }

  return null;
}

export async function loadAlertLevels(db: D1Database): Promise<AlertLevel[]> {
  const [levels, entries] = await Promise.all([
    db.prepare(`SELECT id,position,label FROM alert_levels ORDER BY position,id`).all<{ id: string; position: number; label: string }>(),
    db.prepare(`SELECT id,level_id,kind,target_id,repeat_interval_ms,position FROM alert_level_entries ORDER BY level_id,position,id`)
      .all<{ id: string; level_id: string; kind: AlertEntryKind; target_id: string | null; repeat_interval_ms: number | null; position: number }>(),
  ]);
  const byLevel = new Map<string, AlertLevelEntry[]>();
  for (const row of entries.results) {
    const collection = byLevel.get(row.level_id) ?? [];
    collection.push({
      id: row.id, levelId: row.level_id, kind: row.kind, targetId: row.target_id,
      repeatIntervalMs: row.repeat_interval_ms == null ? null : Number(row.repeat_interval_ms), position: Number(row.position),
    });
    byLevel.set(row.level_id, collection);
  }
  return levels.results.map(row => ({
    id: row.id, position: Number(row.position), label: row.label, entries: byLevel.get(row.id) ?? [],
  }));
}

export function resolveEffectiveEntries(levels: AlertLevel[], firingPosition: number): EffectiveLevelConfiguration {
  const channels = new Map<string, { targetId: string; repeatIntervalMs: number | null }>();
  let prepareStop = false;
  let autoPause = false;
  let prepareQuarantine = false;
  let autoQuarantine = false;
  for (const level of [...levels].sort((left, right) => left.position - right.position)) {
    if (level.position > firingPosition) break;
    for (const entry of [...level.entries].sort((left, right) => left.position - right.position)) {
      if (entry.kind === "channel" && entry.targetId) channels.set(entry.targetId, { targetId: entry.targetId, repeatIntervalMs: entry.repeatIntervalMs });
      else if (entry.kind === "prepare_stop") prepareStop = true;
      else if (entry.kind === "auto_pause") autoPause = true;
      else if (entry.kind === "prepare_quarantine") prepareQuarantine = true;
      else if (entry.kind === "auto_quarantine") autoQuarantine = true;
    }
  }
  return {
    channels: [...channels.values()],
    stopOrPause: autoPause ? "auto" : prepareStop ? "prepare" : null,
    quarantine: autoQuarantine ? "auto" : prepareQuarantine ? "prepare" : null,
  };
}

export async function effectiveLevelConfiguration(db: D1Database, linePriority: number): Promise<EffectiveLevelConfiguration> {
  return resolveEffectiveEntries(await loadAlertLevels(db), Math.floor(linePriority / 10));
}

function normalizedLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && label.length <= 40 ? label : null;
}

function sameLabel(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function isRepeatInterval(value: number | null): boolean {
  return REPEAT_INTERVALS.includes(value as typeof REPEAT_INTERVALS[number]);
}

async function writeLevelPositions(db: D1Database, ids: string[], now: number): Promise<void> {
  await db.batch(ids.map((id, position) => db.prepare(`UPDATE alert_levels SET position=?2,updated_at=?3 WHERE id=?1`).bind(id, 10_000 + position, now)));
  await db.batch(ids.map((id, position) => db.prepare(`UPDATE alert_levels SET position=?2,updated_at=?3 WHERE id=?1`).bind(id, position, now)));
}

async function writeEntryPositions(db: D1Database, ids: string[], now: number): Promise<void> {
  await db.batch(ids.map((id, position) => db.prepare(`UPDATE alert_level_entries SET position=?2,updated_at=?3 WHERE id=?1`).bind(id, position, now)));
}

async function synchronizeLinePriorities(db: D1Database, levels: AlertLevel[], now: number): Promise<void> {
  if (!levels.length) return;
  await db.batch(levels.map((level, position) => db.prepare(
    `UPDATE alert_lines SET priority=?2,updated_at=?3 WHERE level_id=?1`,
  ).bind(level.id, position * 10, now)));
}

async function audit(db: D1Database, actor: string, action: string, target: string, detail: unknown): Promise<void> {
  await db.prepare(`INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?1,?2,?3,?4,?5,?6)`)
    .bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now()).run();
}
