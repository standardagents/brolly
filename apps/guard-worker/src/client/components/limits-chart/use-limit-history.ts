import { useCallback, useRef, useState } from "react";
import type { LevelValues } from "./levels";

const MAX_ENTRIES = 50;

export interface LimitHistory {
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

/**
 * In-memory, per-chart history for completed level maps.
 *
 * The first value is the completed map from the chart. Keeping snapshots as
 * copies prevents later parent updates from mutating the history timeline.
 */
export function useLimitHistory(value: LevelValues): LimitHistory {
  const [state, setState] = useState<HistoryState>(() => ({ entries: [copy(value)], index: 0 }));
  const stateRef = useRef(state);
  stateRef.current = state;

  const record = useCallback((next: LevelValues) => {
    const current = stateRef.current;
    const snapshot = copy(next);
    const present = current.entries[current.index];
    if (present && same(present, snapshot)) return;
    const entries = [...current.entries.slice(0, current.index + 1), snapshot];
    const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
    const nextState = { entries: trimmed, index: trimmed.length - 1 };
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const undo = useCallback(() => {
    const current = stateRef.current;
    if (current.index <= 0) return null;
    const index = current.index - 1;
    const nextState = { ...current, index };
    stateRef.current = nextState;
    setState(nextState);
    return copy(current.entries[index]!);
  }, []);

  const redo = useCallback(() => {
    const current = stateRef.current;
    if (current.index >= current.entries.length - 1) return null;
    const index = current.index + 1;
    const nextState = { ...current, index };
    stateRef.current = nextState;
    setState(nextState);
    return copy(current.entries[index]!);
  }, []);

  return {
    record,
    undo,
    redo,
    canUndo: state.index > 0,
    canRedo: state.index < state.entries.length - 1,
  };
}
