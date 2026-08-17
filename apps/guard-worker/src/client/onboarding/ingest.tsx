import { useEffect, useState } from "react";
import { api } from "../api";
import type { InitialIngestionCollector, InitialIngestionResponse } from "../types";

export function useInitialIngestion(token: string) {
  const [ingestion, setIngestion] = useState<InitialIngestionResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;

    const readProgress = async () => {
      const next = await api<InitialIngestionResponse>("/api/onboarding/ingest", token);
      if (stopped) return;
      setIngestion(next);
      if (ingestionIsActive(next)) timer = window.setTimeout(() => void readProgress().catch(handleError), 2_000);
    };

    const start = async () => {
      try {
        await api("/api/onboarding/ingest", token, { method: "POST" });
      } catch (cause) {
        if (!stopped) setError(message(cause));
      }
      try {
        await readProgress();
      } catch (cause) {
        handleError(cause);
      }
    };

    const handleError = (cause: unknown) => {
      if (!stopped) setError(message(cause));
    };

    void start();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [token]);

  const running = ingestion ? ingestionIsActive(ingestion) : false;
  return { ingestion, running, error };
}

export function ImportHistoryStep({ token, billingConnected, onContinue }: {
  token: string;
  billingConnected: boolean;
  onContinue: () => void;
}) {
  const { ingestion, running, error } = useInitialIngestion(token);
  const collectors = ingestion?.collectors.filter(item => billingConnected || item.collector !== "billing") ?? [];

  return (
    <>
      <h2>Import history</h2>
      <p className="section-copy">Brolly imports the last 90 days of available usage and billing history from Cloudflare.</p>
      <div className="grid gap-3" aria-live="polite" aria-label="Import progress">
        {collectors.map(collector => <ImportCollectorRow key={collector.collector} collector={collector} paused={isStoragePaused(ingestion?.job?.status)} />)}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer className="setup-actions">
        <button type="button" className="button primary ml-auto shrink-0" onClick={onContinue}>{running ? "Continue in background" : "Continue"}</button>
      </footer>
    </>
  );
}

function ImportCollectorRow({ collector, paused }: { collector: InitialIngestionCollector; paused: boolean }) {
  const completed = Math.min(collector.total, Math.max(0, collector.complete));
  const failed = Math.max(0, collector.failed);
  const finished = completed + failed >= collector.total;
  const completeWithoutGaps = finished && failed === 0 && !paused;
  const percentage = collector.total ? Math.min(100, (completed / collector.total) * 100) : 0;
  const status = paused ? "Paused: storage" : !finished ? "Importing" : failed ? `${failed} ${failed === 1 ? "gap" : "gaps"}` : null;
  const statusTone = paused || failed ? "border-[var(--warn-line)] bg-[var(--warn-bg)] text-[var(--warn)]" : "border-[var(--line)] bg-[var(--panel-soft)] text-[var(--muted)]";

  return (
    <article className="grid gap-2 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">{collector.label}</strong>
        {status && <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${statusTone}`}>{status}</span>}
      </div>
      <div className="flex items-center gap-3">
        <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--line-soft)]" role="progressbar" aria-label={`${collector.label} import progress`} aria-valuemin={0} aria-valuemax={collector.total} aria-valuenow={completed}>
          <div className={`h-full rounded-full transition-[width] duration-500 ${paused ? "bg-[var(--warn)]" : completeWithoutGaps ? "bg-[var(--good)]" : "bg-[var(--orange)]"}`} style={{ width: `${percentage}%` }} />
        </div>
        <span className="shrink-0 text-xs font-semibold text-[var(--muted)]">{completed}/{collector.total}</span>
      </div>
      <span className="text-xs text-[var(--faint)]">{collector.oldestCompleteAt ? `${formatDate(collector.oldestCompleteAt)} through current` : "Import range pending"}</span>
    </article>
  );
}

function ingestionIsActive(response: InitialIngestionResponse): boolean {
  const status = response.job?.status;
  if (status !== "pending" && status !== "running") return false;
  return response.collectors.some(item => item.complete + item.failed < item.total);
}

function isStoragePaused(status: string | undefined): boolean {
  return status === "paused" || status === "paused_storage" || status === "storage_paused";
}

function formatDate(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
