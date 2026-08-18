import { useCallback, useRef, useState } from "react";
import type { LevelValues } from "./levels";

const MAX_ENTRIES = 50;

export interface LimitHistory {
  /** First snapshot, applied only when this history is still empty. */
  seed(values: LevelValues): void;
  record(next: LevelValues): void;
  undo(): LevelValues | null;
  redo(): LevelValues | null;
  canUndo: boolean;
  canRedo: boolean;
}

interface HistoryState {
  entries: LevelValues[];
  index: number;
}

function copy(values: LevelValues): LevelValues {
  return { ...values };
}

function same(a: LevelValues, b: LevelValues): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every(key => a[key] === b[key]);
}

function recordInto(current: HistoryState, next: LevelValues): HistoryState {
  const snapshot = copy(next);
  const present = current.entries[current.index];
  if (present && same(present, snapshot)) return current;
  const entries = [...current.entries.slice(0, current.index + 1), snapshot];
  const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
  return { entries: trimmed, index: trimmed.length - 1 };
}

/**
 * In-memory undo/redo store for level maps, keyed by chart id, that lives in
 * the parent so a chart's history survives its row collapsing. `history(id)`
 * hands out a stable handle whose `canUndo`/`canRedo` reflect the current
 * state at render time.
 */
export function useLimitHistories(): (id: string) => LimitHistory {
  const store = useRef(new Map<string, HistoryState>());
  const [, bump] = useState(0);
  const update = useCallback((id: string, next: HistoryState) => {
    if (store.current.get(id) === next) return;
    store.current.set(id, next);
    bump(value => value + 1);
  }, []);
  return useCallback((id: string): LimitHistory => {
    const state = store.current.get(id) ?? { entries: [], index: -1 };
    return {
      seed(values) {
        if (state.entries.length) return;
        update(id, { entries: [copy(values)], index: 0 });
      },
      record(next) {
        const current = store.current.get(id) ?? { entries: [], index: -1 };
        update(id, current.entries.length ? recordInto(current, next) : { entries: [copy(next)], index: 0 });
      },
      undo() {
        const current = store.current.get(id);
        if (!current || current.index <= 0) return null;
        const index = current.index - 1;
        update(id, { ...current, index });
        return copy(current.entries[index]!);
      },
      redo() {
        const current = store.current.get(id);
        if (!current || current.index >= current.entries.length - 1) return null;
        const index = current.index + 1;
        update(id, { ...current, index });
        return copy(current.entries[index]!);
      },
      canUndo: state.index > 0,
      canRedo: state.index < state.entries.length - 1,
    };
  }, [update]);
}

/** Single-chart history for charts used without a parent store. `initial` seeds the first entry. */
export function useLimitHistory(initial?: LevelValues): LimitHistory {
  const history = useLimitHistories()("self");
  if (initial && !history.canUndo && !history.canRedo) history.seed(initial);
  return history;
}
