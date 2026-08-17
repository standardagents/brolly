import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, Notice, Spinner } from "../components/ui";
import type { InitialIngestionCollector, InitialIngestionResponse } from "../types";
import { StepActions, StepIntro } from "./BudgetSteps";

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
      <StepIntro title="Import history">Brolly imports the last 90 days of available usage and billing history from Cloudflare.</StepIntro>
      <div className="grid gap-3" aria-live="polite" aria-label="Import progress">
        {collectors.map(collector => <ImportCollectorRow key={collector.collector} collector={collector} paused={isStoragePaused(ingestion?.job?.status)} />)}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <StepActions>
        <Button variant="primary" className="ml-auto shrink-0" onClick={onContinue}>{running ? "Continue in background" : "Continue"}</Button>
      </StepActions>
    </>
  );
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
    <article className="grid gap-2 rounded-panel border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2"><strong className="text-sm">{collector.label}</strong>{!finished && !paused && <Spinner />}</span>
        <span className={`text-xs font-semibold ${statusTone}`}>{status}</span>
      </div>
      <div className="h-2 min-w-0 overflow-hidden rounded-full bg-line-soft" role="progressbar" aria-label={`${collector.label} import progress`} aria-valuemin={0} aria-valuemax={collector.total} aria-valuenow={completed}>
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
