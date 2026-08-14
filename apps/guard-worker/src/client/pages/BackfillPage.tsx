import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { dataSize, dateTime, number } from "../format";
import type { BackfillJobView, BackfillSliceView, RetentionView } from "../types";
import { EmptyState, Icon } from "../components/ui";

export function BackfillPage({ token }: { token: string }) {
  const [jobs, setJobs] = useState<BackfillJobView[]>([]);
  const [slices, setSlices] = useState<BackfillSliceView[]>([]);
  const [retention, setRetention] = useState<RetentionView | null>(null);
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [backfill, retentionResult] = await Promise.all([
      api<{ jobs: BackfillJobView[]; slices: BackfillSliceView[] }>("/api/backfill", token),
      api<RetentionView>("/api/retention", token),
    ]);
    setJobs(backfill.jobs);
    setSlices(backfill.slices);
    setRetention(retentionResult);
  }, [token]);

  useEffect(() => { void load().catch(cause => setError(message(cause))); }, [load]);

  async function create() {
    setBusy(true);
    setError("");
    try {
      const endsAt = Date.now();
      await api("/api/backfill", token, {
        method: "POST",
        body: JSON.stringify({ startsAt: endsAt - Number(days) * 86_400_000, endsAt }),
      });
      await load();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  const pressure = retention?.pressure == null ? 0 : retention.pressure;
  return (
    <div className="grid gap-4">
      <section className="stat-row">
        <article className="stat-tile neutral"><span className="stat-label">Target retention</span><strong>{retention?.targetRetentionDays ?? 730} days</strong><small>Account, product, and namespace aggregates are always preserved</small></article>
        <article className={`stat-tile ${pressure >= .9 ? "danger" : pressure >= .7 ? "warning" : "good"}`}><span className="stat-label">D1 capacity</span><strong>{retention ? `${number(pressure * 100)}%` : "Pending"}</strong><small>{retention ? `${dataSize(retention.projectedBytes)} projected of ${dataSize(retention.capacityBytes)}` : "Capacity check pending"}</small></article>
        <article className="stat-tile neutral"><span className="stat-label">Oldest resource day</span><strong>{retention?.oldestResourceDay ?? "Pending"}</strong><small>High-cardinality individual-resource history</small></article>
        <article className="stat-tile neutral"><span className="stat-label">Pending slices</span><strong>{retention?.backfillPending ?? 0}</strong><small>Newest slices run from unused collection budget</small></article>
      </section>

      {pressure >= .7 && (
        <div className={`inline-note ${pressure >= .9 ? "warning" : ""}`}>
          <Icon name="alert" />
          <span>{pressure >= .9
            ? "D1 capacity crossed 90%. Brolly prunes the oldest individual-resource days toward 80% while retaining aggregate history, current state, alerts, actions, audit, and billing records."
            : pressure >= .8
              ? "D1 capacity crossed 80%. Historical backfill is paused until pressure falls below the safety threshold."
              : "D1 capacity crossed 70%. Review projected retention and consider a paid D1 plan for high-cardinality history."}</span>
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Newest first</p>
            <h2>Historical backfill</h2>
            <p className="panel-sub">Backfill uses only request, wall-time, and D1 budget left after active safeguards. Historical breaches can populate charts and instances; delivery and control execution stay disabled.</p>
          </div>
          <div className="flex gap-2">
            <select className="rounded border border-[var(--line)] bg-white px-3 text-sm" value={days} onChange={event => setDays(event.target.value)}>
              <option value="1">Previous 24 hours</option><option value="30">Previous 30 days</option><option value="90">Previous 90 days</option><option value="365">Previous year</option><option value="730">Previous two years</option>
            </select>
            <button className="button primary" disabled={busy} type="button" onClick={() => void create()}>{busy ? "Scheduling…" : "Schedule backfill"}</button>
          </div>
        </div>
        {jobs.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Range</th><th>Status</th><th>Completed slices</th><th>Coverage gaps</th><th>Updated</th></tr></thead>
              <tbody>{jobs.map(job => {
                const jobSlices = slices.filter(slice => slice.backfillJobId === job.id);
                return (
                  <tr key={job.id}>
                    <td><span className="cell-main"><strong>{new Date(job.requestedStartAt).toLocaleDateString()} to {new Date(job.requestedEndAt).toLocaleDateString()}</strong><small>Newest first</small></span></td>
                    <td><span className={`action-state ${job.status === "complete" ? "good" : job.status === "paused" ? "warning" : ""}`}>{job.status}</span>{job.pausedReason && <small className="ml-2">{job.pausedReason}</small>}</td>
                    <td className="numeric">{jobSlices.filter(slice => slice.status === "complete").length}/{jobSlices.length}</td>
                    <td className="numeric">{jobSlices.filter(slice => slice.coverageStatus !== "complete").length}</td>
                    <td>{dateTime(job.updatedAt)}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        ) : <EmptyState icon="clock" title="Backfill has not started">Setup schedules the previous day, current billing cycle, and remaining available history in that order.</EmptyState>}
      </section>

      <section className="panel">
        <div className="panel-head"><div><h2>Recent slices</h2><p className="panel-sub">Each collector-day slice stores its cursor, retry count, and explicit coverage result.</p></div></div>
        {slices.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Collector</th><th>Window</th><th>Status</th><th>Coverage</th><th>Retries</th><th>Error</th></tr></thead>
              <tbody>{slices.slice(0, 100).map(slice => (
                <tr key={slice.id}>
                  <td><strong>{slice.collectorKey}</strong></td>
                  <td>{new Date(slice.startsAt).toLocaleDateString()}</td>
                  <td>{slice.status}</td>
                  <td>{slice.coverageStatus}</td>
                  <td className="numeric">{slice.retryCount}</td>
                  <td>{slice.error ?? "None"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <EmptyState icon="clock" title="No slice records">Backfill progress appears after a job is scheduled.</EmptyState>}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
