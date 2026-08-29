import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon, Notice, Popover, Spinner } from "../components/ui";
import { useOutsideClose } from "../lib/outside-close";
import type { InitialIngestionDays, InitialIngestionResponse } from "../types";

const ACTIVE_POLL_MS = 5_000;

export function useInitialIngestion(token: string) {
  const [ingestion, setIngestion] = useState<InitialIngestionResponse | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let startComplete = false;
    let retryDelay = 2_000;

    const schedule = (delay: number) => {
      if (!stopped) timer = window.setTimeout(() => void readProgress(), delay);
    };

    const handleError = (cause: unknown) => {
      if (stopped) return;
      setError(message(cause));
      schedule(retryDelay);
      retryDelay = Math.min(30_000, retryDelay * 2);
    };

    const readProgress = async () => {
      try {
        const next = await api<InitialIngestionResponse>("/api/onboarding/ingest", token);
        if (stopped) return;
        setIngestion(next);
        setError("");
        retryDelay = 2_000;
        if (next.job || startComplete) setStarting(false);
        if (ingestionIsActive(next) || !startComplete) schedule(ACTIVE_POLL_MS);
      } catch (cause) {
        handleError(cause);
      }
    };

    void api("/api/onboarding/ingest", token, { method: "POST" })
      .catch(cause => {
        if (!stopped) setError(message(cause));
      })
      .finally(() => {
        startComplete = true;
        if (!stopped) setStarting(false);
      });
    void readProgress();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [token]);

  const running = ingestion ? ingestionIsActive(ingestion) : false;
  return { ingestion, running: running || starting, error };
}

/**
 * Sidebar import progress. The wizard owns the ingestion poller and passes its
 * response here. One 90-day row advances only when every available source for
 * a day is complete. Successful imports disappear; coverage gaps remain.
 */
export function ImportProgress({ ingestion, running, error, billingConnected }: {
  ingestion: InitialIngestionResponse | null;
  running: boolean;
  error: string;
  billingConnected: boolean;
}) {
  return <ImportProgressView ingestion={ingestion} running={running} error={error} billingConnected={billingConnected} />;
}

