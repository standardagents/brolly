import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { dataSize, dateTime, money, number, relativeTime } from "../format";
import type { CollectorCapabilityView, CollectorStateView, LedgerRunLimitsView, MonitoringDailyView, MonitorRunView } from "../types";
import { Button, CellStack, CountBadge, EmptyState, Input, Notice, Panel, PanelFoot, PanelHead, Pill, Table, TableScroll, Td, Th, Tr } from "../components/ui";

/** Non-interactive summary tile in the monitoring cost row. */
function StatTile({ label, value, caption }: { label: ReactNode; value: ReactNode; caption: ReactNode }) {
  return (
    <article className="flex min-h-[104px] flex-col items-start gap-1 rounded-panel border border-line bg-panel px-4 py-3.5 text-left shadow-panel">
      <span className="inline-flex items-center gap-[5px] text-[12px] font-[680] text-muted">{label}</span>
      <strong className="text-[27px] leading-[1.1] tracking-[-.02em] tabular-nums">{value}</strong>
      <small className="inline-flex items-center gap-[5px] text-[12px] text-faint">{caption}</small>
    </article>
  );
}

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
      <section className="mb-[18px] grid grid-cols-[1.3fr_1fr_1fr_1fr] gap-3 max-xl:grid-cols-2 max-md:grid-cols-1" aria-label="Monitoring cost">
        <StatTile
          label="GraphQL queries"
          value={today ? number(today.graphqlQueries) : "Pending"}
          caption={today ? `${number(today.graphqlQueryBudget)} cumulative run budget` : "Accounting pending"}
        />
        <StatTile
          label="REST requests"
          value={today ? number(today.restRequests) : "Pending"}
          caption={today ? `${number(today.restRequestBudget)} cumulative run budget` : "Accounting pending"}
        />
        <StatTile
          label="D1 operations"
          value={today ? number(today.d1RowsRead + today.d1RowsWritten) : "Pending"}
          caption={today ? `${number(today.d1RowsRead)} read · ${number(today.d1RowsWritten)} written` : "Accounting pending"}
        />
        <StatTile label="Monthly estimate" value={money(monthlyEstimate)} caption="Derived from recorded Brolly run usage" />
      </section>

      <Panel>
        <PanelHead
          eyebrow="Collection accounting"
          title="Recent bounded runs"
          sub="Run records preserve request counts, D1 work, coverage, continuation state, and errors."
          actions={latest && (
            <span className="inline-flex flex-none items-center gap-[7px] rounded-full border border-line bg-panel-soft px-[11px] py-1.5 text-[12px] font-[650] text-muted">
              {latest.status} · {relativeTime(latest.startedAt)}
            </span>
          )}
        />
        {runs.length ? (
          <TableScroll>
            <Table>
              <thead><tr><Th>Started</Th><Th>Kind</Th><Th>Coverage</Th><Th>GraphQL</Th><Th>REST</Th><Th>D1 rows</Th><Th>Normalized</Th><Th>Duration</Th></tr></thead>
              <tbody>{runs.map(run => (
                <Tr key={run.id}>
                  <Td>{dateTime(run.startedAt)}</Td>
                  <Td>{run.kind.replaceAll("_", " ")}</Td>
                  <Td><Pill shape="tag">{run.coverageStatus}</Pill></Td>
                  <Td numeric>{number(run.graphqlQueries)}</Td>
                  <Td numeric>{number(run.restRequests)}</Td>
                  <Td numeric>{number(run.d1RowsRead + run.d1RowsWritten)}</Td>
                  <Td numeric>{number(run.samplesNormalized)}</Td>
                  <Td>{run.durationMs == null ? "Running" : `${number(run.durationMs)} ms`}</Td>
                </Tr>
              ))}</tbody>
            </Table>
          </TableScroll>
        ) : <EmptyState icon="pulse" title="Run accounting is pending">The next scheduled or explicit scan creates the first monitor record.</EmptyState>}
      </Panel>

      {limits && hardMaximums && (
        <Panel>
          <PanelHead
            eyebrow="Safety ceilings"
            title="Per-run collection limits"
            sub="Each scan stops or defers work when it reaches a configured ceiling. Product hard maximums constrain every saved value."
          />
          <form className="grid gap-4 p-5 pt-0" onSubmit={saveLimits}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(Object.keys(LIMIT_LABELS) as Array<keyof LedgerRunLimitsView>).map(key => (
                <label className="grid gap-1 text-xs text-muted" key={key}>
                  <span>{LIMIT_LABELS[key]}</span>
                  <Input
                    className="text-sm"
                    type="number"
                    min="1"
                    max={hardMaximums[key]}
                    step="1"
                    value={limits[key]}
                    onChange={event => setLimits(current => current ? { ...current, [key]: Number(event.target.value) } : current)}
                  />
                  <small className="text-faint">Hard maximum {number(hardMaximums[key])}</small>
                </label>
              ))}
            </div>
            <Button variant="primary" className="w-max" disabled={savingLimits} type="submit">{savingLimits ? "Saving…" : "Save collection limits"}</Button>
          </form>
        </Panel>
      )}

      <Panel>
        <PanelHead
          eyebrow="Collector coverage"
          title="Datasets and retention"
          sub="Unavailable products remain visible. Billing catchalls preserve authoritative lines while detailed attribution is unavailable."
          actions={<CountBadge>{capabilities.filter(item => item.available).length}/{capabilities.length} available</CountBadge>}
        />
        <div className="grid grid-cols-2 gap-2.5 px-5 pt-1 pb-4 max-xl:grid-cols-1">
          {capabilities.map(item => (
            <article className="overflow-hidden rounded-field border border-line bg-panel p-3" key={`${item.collectorKey}:${item.dataset}`}>
              <header className="flex items-start justify-between gap-3">
                <CellStack title={item.dataset} sub={<>{item.collectorKey} · {item.finestScope}</>} />
                <span className={`whitespace-nowrap rounded-full px-2 py-1 text-[10.5px] font-[750] ${item.available ? "bg-good-bg text-good" : "bg-warn-bg text-warn"}`}>{item.state}</span>
              </header>
              <p className="mt-2 text-xs leading-5 text-muted">{item.humanExplanation}</p>
              <small className="mt-2 block text-faint">{item.retentionDays == null ? "Retention unavailable" : `${item.retentionDays} days retained`}{item.watermarkAt ? ` · watermark ${relativeTime(item.watermarkAt)}` : ""}</small>
            </article>
          ))}
        </div>
      </Panel>

      <Panel>
        <PanelHead title="Scheduler state" sub="Persisted high-water marks and continuation cursors allow interrupted collectors to resume." />
        <TableScroll>
          <Table>
            <thead><tr><Th>Collector</Th><Th>Status</Th><Th>Watermark</Th><Th>Next eligible</Th><Th>Retries</Th><Th>Error</Th></tr></thead>
            <tbody>{collectors.map(item => (
              <Tr key={`${item.collectorKey}:${item.partitionKey}`}>
                <Td><strong>{item.collectorKey}</strong></Td>
                <Td>{item.status}</Td>
                <Td>{item.highWatermarkAt ? dateTime(item.highWatermarkAt) : "Pending"}</Td>
                <Td>{dateTime(item.nextEligibleAt)}</Td>
                <Td numeric>{item.retryCount}</Td>
                <Td>{item.lastError ?? "None"}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        </TableScroll>
        {today?.storageBytes != null && (
          <PanelFoot icon="info">
            D1 storage {dataSize(today.storageBytes)} of {today.storageCapacityBytes ? dataSize(today.storageCapacityBytes) : "configured capacity"}
          </PanelFoot>
        )}
      </Panel>
      {error && <Notice tone="error">{error}</Notice>}
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
