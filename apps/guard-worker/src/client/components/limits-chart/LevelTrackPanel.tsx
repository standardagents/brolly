import type { ReactNode } from "react";
import { LevelTrack } from "./LevelTrack";
import { HistoryButtons, type LimitsChartLevel } from "./LimitsChart";
import type { LevelValues } from "./levels";
import type { LimitHistory } from "./use-limit-history";

/**
 * A level track with the same undo, redo, and reset controls a chart has,
 * for scopes that have no usage history to plot. Always open: there is no
 * chart to reveal, so the track is the whole row.
 */
export function LevelTrackPanel({ title, levels, unit, value, onChange, history, resetTo, readOnly = false, headerContent }: {
  title?: string;
  levels: LimitsChartLevel[];
  unit: string;
  value: LevelValues;
  onChange(next: LevelValues): void;
  history: LimitHistory;
  /** The baseline map the reset action restores; no reset control without it. */
  resetTo?: LevelValues;
  readOnly?: boolean;
  headerContent?: ReactNode;
}) {
  const order = levels.map(level => level.id);
  const canReset = !!resetTo && order.some(id => resetTo[id] !== value[id]);
  const commit = (next: LevelValues) => {
    history.seed(value);
    history.record(next);
    onChange(next);
  };
  const step = (direction: "undo" | "redo") => {
    const next = direction === "undo" ? history.undo() : history.redo();
    if (next) onChange(next);
  };
  const reset = () => {
    if (!resetTo) return;
    history.seed(value);
    history.record(resetTo);
    onChange(resetTo);
  };
  return (
    <div className="min-w-0" data-level-track-panel>
      {(title || headerContent || !readOnly) && (
        <div className="mb-2 flex min-h-[30px] flex-wrap items-center justify-between gap-2">
          {title ? <h4 className="text-[13px] font-bold">{title}</h4> : <span />}
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {!readOnly && <HistoryButtons history={history} canReset={canReset} onReset={reset} onUndo={() => step("undo")} onRedo={() => step("redo")} />}
            {headerContent}
          </div>
        </div>
      )}
      <LevelTrack levels={levels} unit={unit} value={value} onChange={commit} readOnly={readOnly} />
    </div>
  );
}
