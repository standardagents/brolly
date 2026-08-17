import { useEffect, useState } from "react";
import { api } from "../api";
import { Notice, Spinner } from "../components/ui";
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

/**
 * Sidebar import progress. Mounting it starts the initial ingestion, which runs
 * in the background. It shows two rows, usage (all products combined) and
 * billing, and renders nothing once the import is complete.
 */
export function ImportProgress({ token, billingConnected }: { token: string; billingConnected: boolean }) {
  const { ingestion, running, error } = useInitialIngestion(token);
  if (!ingestion || (!running && !error)) return null;
  const paused = isStoragePaused(ingestion.job?.status);
  const usage = combine("Usage", ingestion.collectors.filter(item => item.collector !== "billing"));
  const billing = billingConnected ? ingestion.collectors.find(item => item.collector === "billing") : undefined;

  return (
    <section className="mt-6 grid gap-3 border-t border-line pt-4 max-md:hidden" aria-label="Import progress" aria-live="polite">
      <strong className="text-[12.5px] text-muted">Importing 90 days of history</strong>
      <ImportCollectorRow collector={usage} paused={paused} />
      {billing && <ImportCollectorRow collector={{ ...billing, label: "Billing" }} paused={paused} />}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

function combine(label: string, collectors: InitialIngestionCollector[]): InitialIngestionCollector {
  return {
    ...collectors[0]!,
    collector: "usage",
    label,
    total: collectors.reduce((sum, item) => sum + item.total, 0),
    complete: collectors.reduce((sum, item) => sum + item.complete, 0),
    failed: collectors.reduce((sum, item) => sum + item.failed, 0),
  };
}

function ImportCollectorRow({ collector, paused }: { collector: InitialIngestionCollector; paused: boolean }) {
  const completed = Math.min(collector.total, Math.max(0, collector.complete));
  const failed = Math.max(0, collector.failed);
  const finished = completed + failed >= collector.total;
  const completeWithoutGaps = finished && failed === 0 && !paused;
  const percentage = collector.total ? Math.min(100, (completed / collector.total) * 100) : 0;
  const status = paused ? "Paused: storage" : !finished ? "Importing" : failed ? `${failed} ${failed === 1 ? "gap" : "gaps"}` : "Complete";
  const statusTone = paused || failed ? "text-warn" : completeWithoutGaps ? "text-good" : "text-muted";

  return (
    <article className="grid gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2"><strong className="text-[13px]">{collector.label}</strong>{!finished && !paused && <Spinner />}</span>
        <span className={`text-[11px] font-semibold ${statusTone}`}>{status}</span>
      </div>
      <div className="h-1.5 min-w-0 overflow-hidden rounded-full bg-line-soft" role="progressbar" aria-label={`${collector.label} import progress`} aria-valuemin={0} aria-valuemax={collector.total} aria-valuenow={completed}>
        <div className={`h-full rounded-full transition-[width] duration-500 ${paused ? "bg-warn" : completeWithoutGaps ? "bg-good" : "bg-orange"}`} style={{ width: `${percentage}%` }} />
      </div>
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

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
