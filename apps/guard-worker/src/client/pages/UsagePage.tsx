import { useCallback, useEffect, useMemo, useState, type SelectHTMLAttributes } from "react";
import { api } from "../api";
import { dataSize, dateTime, money, number, relativeTime } from "../format";
import type { DataQuality, LedgerResource, UsagePoint, UsageResponse } from "../types";
import { Button, EmptyState, Icon, Notice, Panel, PanelHead, Pill, ProductIcon, Table, TableScroll, Td, Th, Tr } from "../components/ui";

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
    <>
      <Panel>
        <PanelHead
          eyebrow="Stored ledger"
          title="Account usage hierarchy"
          sub="Select any account, product, namespace, Worker, or individual resource. Every value comes from D1 and carries collection-quality state."
          actions={usage?.freshnessAt
            ? <span className="inline-flex flex-none items-center gap-[7px] rounded-full border border-line bg-panel-soft px-[11px] py-1.5 text-[12px] font-[650] text-muted">Updated {relativeTime(usage.freshnessAt)}</span>
            : undefined}
        />
        <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
          <label className="flex min-h-9 items-center gap-[7px] rounded-field border border-field-line bg-panel px-2.5 focus-within:border-orange focus-within:shadow-[0_0_0_3px_#f6821f1f]">
            <Icon name="search" className="size-[15px] text-faint" />
            <input
              className="min-w-[190px] border-0 bg-transparent text-[13px] text-ink outline-none"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Find a resource"
            />
          </label>
          <ToolbarSelect aria-label="Product family" value={family} onChange={event => setFamily(event.target.value)}>
            <option value="">All products</option>
            {families.map(item => <option key={item} value={item}>{display(item)}</option>)}
          </ToolbarSelect>
        </div>
        {visibleResources.length ? (
          <TableScroll>
            <Table>
              <thead><tr><Th>Resource</Th><Th>Scope</Th><Th>Coverage</Th><Th>Last activity</Th><Th>Alerts</Th></tr></thead>
              <tbody>
                {visibleResources.map(resource => (
                  <Tr key={resource.id} clickable className={selectedId === resource.id ? "bg-orange-soft" : undefined} onClick={() => setSelectedId(resource.id)}>
                    <Td>
                      <span className="flex min-w-0 flex-col gap-[3px]">
                        <strong className="flex items-center gap-2"><ProductIcon family={resource.productFamily} />{resource.displayName}</strong>
                        <small className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-faint">{resource.cloudflareId}</small>
                      </span>
                    </Td>
                    <Td>{scopeLabel(resource.resourceType)}</Td>
                    <Td><QualityBadge quality={resource.coverageStatus} /></Td>
                    <Td>{resource.lastActiveAt ? relativeTime(resource.lastActiveAt) : "No observed activity"}</Td>
                    <Td numeric>{resource.openAlerts}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            {nextCursor && (
              <div className="flex justify-center border-t border-line-soft p-3">
                <Button variant="secondary" onClick={() => void loadResources(true)}>Load more resources</Button>
              </div>
            )}
          </TableScroll>
        ) : <EmptyState icon="search" title="No matching resources">Adjust the product or search filter.</EmptyState>}
      </Panel>

      {usage && (
        <Panel>
          <PanelHead
            eyebrow={`${display(usage.resource.productFamily)} · ${scopeLabel(usage.resource.resourceType)}`}
            title={usage.resource.displayName}
            sub={usage.oldestRetainedAt ? `Individual history begins ${usage.oldestRetainedAt}.` : "Individual history is still being collected."}
            actions={
              <ToolbarSelect aria-label="Metric" value={metricId} onChange={event => setMetricId(event.target.value)}>
                {availableMetrics.map(metric => <option key={metric.id} value={metric.id}>{metric.displayName}</option>)}
              </ToolbarSelect>
            }
          />
          {usage.points.length ? <UsageHistory points={usage.points} metricId={metricId} unit={availableMetrics.find(item => item.id === metricId)?.unit ?? "count"} /> : (
            <EmptyState icon="trend" title="History is pending">The active collector and newest-first backfill will add daily records as coverage becomes available.</EmptyState>
          )}
        </Panel>
      )}

      {loading && <p className="py-2.5 text-[13px] text-muted">Loading stored usage…</p>}
      {error && <Notice tone="error">{error}</Notice>}
    </>
  );
}

/** Compact filter/metric picker used in the usage toolbar and panel headings. */
function ToolbarSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`min-h-9 rounded-field border border-field-line bg-panel px-2.5 text-[13px] text-ink focus:border-orange focus:shadow-[0_0_0_3px_#f6821f24] focus:outline-none ${className ?? ""}`}
      {...rest}
    />
  );
}

function UsageHistory({ points, metricId, unit }: { points: UsagePoint[]; metricId: string; unit: string }) {
  const values = points.flatMap(point => point.metrics[metricId] === undefined ? [] : [Number(point.metrics[metricId])]);
  const maximum = Math.max(1, ...values);
  return (
    <div className="grid gap-4 px-5 pb-5">
      <div className="flex h-40 items-end gap-1 rounded border border-line bg-panel-soft p-3" aria-label="Daily usage chart">
        {points.slice(-60).map((point, index) => {
          const value = point.metrics[metricId];
          return (
          <div
            key={`${point.localDay}:${index}`}
            className={`min-w-1 flex-1 rounded-t ${value === undefined ? "bg-line" : point.quality === "complete" ? "bg-orange" : "bg-warn opacity-60"}`}
            style={{ height: value === undefined ? "2%" : `${Math.max(2, Number(value) / maximum * 100)}%` }}
            title={`${point.localDay}: ${value === undefined ? "missing" : formatValue(Number(value), unit)} (${point.quality})`}
          />
          );
        })}
      </div>
      <TableScroll>
        <Table>
          <thead><tr><Th>Local day</Th><Th>Usage</Th><Th>Estimated cost</Th><Th>Allocated billed cost</Th><Th>Evidence</Th><Th>Revised</Th></tr></thead>
          <tbody>
            {[...points].reverse().map((point, index) => (
              <Tr key={`${point.localDay}:${index}`}>
                <Td><strong>{point.localDay}</strong>{!point.sealed && <small className="ml-2 text-faint">live</small>}</Td>
                <Td numeric>{point.metrics[metricId] === undefined ? "Missing" : formatValue(Number(point.metrics[metricId]), unit)}</Td>
                <Td numeric>{point.estimatedCostUsd == null ? "Unavailable" : money(point.estimatedCostUsd)}</Td>
                <Td numeric>{point.authoritativeCostUsd == null ? "Unallocated" : money(point.authoritativeCostUsd)}</Td>
                <Td><QualityBadge quality={point.quality} /></Td>
                <Td>{dateTime(point.revisedAt)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
    </div>
  );
}

export function QualityBadge({ quality }: { quality: DataQuality }) {
  const tone = quality === "complete" ? "good" : quality === "missing" || quality === "stale" ? "danger" : "warn";
  return <Pill tone={tone} shape="tag">{quality}</Pill>;
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
