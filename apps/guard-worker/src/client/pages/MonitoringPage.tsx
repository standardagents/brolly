import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { dataSize, dateTime, money, number, relativeTime } from "../format";
import type { CollectorCapabilityView, CollectorStateView, LedgerRunLimitsView, MonitoringDailyView, MonitorRunView } from "../types";
import { EmptyState, Icon } from "../components/ui";

export function MonitoringPage({ token }: { token: string }) {
  const [daily, setDaily] = useState<MonitoringDailyView[]>([]);
  const [runs, setRuns] = useState<MonitorRunView[]>([]);
  const [capabilities, setCapabilities] = useState<CollectorCapabilityView[]>([]);
  const [collectors, setCollectors] = useState<CollectorStateView[]>([]);
  const [limits, setLimits] = useState<LedgerRunLimitsView | null>(null);
  const [hardMaximums, setHardMaximums] = useState<LedgerRunLimitsView | null>(null);
  const [savingLimits, setSavingLimits] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [cost, coverage] = await Promise.all([
      api<{
        daily: MonitoringDailyView[]; runs: MonitorRunView[];
        limits: LedgerRunLimitsView; hardMaximums: LedgerRunLimitsView;
      }>("/api/monitoring-cost", token),
      api<{ capabilities: CollectorCapabilityView[]; collectors: CollectorStateView[] }>("/api/coverage", token),
    ]);
    setDaily(cost.daily);
    setRuns(cost.runs);
    setLimits(cost.limits);
    setHardMaximums(cost.hardMaximums);
    setCapabilities(coverage.capabilities);
    setCollectors(coverage.collectors);
  }, [token]);

  useEffect(() => { void load().catch(cause => setError(message(cause))); }, [load]);
  const today = daily[0];
  const latest = runs[0];
  const monthlyEstimate = daily.reduce((sum, item) => sum + item.estimatedCostUsd, 0) / Math.max(1, daily.length) * 30;

  async function saveLimits(event: React.FormEvent) {
    event.preventDefault();
    if (!limits) return;
    setSavingLimits(true);
    setError("");
    try {
      const result = await api<{ limits: LedgerRunLimitsView }>("/api/monitoring-limits", token, {
        method: "PUT", body: JSON.stringify(limits),
      });
      setLimits(result.limits);
    } catch (cause) { setError(message(cause)); } finally { setSavingLimits(false); }
  }

  return (
    <div className="grid gap-4">
      <section className="stat-row" aria-label="Monitoring cost">
        <article className="stat-tile neutral"><span className="stat-label">GraphQL queries</span><strong>{today ? number(today.graphqlQueries) : "Pending"}</strong><small>{today ? `${number(today.graphqlQueryBudget)} cumulative run budget` : "Accounting pending"}</small></article>
        <article className="stat-tile neutral"><span className="stat-label">REST requests</span><strong>{today ? number(today.restRequests) : "Pending"}</strong><small>{today ? `${number(today.restRequestBudget)} cumulative run budget` : "Accounting pending"}</small></article>
        <article className="stat-tile neutral"><span className="stat-label">D1 operations</span><strong>{today ? number(today.d1RowsRead + today.d1RowsWritten) : "Pending"}</strong><small>{today ? `${number(today.d1RowsRead)} read · ${number(today.d1RowsWritten)} written` : "Accounting pending"}</small></article>
        <article className="stat-tile neutral"><span className="stat-label">Monthly estimate</span><strong>{money(monthlyEstimate)}</strong><small>Derived from recorded Brolly run usage</small></article>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Collection accounting</p>
            <h2>Recent bounded runs</h2>
            <p className="panel-sub">Run records preserve request counts, D1 work, coverage, continuation state, and errors.</p>
          </div>
          {latest && <span className="estimate-pill">{latest.status} · {relativeTime(latest.startedAt)}</span>}
        </div>
        {runs.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Started</th><th>Kind</th><th>Coverage</th><th>GraphQL</th><th>REST</th><th>D1 rows</th><th>Normalized</th><th>Duration</th></tr></thead>
              <tbody>{runs.map(run => (
                <tr key={run.id}>
                  <td>{dateTime(run.startedAt)}</td>
                  <td>{run.kind.replaceAll("_", " ")}</td>
                  <td><span className={`action-state ${run.coverageStatus === "complete" ? "good" : "warning"}`}>{run.coverageStatus}</span></td>
                  <td className="numeric">{number(run.graphqlQueries)}</td>
                  <td className="numeric">{number(run.restRequests)}</td>
                  <td className="numeric">{number(run.d1RowsRead + run.d1RowsWritten)}</td>
                  <td className="numeric">{number(run.samplesNormalized)}</td>
                  <td>{run.durationMs == null ? "Running" : `${number(run.durationMs)} ms`}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <EmptyState icon="pulse" title="Run accounting is pending">The next scheduled or explicit scan creates the first monitor record.</EmptyState>}
      </section>

      {limits && hardMaximums && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Safety ceilings</p>
              <h2>Per-run collection limits</h2>
              <p className="panel-sub">Each scan stops or defers work when it reaches a configured ceiling. Product hard maximums constrain every saved value.</p>
            </div>
          </div>
          <form className="grid gap-4 p-5 pt-0" onSubmit={saveLimits}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(Object.keys(LIMIT_LABELS) as Array<keyof LedgerRunLimitsView>).map(key => (
                <label className="grid gap-1 text-xs text-[var(--muted)]" key={key}>
                  <span>{LIMIT_LABELS[key]}</span>
                  <input
                    className="min-h-10 rounded border border-[var(--line)] px-3 text-sm text-[var(--ink)]"
                    type="number"
                    min="1"
                    max={hardMaximums[key]}
                    step="1"
                    value={limits[key]}
                    onChange={event => setLimits(current => current ? { ...current, [key]: Number(event.target.value) } : current)}
                  />
                  <small className="text-[var(--faint)]">Hard maximum {number(hardMaximums[key])}</small>
                </label>
              ))}
            </div>
            <button className="button primary w-max" disabled={savingLimits} type="submit">{savingLimits ? "Saving…" : "Save collection limits"}</button>
          </form>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Collector coverage</p>
            <h2>Datasets and retention</h2>
            <p className="panel-sub">Unavailable products remain visible. Billing catchalls preserve authoritative lines while detailed attribution is unavailable.</p>
          </div>
          <span className="count-badge">{capabilities.filter(item => item.available).length}/{capabilities.length} available</span>
        </div>
        <div className="coverage-grid">
          {capabilities.map(item => (
            <article className="coverage-family p-3" key={`${item.collectorKey}:${item.dataset}`}>
              <header className="flex items-start justify-between gap-3">
                <span className="cell-main"><strong>{item.dataset}</strong><small>{item.collectorKey} · {item.finestScope}</small></span>
                <span className={`coverage-state ${item.available ? "healthy" : "pending"}`}>{item.state}</span>
              </header>
              <p className="mt-2 text-xs leading-5 text-[var(--muted)]">{item.humanExplanation}</p>
              <small className="mt-2 block text-[var(--faint)]">{item.retentionDays == null ? "Retention unavailable" : `${item.retentionDays} days retained`}{item.watermarkAt ? ` · watermark ${relativeTime(item.watermarkAt)}` : ""}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>Scheduler state</h2><p className="panel-sub">Persisted high-water marks and continuation cursors allow interrupted collectors to resume.</p></div></div>
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Collector</th><th>Status</th><th>Watermark</th><th>Next eligible</th><th>Retries</th><th>Error</th></tr></thead>
            <tbody>{collectors.map(item => (
              <tr key={`${item.collectorKey}:${item.partitionKey}`}>
                <td><strong>{item.collectorKey}</strong></td>
                <td>{item.status}</td>
                <td>{item.highWatermarkAt ? dateTime(item.highWatermarkAt) : "Pending"}</td>
                <td>{dateTime(item.nextEligibleAt)}</td>
                <td className="numeric">{item.retryCount}</td>
                <td>{item.lastError ?? "None"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {today?.storageBytes != null && <footer className="panel-foot"><Icon name="info" /><span>D1 storage {dataSize(today.storageBytes)} of {today.storageCapacityBytes ? dataSize(today.storageCapacityBytes) : "configured capacity"}</span></footer>}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

const LIMIT_LABELS: Record<keyof LedgerRunLimitsView, string> = {
  graphqlQueries: "GraphQL queries",
  restRequests: "REST requests",
  d1RowsRead: "D1 rows read",
  d1RowsWritten: "D1 rows written",
  pagesPerDataset: "Pages across datasets",
  resourcesPerTransaction: "Resources per transaction",
  retries: "Retries",
  backfillSlices: "Backfill slices",
  wallMs: "Wall time (ms)",
};

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
