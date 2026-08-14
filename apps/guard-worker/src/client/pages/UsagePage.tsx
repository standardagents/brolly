import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { dataSize, dateTime, money, number, relativeTime } from "../format";
import type { DataQuality, LedgerResource, UsagePoint, UsageResponse } from "../types";
import { EmptyState, Icon, ProductIcon } from "../components/ui";

export function UsagePage({ token }: { token: string }) {
  const [resources, setResources] = useState<LedgerResource[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [metricId, setMetricId] = useState("");
  const [family, setFamily] = useState("");
  const [search, setSearch] = useState("");
  const [families, setFamilies] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadResources = useCallback(async (append = false) => {
    const params = new URLSearchParams({ limit: "500" });
    if (family) params.set("family", family);
    if (search.trim()) params.set("q", search.trim());
    if (append && nextCursor) params.set("cursor", nextCursor);
    const result = await api<{ resources: LedgerResource[]; families: string[]; nextCursor: string | null }>(`/api/ledger/resources?${params}`, token);
    setResources(current => append ? [...current, ...result.resources] : result.resources);
    setFamilies(result.families);
    setNextCursor(result.nextCursor);
    setSelectedId(current => append || result.resources.some(item => item.id === current)
      ? current
      : result.resources.find(item => item.resourceType === "account")?.id || result.resources[0]?.id || "");
  }, [family, nextCursor, search, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadResources(false).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false));
    }, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [family, search, token]);

  useEffect(() => {
    if (!selectedId) return;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ resourceId: selectedId });
    void api<UsageResponse>(`/api/usage?${params}`, token)
      .then(result => {
        setUsage(result);
        const available = metricIds(result.points);
        setMetricId(current => available.includes(current) ? current : available[0] ?? "");
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, [selectedId, token]);

  const visibleResources = useMemo(() => resources.filter(resource =>
    (!family || resource.productFamily === family)
    && (!search.trim() || `${resource.displayName} ${resource.cloudflareId}`.toLowerCase().includes(search.trim().toLowerCase())),
  ), [family, resources, search]);
  const availableMetrics = usage ? metricIds(usage.points).map(id => usage.metricDefinitions.find(item => item.id === id) ?? {
    id, displayName: id.split(":").at(-1)?.replaceAll("_", " ") ?? id, unit: "count",
  }) : [];

  return (
    <div className="grid gap-4">
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Stored ledger</p>
            <h2>Account usage hierarchy</h2>
            <p className="panel-sub">Select any account, product, namespace, Worker, or individual resource. Every value comes from D1 and carries collection-quality state.</p>
          </div>
          {usage?.freshnessAt && <span className="estimate-pill">Updated {relativeTime(usage.freshnessAt)}</span>}
        </div>
        <div className="asset-toolbar px-5 pb-3">
          <label className="search-field"><Icon name="search" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a resource" /></label>
          <select aria-label="Product family" value={family} onChange={event => setFamily(event.target.value)}>
            <option value="">All products</option>
            {families.map(item => <option key={item} value={item}>{display(item)}</option>)}
          </select>
        </div>
        {visibleResources.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Resource</th><th>Scope</th><th>Coverage</th><th>Last activity</th><th>Alerts</th></tr></thead>
              <tbody>
                {visibleResources.map(resource => (
                  <tr key={resource.id} className={selectedId === resource.id ? "clickable bg-[var(--orange-soft)]" : "clickable"} onClick={() => setSelectedId(resource.id)}>
                    <td>
                      <span className="cell-main">
                        <strong className="flex items-center gap-2"><ProductIcon family={resource.productFamily} />{resource.displayName}</strong>
                        <small>{resource.cloudflareId}</small>
                      </span>
                    </td>
                    <td>{scopeLabel(resource.resourceType)}</td>
                    <td><QualityBadge quality={resource.coverageStatus} /></td>
                    <td>{resource.lastActiveAt ? relativeTime(resource.lastActiveAt) : "No observed activity"}</td>
                    <td className="numeric">{resource.openAlerts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {nextCursor && <div className="flex justify-center border-t border-[var(--line-soft)] p-3"><button className="button secondary" type="button" onClick={() => void loadResources(true)}>Load more resources</button></div>}
          </div>
        ) : <EmptyState icon="search" title="No matching resources">Adjust the product or search filter.</EmptyState>}
      </section>

      {usage && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <p className="eyebrow">{display(usage.resource.productFamily)} · {scopeLabel(usage.resource.resourceType)}</p>
              <h2>{usage.resource.displayName}</h2>
              <p className="panel-sub">
                {usage.oldestRetainedAt ? `Individual history begins ${usage.oldestRetainedAt}.` : "Individual history is still being collected."}
              </p>
            </div>
            <select className="min-h-9 rounded border border-[var(--line)] bg-white px-3 text-sm" value={metricId} onChange={event => setMetricId(event.target.value)}>
              {availableMetrics.map(metric => <option key={metric.id} value={metric.id}>{metric.displayName}</option>)}
            </select>
          </div>
          {usage.points.length ? <UsageHistory points={usage.points} metricId={metricId} unit={availableMetrics.find(item => item.id === metricId)?.unit ?? "count"} /> : (
            <EmptyState icon="trend" title="History is pending">The active collector and newest-first backfill will add daily records as coverage becomes available.</EmptyState>
          )}
        </section>
      )}

      {loading && <p className="loading-inline">Loading stored usage…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

function UsageHistory({ points, metricId, unit }: { points: UsagePoint[]; metricId: string; unit: string }) {
  const values = points.flatMap(point => point.metrics[metricId] === undefined ? [] : [Number(point.metrics[metricId])]);
  const maximum = Math.max(1, ...values);
  return (
    <div className="grid gap-4 px-5 pb-5">
      <div className="flex h-40 items-end gap-1 rounded border border-[var(--line)] bg-[var(--panel-soft)] p-3" aria-label="Daily usage chart">
        {points.slice(-60).map((point, index) => {
          const value = point.metrics[metricId];
          return (
          <div
            key={`${point.localDay}:${index}`}
            className={`min-w-1 flex-1 rounded-t ${value === undefined ? "bg-[var(--line)]" : point.quality === "complete" ? "bg-[var(--orange)]" : "bg-[var(--warn)] opacity-60"}`}
            style={{ height: value === undefined ? "2%" : `${Math.max(2, Number(value) / maximum * 100)}%` }}
            title={`${point.localDay}: ${value === undefined ? "missing" : formatValue(Number(value), unit)} (${point.quality})`}
          />
          );
        })}
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th>Local day</th><th>Usage</th><th>Estimated cost</th><th>Allocated billed cost</th><th>Evidence</th><th>Revised</th></tr></thead>
          <tbody>
            {[...points].reverse().map((point, index) => (
              <tr key={`${point.localDay}:${index}`}>
                <td><strong>{point.localDay}</strong>{!point.sealed && <small className="ml-2 text-[var(--faint)]">live</small>}</td>
                <td className="numeric">{point.metrics[metricId] === undefined ? "Missing" : formatValue(Number(point.metrics[metricId]), unit)}</td>
                <td className="numeric">{point.estimatedCostUsd == null ? "Unavailable" : money(point.estimatedCostUsd)}</td>
                <td className="numeric">{point.authoritativeCostUsd == null ? "Unallocated" : money(point.authoritativeCostUsd)}</td>
                <td><QualityBadge quality={point.quality} /></td>
                <td>{dateTime(point.revisedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function QualityBadge({ quality }: { quality: DataQuality }) {
  const tone = quality === "complete" ? "good" : quality === "missing" || quality === "stale" ? "danger" : "warning";
  return <span className={`action-state ${tone}`}>{quality}</span>;
}

function metricIds(points: UsagePoint[]): string[] {
  return [...new Set(points.flatMap(point => Object.keys(point.metrics)))].sort();
}

function formatValue(value: number, unit: string): string {
  if (unit === "usd") return money(value);
  if (unit === "bytes") return dataSize(value);
  return `${number(value)} ${unit}`;
}

function scopeLabel(resourceType: string): string {
  if (resourceType === "account") return "Account";
  if (resourceType === "product") return "Product";
  return display(resourceType.split(":").at(-1) ?? resourceType);
}

function display(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}