export function ImportProgressView({
  ingestion,
  running,
  error,
  billingConnected,
  now = Date.now(),
}: {
  ingestion: InitialIngestionResponse | null;
  running: boolean;
  error: string;
  billingConnected: boolean;
  now?: number;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasGaps = (ingestion?.days?.gaps ?? 0) > 0;
  if (!ingestion && !running && !error) return null;
  if (ingestion && !running && !error && !hasGaps) return null;
  const storagePaused = isStoragePaused(ingestion?.job?.status);
  const resumeAt = ingestion?.job?.resumeAt ?? null;
  const waiting = running && resumeAt !== null && resumeAt > now;
  const pacing = waiting && ingestion?.job?.waitReason === "pacing";
  const quotaWaiting = waiting && !pacing;
  const paused = storagePaused || quotaWaiting;
  const days = ingestion?.days ?? null;
  const planning = running && (!ingestion?.job || ingestion.job.status === "planning" || !days);
  const state = error ? "error" : quotaWaiting ? "rate_limited" : pacing ? "pacing" : planning ? "planning" : hasGaps && !running ? "complete_with_gaps" : "importing";
  const overall = ingestion && days ? initialIngestionOverallProgress(ingestion, now) : null;

  return (
    <section
      className="fixed bottom-6 left-1/2 z-50 grid w-[min(480px,calc(100vw-24px))] -translate-x-1/2 gap-2 rounded-panel border border-line bg-panel p-4 shadow-panel max-md:bottom-3"
      aria-label="Import progress"
      aria-live="polite"
      data-import-state={state}
      data-import-limiter-mode={ingestion?.job?.limiterMode}
      data-import-resume-at={resumeAt ?? undefined}
      data-import-query-units={ingestion?.job?.logicalQueryUnitsUsed}
      data-import-query-limit={ingestion?.job?.sharedQueryLimit}
      data-import-physical-requests={ingestion?.job?.physicalRequestsUsed}
      data-import-physical-limit={ingestion?.job?.physicalRequestLimit}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded text-left text-[12.5px] font-bold text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-orange"
          aria-expanded={detailsOpen}
          data-import-details-trigger
          onClick={() => setDetailsOpen(value => !value)}
        >
          <Icon name="chevron" className={`size-3.5 transition-transform ${detailsOpen ? "rotate-180" : "-rotate-90"}`} />
          {(planning || running) && !paused && <Spinner />}
          <span>{planning ? "Preparing 90-day history import" : "90-day history import"}</span>
          {waiting && (
            <span className="whitespace-nowrap text-[11px] font-normal tabular-nums text-muted">{pacing ? "Cloudflare pacing" : "Cloudflare wait"} {formatAdmissionWait(resumeAt - now)} · {overall?.estimatedRemainingMs ? formatRemainingTime(overall.estimatedRemainingMs) : formatRemainingTime(resumeAt - now)} total</span>
          )}
          {!waiting && overall?.estimatedRemainingMs !== null && overall?.estimatedRemainingMs !== undefined && (
            <span className="whitespace-nowrap text-[11px] font-normal tabular-nums text-muted">{formatRemainingTime(overall.estimatedRemainingMs)} remaining</span>
          )}
        </button>
        {days && overall && (
          <span className="flex items-center gap-2">
            {paused && <span className="inline-flex text-warn" aria-label="Import paused"><Icon name="pause" className="size-3.5" /></span>}
            {days.failedWindows > 0 && <ImportErrors days={days} />}
            <span className="text-[11px] tabular-nums text-muted">{overall.percentage}%</span>
          </span>
        )}
      </div>
      {days && overall && <ImportOverallBar days={days} overall={overall} paused={paused} />}
      {detailsOpen && ingestion && ingestion.collectors.length > 0 && (
        <ImportCollectorProgress collectors={ingestion.collectors} />
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

function ImportCollectorProgress({ collectors }: { collectors: InitialIngestionResponse["collectors"] }) {
  return (
    <div className="mt-1 grid max-h-[300px] gap-2 overflow-y-auto border-t border-line-soft pt-3" data-import-details>
      {collectors.map(collector => {
        const processedUnits = Math.min(collector.totalUnits, collector.completeUnits + collector.failedUnits);
        const percentage = collector.totalUnits > 0 ? Math.round(processedUnits / collector.totalUnits * 100) : 0;
        const processedWindows = collector.complete + collector.failed;
        return (
          <div key={collector.collector} className="grid gap-1" data-import-collector={collector.collector}>
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="min-w-0 truncate font-semibold text-ink">{collector.label}</span>
              <span className="whitespace-nowrap tabular-nums text-muted">{processedWindows}/{collector.total} windows · {percentage}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-line-soft" role="progressbar" aria-label={`${collector.label} import progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
              <div className={`h-full ${collector.failed > 0 ? "bg-warn" : percentage === 100 ? "bg-good" : "bg-orange"}`} style={{ width: `${percentage}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export interface InitialIngestionOverallProgress {
  percentage: number;
  estimatedRemainingMs: number | null;
  processedUnits: number;
  totalUnits: number;
}

/** Aggregate every planned source partition so progress moves before a whole day is complete. */
export function initialIngestionOverallProgress(
  ingestion: InitialIngestionResponse,
  now = Date.now(),
): InitialIngestionOverallProgress {
  let totalUnits = ingestion.collectors.reduce((total, collector) => total + collector.totalUnits, 0);
  let processedUnits = ingestion.collectors.reduce(
    (total, collector) => total + collector.completeUnits + collector.failedUnits,
    0,
  );
  if (totalUnits <= 0 && ingestion.days) {
    totalUnits = ingestion.days.total;
    processedUnits = Math.max(0, ingestion.days.total - ingestion.days.pending);
  }
  processedUnits = Math.min(totalUnits, processedUnits);
  const percentage = totalUnits > 0 ? Math.round((processedUnits / totalUnits) * 100) : 0;
  const remainingUnits = totalUnits - processedUnits;
  const startedAt = ingestion.job?.startedAt ?? now;
  const elapsedMs = Math.max(0, now - startedAt);
  const active = ingestion.job?.status === "planning" || ingestion.job?.status === "pending" || ingestion.job?.status === "running";
  const pendingRequests = ingestion.collectors.reduce((total, collector) => total + collector.pending, 0);
  const queryIntervalMs = Math.max(1, ingestion.job?.queryIntervalMs ?? 1_000);
  const waitMs = Math.max(0, (ingestion.job?.resumeAt ?? now) - now);
  const pacingFloorMs = waitMs + Math.max(0, pendingRequests - (waitMs > 0 ? 1 : 0)) * queryIntervalMs;
  const observedRemainingMs = elapsedMs >= 10_000 && processedUnits > 0 && remainingUnits > 0
    ? elapsedMs * remainingUnits / processedUnits
    : 0;
  const estimatedRemainingMs = active && remainingUnits > 0 && (pendingRequests > 0 || observedRemainingMs > 0)
    ? Math.max(pacingFloorMs, observedRemainingMs)
    : null;
  return { percentage, estimatedRemainingMs, processedUnits, totalUnits };
}

export function formatRemainingTime(milliseconds: number): string {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `~${hours} hr`;
}

function formatAdmissionWait(milliseconds: number): string {
  if (milliseconds < 60_000) return `~${Math.max(1, Math.ceil(milliseconds / 1_000))} sec`;
  return formatRemainingTime(milliseconds);
}

function ImportOverallBar({ days, overall, paused }: {
  days: InitialIngestionDays;
  overall: InitialIngestionOverallProgress;
  paused: boolean;
}) {
  const finished = days.pending === 0;
  const incomplete = finished && days.complete < days.total;

  return (
    <div className="h-1.5 min-w-0 overflow-hidden rounded-full bg-line-soft" role="progressbar" aria-label="Account history import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overall.percentage} aria-valuetext={`${overall.percentage}% of the 90-day import processed`} data-import-days={days.complete} data-import-progress={overall.percentage} data-import-errors={days.failedWindows}>
      <div className={`h-full transition-[width] duration-500 ${paused || incomplete ? "bg-warn" : finished ? "bg-good" : "bg-orange"}`} style={{ width: `${overall.percentage}%` }} />
    </div>
  );
}

function ImportErrors({ days }: { days: InitialIngestionDays }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useOutsideClose([anchor, panel], open, () => setOpen(false));

  return (
    <span ref={anchor} className="inline-flex">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums text-warn hover:bg-warn-bg focus-visible:outline-2 focus-visible:outline-warn"
        aria-label={`${days.failedWindows} import errors`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-import-error-trigger
        onClick={() => setOpen(value => !value)}
      >
        <Icon name="alert" className="size-3.5" />
        {days.failedWindows}
      </button>
      <Popover anchor={anchor} open={open} side="top" align="end">
        <div ref={panel} role="dialog" aria-label="Account history import errors" className="w-[min(300px,calc(100vw-24px))] rounded-panel border border-line bg-panel p-3 shadow-panel">
          <strong className="block text-[12px] text-ink">{days.failedWindows} unavailable import {days.failedWindows === 1 ? "window" : "windows"}</strong>
          {days.errors.length > 0 && (
            <ul className="mt-2 grid gap-1.5 text-[11px] leading-4 text-muted">
              {days.errors.map(item => <li key={item}>{item}</li>)}
            </ul>
          )}
        </div>
      </Popover>
    </span>
  );
}

function ingestionIsActive(response: InitialIngestionResponse): boolean {
  const status = response.job?.status;
  if (status === "planning") return true;
  if (status !== "pending" && status !== "running") return false;
  return !response.days || response.days.pending > 0;
}

function isStoragePaused(status: string | undefined): boolean {
  return status === "paused" || status === "paused_storage" || status === "storage_paused";
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
