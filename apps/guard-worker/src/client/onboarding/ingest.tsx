import { useEffect, useState } from "react";
import { api } from "../api";
import { Notice, Spinner } from "../components/ui";
import type { InitialIngestionCollector, InitialIngestionResponse } from "../types";

export function useInitialIngestion(token: string) {
  const [ingestion, setIngestion] = useState<InitialIngestionResponse | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let startComplete = false;

    const readProgress = async () => {
      const next = await api<InitialIngestionResponse>("/api/onboarding/ingest", token);
      if (stopped) return;
      setIngestion(next);
      if (next.job || startComplete) setStarting(false);
      if (ingestionIsActive(next) || !startComplete) {
        timer = window.setTimeout(() => void readProgress().catch(handleError), 2_000);
      }
    };

    const handleError = (cause: unknown) => {
      if (!stopped) setError(message(cause));
    };

    void api("/api/onboarding/ingest", token, { method: "POST" })
      .catch(handleError)
      .finally(() => {
        startComplete = true;
        if (!stopped) setStarting(false);
      });
    void readProgress().catch(handleError);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [token]);

  const running = ingestion ? ingestionIsActive(ingestion) : false;
  return { ingestion, running: running || starting, error };
}

/**
 * Sidebar import progress. Mounting it starts the initial ingestion, which runs
 * in the background. It shows two rows, usage (all products combined) and
 * billing. Successful imports disappear; completed coverage gaps remain visible.
 */
export function ImportProgress({ token, billingConnected }: { token: string; billingConnected: boolean }) {
  const { ingestion, running, error } = useInitialIngestion(token);
  return <ImportProgressView ingestion={ingestion} running={running} error={error} billingConnected={billingConnected} />;
}

export function ImportProgressView({
  ingestion,
  running,
  error,
  billingConnected,
}: {
  ingestion: InitialIngestionResponse | null;
  running: boolean;
  error: string;
  billingConnected: boolean;
}) {
  const hasGaps = ingestion?.collectors.some(item => item.failedUnits > 0) ?? false;
  if (!ingestion && !running && !error) return null;
  if (ingestion && !running && !error && !hasGaps) return null;
  const paused = isStoragePaused(ingestion?.job?.status);
  const usage = combine("Usage", ingestion?.collectors.filter(item => item.collector !== "billing") ?? []);
  const billing = billingConnected ? ingestion?.collectors.find(item => item.collector === "billing") : undefined;
  const planning = running && (!ingestion?.job || ingestion.job.status === "planning" || ingestion.collectors.length === 0);
  const state = error ? "error" : planning ? "planning" : hasGaps && !running ? "complete_with_gaps" : "importing";

  return (
    <section className="grid w-[240px] gap-2 max-md:hidden" aria-label="Import progress" aria-live="polite" data-import-state={state}>
      <strong className="flex items-center gap-2 text-[12.5px] text-muted">
        {planning && <Spinner />}
        {planning ? "Preparing history import" : "Account history import"}
      </strong>
      {!planning && usage.total > 0 && <ImportCollectorRow collector={usage} paused={paused} />}
      {billing && <ImportCollectorRow collector={{ ...billing, label: "Billing" }} paused={paused} />}
      {hasGaps && <p className="text-[10px] leading-4 text-warn">Some history is unavailable. The completed portions remain usable.</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

function combine(label: string, collectors: InitialIngestionCollector[]): InitialIngestionCollector {
  return {
    collector: "usage",
    label,
    total: collectors.reduce((sum, item) => sum + item.total, 0),
    complete: collectors.reduce((sum, item) => sum + item.complete, 0),
    failed: collectors.reduce((sum, item) => sum + item.failed, 0),
    pending: collectors.reduce((sum, item) => sum + item.pending, 0),
    totalUnits: collectors.reduce((sum, item) => sum + item.totalUnits, 0),
    completeUnits: collectors.reduce((sum, item) => sum + item.completeUnits, 0),
    failedUnits: collectors.reduce((sum, item) => sum + item.failedUnits, 0),
    oldestCompleteAt: collectors.reduce<number | null>((oldest, item) => {
      const value = timestamp(item.oldestCompleteAt);
      return value === null ? oldest : Math.min(oldest ?? value, value);
    }, null),
    errors: [...new Set(collectors.flatMap(item => item.errors))].slice(0, 3),
  };
}

function ImportCollectorRow({ collector, paused }: { collector: InitialIngestionCollector; paused: boolean }) {
  const completed = Math.min(collector.totalUnits, Math.max(0, collector.completeUnits));
  const failed = Math.min(collector.totalUnits - completed, Math.max(0, collector.failedUnits));
  const processed = completed + failed;
  const finished = collector.pending === 0;
  const completeWithoutGaps = finished && failed === 0 && !paused;
  const percentage = collector.totalUnits ? Math.min(100, (completed / collector.totalUnits) * 100) : 0;
  const failedPercentage = collector.totalUnits ? Math.min(100 - percentage, (failed / collector.totalUnits) * 100) : 0;
  const checkedPercentage = collector.totalUnits ? Math.min(100, (processed / collector.totalUnits) * 100) : 0;
  const status = paused ? "Paused: storage" : !finished ? `${Math.floor(checkedPercentage)}% checked` : failed ? `${formatUnits(failed)} unavailable` : "Complete";
  const statusTone = paused || failed ? "text-warn" : completeWithoutGaps ? "text-good" : "text-muted";
  const unit = collector.collector === "billing" ? "days" : "source-days";

  return (
    <article className="grid gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2"><strong className="text-[13px]">{collector.label}</strong>{!finished && !paused && <Spinner />}</span>
        <span className={`text-[11px] font-semibold ${statusTone}`}>{status}</span>
      </div>
      <div className="flex h-1.5 min-w-0 overflow-hidden rounded-full bg-line-soft" role="progressbar" aria-label={`${collector.label} import progress`} aria-valuemin={0} aria-valuemax={collector.totalUnits} aria-valuenow={processed} aria-valuetext={`${formatUnits(completed)} imported, ${formatUnits(failed)} unavailable, ${formatUnits(Math.max(0, collector.totalUnits - processed))} remaining`} data-import-complete={completed} data-import-failed={failed}>
        <div className={`h-full transition-[width] duration-500 ${paused ? "bg-warn" : completeWithoutGaps ? "bg-good" : "bg-orange"}`} style={{ width: `${percentage}%` }} />
        {failed > 0 && <div className="h-full bg-warn transition-[width] duration-500" style={{ width: `${failedPercentage}%` }} />}
      </div>
      <span className="text-[9.5px] tabular-nums text-faint">{formatUnits(completed)} / {formatUnits(collector.totalUnits)} {unit} imported{failed > 0 ? ` · ${formatUnits(failed)} unavailable` : ""}</span>
    </article>
  );
}

function formatUnits(value: number): string {
  return Math.round(value).toLocaleString();
}

function ingestionIsActive(response: InitialIngestionResponse): boolean {
  const status = response.job?.status;
  if (status === "planning") return true;
  if (status !== "pending" && status !== "running") return false;
  return response.collectors.length === 0 || response.collectors.some(item => item.pending > 0);
}

function isStoragePaused(status: string | undefined): boolean {
  return status === "paused" || status === "paused_storage" || status === "storage_paused";
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function timestamp(value: string | number | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
