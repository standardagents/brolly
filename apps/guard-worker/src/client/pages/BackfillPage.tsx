import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { dataSize, dateTime, number } from "../format";
import type { BackfillJobView, BackfillSliceView, RetentionView } from "../types";
import { Button, EmptyState, Icon, Notice, Panel, PanelHead, Pill, Select, Table, TableScroll, Td, Th, Tr } from "../components/ui";

/** Overview-style summary tile. `accent` draws the 3px status stripe down its left edge. */
function StatTile({ label, value, note, accent, valueTone }: {
  label: ReactNode;
  value: ReactNode;
  note: ReactNode;
  accent?: string;
  valueTone?: string;
}) {
  return (
    <article className={`flex min-h-[104px] cursor-default flex-col items-start gap-1 rounded-panel border border-line bg-panel px-4 py-3.5 text-left shadow-panel ${accent ?? ""}`}>
      <span className="inline-flex items-center gap-[5px] text-[12px] font-[680] text-muted">{label}</span>
      <strong className={`text-[27px] leading-[1.1] tracking-[-.02em] tabular-nums ${valueTone ?? ""}`}>{value}</strong>
      <small className="inline-flex items-center gap-[5px] text-[12px] text-faint">{note}</small>
    </article>
  );
}

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
      <section className="mb-[18px] grid grid-cols-[1.3fr_1fr_1fr_1fr] gap-3 max-xl:grid-cols-[repeat(2,minmax(0,1fr))] max-md:grid-cols-[minmax(0,1fr)]">
        <StatTile
          label="Target retention"
          value={`${retention?.targetRetentionDays ?? 730} days`}
          note="Account, product, and namespace aggregates are always preserved"
        />
        <StatTile
          label="D1 capacity"
          value={retention ? `${number(pressure * 100)}%` : "Pending"}
          note={retention ? `${dataSize(retention.projectedBytes)} projected of ${dataSize(retention.capacityBytes)}` : "Capacity check pending"}
          accent={pressure >= .9 ? "border-l-[3px] border-l-danger" : pressure >= .7 ? "border-l-[3px] border-l-[#e0a53a]" : undefined}
          valueTone={pressure >= .9 ? "text-danger" : pressure >= .7 ? "text-warn" : "text-good"}
        />
        <StatTile
          label="Oldest resource day"
          value={retention?.oldestResourceDay ?? "Pending"}
          note="High-cardinality individual-resource history"
        />
        <StatTile
          label="Pending slices"
          value={retention?.backfillPending ?? 0}
          note="Newest slices run from unused collection budget"
        />
      </section>

      {pressure >= .7 && (
        <div className={`mx-5 mb-3 flex items-start gap-[9px] rounded-field border px-3 py-2.5 text-[12.5px] ${pressure >= .9 ? "border-warn-line bg-warn-bg text-warn-ink" : "border-line bg-panel-soft text-muted"}`}>
          <Icon name="alert" className="mt-px size-[15px]" />
          <span>{pressure >= .9
            ? "D1 capacity crossed 90%. Brolly prunes the oldest individual-resource days toward 80% while retaining aggregate history, current state, alerts, actions, audit, and billing records."
            : pressure >= .8
              ? "D1 capacity crossed 80%. Historical backfill is paused until pressure falls below the safety threshold."
              : "D1 capacity crossed 70%. Review projected retention and consider a paid D1 plan for high-cardinality history."}</span>
        </div>
      )}

      <Panel>
        <PanelHead
          eyebrow="Newest first"
          title="Historical backfill"
          sub="Backfill uses only request, wall-time, and D1 budget left after active safeguards. Historical breaches can populate charts and instances; delivery and control execution stay disabled."
          actions={
            <>
              <Select className="text-sm" value={days} onChange={event => setDays(event.target.value)}>
                <option value="1">Previous 24 hours</option><option value="30">Previous 30 days</option><option value="90">Previous 90 days</option>
              </Select>
              <Button variant="primary" disabled={busy} onClick={() => void create()}>{busy ? "Scheduling…" : "Schedule backfill"}</Button>
            </>
          }
        />
        {jobs.length ? (
          <TableScroll>
            <Table>
              <thead><tr><Th>Range</Th><Th>Status</Th><Th>Completed slices</Th><Th>Coverage gaps</Th><Th>Updated</Th></tr></thead>
              <tbody>{jobs.map(job => {
                const jobSlices = slices.filter(slice => slice.backfillJobId === job.id);
                return (
                  <Tr key={job.id}>
                    <Td>
                      <span className="flex min-w-0 flex-col gap-[3px]">
                        <strong className="max-w-[46ch] truncate">{new Date(job.requestedStartAt).toLocaleDateString()} to {new Date(job.requestedEndAt).toLocaleDateString()}</strong>
                        <small className="text-[12px] text-faint">Newest first</small>
                      </span>
                    </Td>
                    <Td><Pill shape="tag">{job.status}</Pill>{job.pausedReason && <small className="ml-2">{job.pausedReason}</small>}</Td>
                    <Td numeric>{jobSlices.filter(slice => slice.status === "complete").length}/{jobSlices.length}</Td>
                    <Td numeric>{jobSlices.filter(slice => slice.coverageStatus !== "complete").length}</Td>
                    <Td>{dateTime(job.updatedAt)}</Td>
                  </Tr>
                );
              })}</tbody>
            </Table>
          </TableScroll>
        ) : <EmptyState icon="clock" title="Backfill has not started">Setup schedules the previous day, current billing cycle, and remaining available history in that order.</EmptyState>}
      </Panel>

      <Panel>
        <PanelHead title="Recent slices" sub="Each collector-day slice stores its cursor, retry count, and explicit coverage result." />
        {slices.length ? (
          <TableScroll>
            <Table>
              <thead><tr><Th>Collector</Th><Th>Window</Th><Th>Status</Th><Th>Coverage</Th><Th>Retries</Th><Th>Error</Th></tr></thead>
              <tbody>{slices.slice(0, 100).map(slice => (
                <Tr key={slice.id}>
                  <Td><strong>{slice.collectorKey}</strong></Td>
                  <Td>{new Date(slice.startsAt).toLocaleDateString()}</Td>
                  <Td>{slice.status}</Td>
                  <Td>{slice.coverageStatus}</Td>
                  <Td numeric>{slice.retryCount}</Td>
                  <Td>{slice.error ?? "None"}</Td>
                </Tr>
              ))}</tbody>
            </Table>
          </TableScroll>
        ) : <EmptyState icon="clock" title="No slice records">Backfill progress appears after a job is scheduled.</EmptyState>}
      </Panel>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
