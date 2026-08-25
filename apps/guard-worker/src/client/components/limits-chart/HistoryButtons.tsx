import type { LimitHistory } from "./use-limit-history";

/** Undo, redo, and reset controls shared by charts and level-track panels. */
export function HistoryButtons({ history, canReset, onReset, onUndo, onRedo }: { history: LimitHistory; canReset: boolean; onReset(): void; onUndo(): void; onRedo(): void }) {
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label="Chart history">
      {canReset && <button
        type="button"
        data-action="reset-tolerance"
        className="h-7 cursor-pointer rounded border border-line bg-panel px-2 text-[10.5px] font-bold text-muted hover:border-[#b7bfc8] hover:text-ink focus-visible:outline-2 focus-visible:outline-orange"
        onClick={onReset}
      >Reset to tolerance</button>}
      <button
        type="button"
        className="grid size-7 cursor-pointer place-items-center rounded border border-line bg-panel text-muted hover:border-[#b7bfc8] hover:text-ink focus-visible:outline-2 focus-visible:outline-orange disabled:cursor-default disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
        data-action="undo"
        aria-label="Undo last limit change"
        title="Undo (Cmd/Ctrl+Z)"
        disabled={!history.canUndo}
        onClick={onUndo}
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 7 4 12l5 5" /><path d="M5 12h8a6 6 0 0 1 6 6" />
        </svg>
      </button>
      <button
        type="button"
        className="grid size-7 cursor-pointer place-items-center rounded border border-line bg-panel text-muted hover:border-[#b7bfc8] hover:text-ink focus-visible:outline-2 focus-visible:outline-orange disabled:cursor-default disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
        data-action="redo"
        aria-label="Redo limit change"
        title="Redo (Cmd/Ctrl+Shift+Z)"
        disabled={!history.canRedo}
        onClick={onRedo}
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 7 5 5-5 5" /><path d="M19 12h-8a6 6 0 0 0-6 6" />
        </svg>
      </button>
    </div>
  );
}

