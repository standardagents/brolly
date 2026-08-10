import type { Evaluation, Incident } from "./types.js";

export function upsertIncident(existing: Incident | undefined, evaluation: Evaluation, now = Date.now()): Incident {
  if (!existing) {
    return { ...evaluation, id: crypto.randomUUID(), firstSeen: now, lastSeen: now, occurrences: 1, status: "open" };
  }
  return {
    ...existing,
    ...evaluation,
    id: existing.id,
    firstSeen: existing.firstSeen,
    lastSeen: now,
    occurrences: existing.occurrences + 1,
    status: existing.status === "resolved" ? "open" : existing.status,
  };
}

export function shouldNotify(previous: Incident | undefined, next: Incident, minimumIntervalMs = 15 * 60_000): boolean {
  if (!previous) return true;
  if (previous.severity !== next.severity) return true;
  return next.lastSeen - previous.lastSeen >= minimumIntervalMs;
}
