import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type ChartScaleMode = "linear" | "logarithmic";

interface ChartScaleState {
  mode: ChartScaleMode;
  setMode(mode: ChartScaleMode): void;
}

const ChartScaleContext = createContext<ChartScaleState | null>(null);

export function ChartScaleProvider({ children, initialMode = "linear" }: { children: ReactNode; initialMode?: ChartScaleMode }) {
  const [mode, setMode] = useState<ChartScaleMode>(initialMode);
  const value = useMemo(() => ({ mode, setMode }), [mode]);
  return <ChartScaleContext.Provider value={value}>{children}</ChartScaleContext.Provider>;
}

/**
 * A daily/cycle pair shares a provider. Local state keeps an isolated chart
 * independently usable when it has no pair.
 */
export function useChartScaleMode(initialMode: ChartScaleMode = "linear"): ChartScaleState {
  const shared = useContext(ChartScaleContext);
  const [localMode, setLocalMode] = useState<ChartScaleMode>(initialMode);
  return shared ?? { mode: localMode, setMode: setLocalMode };
}

export function ChartScaleToggle({ mode, onChange }: { mode: ChartScaleMode; onChange(mode: ChartScaleMode): void }) {
  return (
    <div
      className="inline-flex h-7 items-center rounded-full border border-line-soft bg-panel-soft p-[3px] text-[10px] font-semibold"
      role="group"
      aria-label="Chart scale"
      data-chart-scale-toggle
    >
      {(["linear", "logarithmic"] as const).map(option => (
        <button
          key={option}
          type="button"
          // Selected Logarithmic gets the orange accent: it usually means the
          // data has large outliers worth noticing. Selected Linear stays quiet.
          className={`h-5 min-w-[48px] cursor-pointer rounded-full px-2 transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-orange ${mode === option
            ? option === "logarithmic" ? "bg-orange-soft font-bold text-orange-deep shadow-[inset_0_0_0_1px_var(--orange)]" : "bg-panel text-ink shadow-[0_1px_3px_#17202a24]"
            : "text-faint hover:text-ink"}`}
          aria-pressed={mode === option}
          onClick={() => onChange(option)}
        >
          {option === "linear" ? "Linear" : "Logarithmic"}
        </button>
      ))}
    </div>
  );
}
