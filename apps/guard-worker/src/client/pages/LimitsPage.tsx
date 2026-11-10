import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { dateTime } from "../format";
import { ENTERPRISE_COST_NOTICE } from "../plan-tier";
import type { AlertLevel, AlertLineView, AlertRuleView, DashboardData, LedgerMetricDefinition, LedgerResource } from "../types";
import { ResourceIdentity, identityCollisions, identityLabel } from "../components/ResourceIdentity";
import { Button, EmptyState, Icon, LinkButton, Notice, Panel, PanelHead, Table, TableScroll, Td, Th, Tr } from "../components/ui";
import { useOutsideClose } from "../lib/outside-close";

/**
 * Compact editable cells fill the limit tables, so they use a shorter field
 * than the standard <Input>; every one shares this box.
 */
const COMPACT_FIELD = "rounded-field border border-field-line bg-field px-2 text-ink focus:border-orange focus:shadow-[0_0_0_3px_#f6821f24] focus:outline-none";

export function LimitsPage({ token }: { token: string }) {
  const [rules, setRules] = useState<AlertRuleView[]>([]);
  const [resources, setResources] = useState<LedgerResource[]>([]);
  const [metrics, setMetrics] = useState<LedgerMetricDefinition[]>([]);
  const [levels, setLevels] = useState<AlertLevel[]>([]);
  const [dashboard, setDashboard] = useState<Pick<DashboardData, "planTier"> | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError("");
    const [ruleResult, resourceResult, metricResult, levelResult, dashboardResult] = await Promise.all([
      api<{ rules: AlertRuleView[] }>("/api/alert-rules", token),
      api<{ resources: LedgerResource[] }>("/api/ledger/resources?limit=100", token),
      api<{ metricDefinitions: LedgerMetricDefinition[] }>("/api/metric-definitions", token),
      api<{ levels: AlertLevel[] }>("/api/alert-levels", token),
      api<Pick<DashboardData, "planTier">>("/api/dashboard", token),
    ]);
    setRules(ruleResult.rules);
    setResources(resourceResult.resources);
    setMetrics(metricResult.metricDefinitions);
    setLevels(levelResult.levels);
    setDashboard(dashboardResult);
  }, [token]);

  useEffect(() => { void load().catch(cause => setError(message(cause))); }, [load]);
  const resourceNames = useMemo(() => new Map(resources.map(item => [item.id, identityLabel(item)])), [resources]);
  const enterprise = dashboard?.planTier === "enterprise";

  async function updateRule(rule: AlertRuleView, updates: Partial<AlertRuleView>) {
    setError("");
    try {
      await api(`/api/alert-rules/${encodeURIComponent(rule.id)}`, token, {
        method: "PUT",
        body: JSON.stringify({ ...rule, ...updates }),
      });
      await load();
    } catch (cause) { setError(message(cause)); }
  }

  async function removeRule(rule: AlertRuleView) {
    if (!window.confirm(`Delete the limit for ${resourceNames.get(rule.targetResourceId ?? "") ?? "this selector"}?`)) return;
    setError("");
    try {
      await api(`/api/alert-rules/${encodeURIComponent(rule.id)}`, token, { method: "DELETE" });
      await load();
    } catch (cause) { setError(message(cause)); }
  }

  return (
    <div className="grid gap-4">
      <Panel>
        <PanelHead
          eyebrow="Period rules"
          title="Usage and cost limits"
          sub="Each rule targets a resource or selector and supports any number of named threshold lines. Daily periods follow the account timezone; billing-cycle periods follow reconciled Cloudflare boundaries."
          actions={<Button variant="primary" onClick={() => setCreating(!creating)}><Icon name={creating ? "x" : "wallet"} />{creating ? "Close" : "New limit"}</Button>}
        />
        {enterprise && <div className="mx-5 mb-4 rounded-field border border-line bg-panel-soft px-3 py-2.5 text-[12.5px] text-muted">{ENTERPRISE_COST_NOTICE}</div>}
        {creating && <CreateRuleForm token={token} resources={resources} metrics={metrics} levels={levels} costUnsupported={enterprise} onCreated={async () => { setCreating(false); await load(); }} />}
      </Panel>

      {rules.length ? rules.map(rule => (
        <RuleCard
          key={rule.id}
          rule={rule}
          targetIdentity={resources.find(item => item.id === rule.targetResourceId) ?? rule.targetIdentity}
          resourceName={rule.targetIdentity ? identityLabel(rule.targetIdentity) : rule.targetDisplayName ?? resourceNames.get(rule.targetResourceId ?? "") ?? selectorName(rule)}
          token={token}
          onReload={load}
          costUnsupported={enterprise}
          onToggle={enabled => updateRule(rule, { enabled })}
          onDelete={() => removeRule(rule)}
        />
      )) : (
        <Panel><EmptyState icon="wallet" title="No ledger limits yet">Create a rule with one threshold for each current alert level.</EmptyState></Panel>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function RuleCard({ rule, targetIdentity, resourceName, token, onReload, costUnsupported = false, onToggle, onDelete }: {
  rule: AlertRuleView;
  targetIdentity: LedgerResource | AlertRuleView["targetIdentity"];
  resourceName: string;
  token: string;
  onReload: () => Promise<void>;
  costUnsupported?: boolean;
  onToggle: (enabled: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const costRule = costUnsupported && (rule.measurement === "estimated_cost" || rule.measurement === "billed_cost");
  return (
    <Panel className={costRule ? "opacity-55 saturate-0" : undefined} aria-disabled={costRule || undefined}>
      <PanelHead
        eyebrow={`${rule.period.replace("_", " ")} · ${rule.measurement.replace("_", " ")}`}
        title={targetIdentity ? <ResourceIdentity identity={targetIdentity} showIcon={false} /> : resourceName}
        sub={`${rule.metricDefinitionId} · Updated ${dateTime(rule.updatedAt)}`}
          actions={<>
          <Button disabled={costRule} onClick={() => void onToggle(!rule.enabled)}>{rule.enabled ? "Pause rule" : "Enable rule"}</Button>
          <Button variant="quiet" disabled={costRule} onClick={() => void onDelete()}>Delete</Button>
          </>}
      />
      <TableScroll>
        <Table>
          <thead><tr><Th>Alert level</Th><Th>Threshold</Th><Th>State</Th><Th /></tr></thead>
          <tbody>
            {rule.lines.map(line => <LineRow key={line.id} line={line} token={token} onReload={onReload} disabled={costRule} />)}
          </tbody>
        </Table>
      </TableScroll>
      <p className="border-t border-line-soft px-5 py-3 text-[12px] text-muted">Channel delivery and protective actions follow the alert level board in Budget settings.</p>
    </Panel>
  );
}

function LineRow({ line, token, onReload, disabled = false }: { line: AlertLineView; token: string; onReload: () => Promise<void>; disabled?: boolean }) {
  const [value, setValue] = useState(String(line.thresholdValue));
  const [enabled, setEnabled] = useState(line.enabled);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api(`/api/alert-lines/${encodeURIComponent(line.id)}`, token, {
        method: "PUT",
        body: JSON.stringify({ thresholdValue: Number(value), enabled }),
      });
      await onReload();
    } finally { setBusy(false); }
  }

  return (
    <Tr>
      <Td><span className="flex items-center gap-2"><i className="size-2.5 rounded-full" style={{ backgroundColor: line.color }} /><strong>{line.label}</strong></span></Td>
      <Td><input disabled={disabled} className={`min-h-8 w-32 text-right ${COMPACT_FIELD}`} type="number" min="0" step="any" value={value} onChange={event => setValue(event.target.value)} /></Td>
      <Td><label className="flex items-center gap-2"><input disabled={disabled} type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{enabled ? "Enabled" : "Disabled"}</label></Td>
      <Td><span className="flex justify-end"><LinkButton disabled={disabled || busy} onClick={() => void save()}>Save</LinkButton></span></Td>
    </Tr>
  );
}

function CreateRuleForm({ token, resources, metrics, levels, costUnsupported = false, onCreated }: {
  token: string;
  resources: LedgerResource[];
  metrics: LedgerMetricDefinition[];
  levels: AlertLevel[];
  costUnsupported?: boolean;
  onCreated: () => Promise<void>;
}) {
  const [targetResourceId, setTargetResourceId] = useState(resources[0]?.id ?? "");
  const [selectedTarget, setSelectedTarget] = useState<LedgerResource | null>(resources[0] ?? null);
  const [targetSearch, setTargetSearch] = useState("");
  const [targetCandidates, setTargetCandidates] = useState(resources);
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetNextCursor, setTargetNextCursor] = useState<string | null>(null);
  const [targetActiveIndex, setTargetActiveIndex] = useState(0);
  const [metricDefinitionId, setMetricDefinitionId] = useState(metrics[0]?.id ?? "");
  const [measurement, setMeasurement] = useState<AlertRuleView["measurement"]>("usage");
  const [period, setPeriod] = useState<AlertRuleView["period"]>("day");
  const [thresholds, setThresholds] = useState<Record<string, string>>(() => Object.fromEntries(levels.map((level, index) => [level.id, String(index + 1)])));
  const [error, setError] = useState("");
  const targetRoot = useRef<HTMLDivElement>(null);
  const closeTargets = useCallback(() => setTargetOpen(false), []);
  useOutsideClose(targetRoot, targetOpen, closeTargets);
  const collisions = useMemo(() => identityCollisions(targetCandidates), [targetCandidates]);
  const compatibleMetrics = metrics.filter(metric => {
    return selectedTarget?.resourceType === "account" || metric.productFamily === selectedTarget?.productFamily;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: targetSearch.trim(), limit: "100" });
      if (!targetSearch.trim()) params.delete("q");
      void api<{ resources: LedgerResource[]; nextCursor: string | null }>(`/api/ledger/resources?${params}`, token)
        .then(result => {
          setTargetCandidates(result.resources);
          setTargetNextCursor(result.nextCursor);
          setTargetActiveIndex(0);
        })
        .catch(cause => setError(message(cause)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [targetSearch, token]);

  async function loadMoreTargets() {
    if (!targetNextCursor) return;
    const params = new URLSearchParams({ limit: "100", cursor: targetNextCursor });
    if (targetSearch.trim()) params.set("q", targetSearch.trim());
    const result = await api<{ resources: LedgerResource[]; nextCursor: string | null }>(`/api/ledger/resources?${params}`, token);
    setTargetCandidates(current => [...current, ...result.resources]);
    setTargetNextCursor(result.nextCursor);
  }

  function chooseTarget(target: LedgerResource) {
    setTargetResourceId(target.id);
    setSelectedTarget(target);
    setTargetSearch("");
    setTargetOpen(false);
  }

  useEffect(() => {
    if (!compatibleMetrics.some(item => item.id === metricDefinitionId)) setMetricDefinitionId(compatibleMetrics[0]?.id ?? "");
  }, [compatibleMetrics, metricDefinitionId]);

  useEffect(() => {
    if (costUnsupported && measurement !== "usage") setMeasurement("usage");
  }, [costUnsupported, measurement]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api("/api/alert-rules", token, {
        method: "POST",
        body: JSON.stringify({
          targetResourceId,
          metricDefinitionId,
          measurement,
          period,
          notificationTargetIds: [],
          autoQuarantine: false,
          autoQuarantineContributors: false,
          confirmationWindowMs: 5 * 60_000,
          enabled: true,
          lines: levels.map((level, index) => ({
            levelId: level.id, label: level.label, color: levelColor(index, levels.length), priority: level.position * 10,
            thresholdValue: Number(thresholds[level.id]), action: "notify", repeatIntervalMs: null, enabled: true,
          })),
        }),
      });
      await onCreated();
    } catch (cause) { setError(message(cause)); }
  }

  return (
    <form className="grid gap-3 border-t border-line-soft px-5 py-4 md:grid-cols-2 xl:grid-cols-4" onSubmit={event => void create(event)}>
      <div ref={targetRoot} className="relative grid gap-1 text-xs font-bold md:col-span-2">
        <span>Target</span>
        {selectedTarget && <div className="rounded-field border border-line-soft bg-panel-soft px-2.5 py-2"><ResourceIdentity identity={{ ...selectedTarget, productFamily: selectedTarget.productFamily }} /></div>}
        <input
          className={`min-h-10 ${COMPACT_FIELD}`}
          value={targetSearch}
          onChange={event => { setTargetSearch(event.target.value); setTargetOpen(true); }}
          onFocus={() => setTargetOpen(true)}
          onKeyDown={event => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setTargetOpen(true);
              setTargetActiveIndex(current => Math.min(targetCandidates.length - 1, current + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setTargetActiveIndex(current => Math.max(0, current - 1));
            } else if (event.key === "Enter" && targetOpen && targetCandidates[targetActiveIndex]) {
              event.preventDefault();
              chooseTarget(targetCandidates[targetActiveIndex]);
            }
          }}
          placeholder="Search name or exact Cloudflare ID"
          role="combobox"
          aria-expanded={targetOpen}
          aria-controls="limit-target-results"
          aria-autocomplete="list"
          aria-activedescendant={targetOpen && targetCandidates[targetActiveIndex] ? `limit-target-${targetActiveIndex}` : undefined}
        />
        {targetOpen && (
          <div id="limit-target-results" role="listbox" className="absolute top-full z-20 mt-1 max-h-80 w-full overflow-auto rounded-field border border-line bg-panel p-1 shadow-xl">
            {targetCandidates.length ? targetCandidates.map((item, index) => (
              <button
                id={`limit-target-${index}`}
                key={item.id}
                type="button"
                role="option"
                aria-selected={item.id === targetResourceId}
                className={`block w-full rounded px-2.5 py-2 text-left hover:bg-panel-soft focus:outline-none ${index === targetActiveIndex ? "bg-panel-soft" : ""}`}
                onMouseMove={() => setTargetActiveIndex(index)}
                onClick={() => chooseTarget(item)}
              >
                <ResourceIdentity identity={{ ...item, productFamily: item.productFamily }} collision={collisions.has(item.cloudflareId)} />
              </button>
            )) : <p className="m-0 px-2.5 py-3 font-normal text-muted">No matching resources</p>}
            {targetNextCursor && <div className="border-t border-line-soft p-2"><Button variant="secondary" full onClick={() => void loadMoreTargets()}>Load more resources</Button></div>}
          </div>
        )}
      </div>
      <label className="grid gap-1 text-xs font-bold">Metric<select required className={`min-h-10 ${COMPACT_FIELD}`} value={metricDefinitionId} onChange={event => setMetricDefinitionId(event.target.value)}>{compatibleMetrics.map(item => <option key={item.id} value={item.id}>{item.displayName} · {item.productFamily}</option>)}</select></label>
      <label className="grid gap-1 text-xs font-bold">Measurement<select className={`min-h-10 ${COMPACT_FIELD}`} value={measurement} onChange={event => setMeasurement(event.target.value as AlertRuleView["measurement"])}><option value="usage">Usage</option><option disabled={costUnsupported} value="estimated_cost">Estimated cost</option><option disabled={costUnsupported} value="billed_cost">Billed cost</option></select></label>
      <label className="grid gap-1 text-xs font-bold">Period<select className={`min-h-10 ${COMPACT_FIELD}`} value={period} onChange={event => setPeriod(event.target.value as AlertRuleView["period"])}><option value="day">Account-local day</option><option value="billing_cycle">Cloudflare billing cycle</option></select></label>
      {levels.map((level, index) => <label key={level.id} className="grid gap-1 text-xs font-bold">{level.label}<input required type="number" min={index ? thresholds[levels[index - 1]!.id] : "0"} step="any" className={`min-h-10 ${COMPACT_FIELD}`} value={thresholds[level.id] ?? ""} onChange={event => setThresholds(current => ({ ...current, [level.id]: event.target.value }))} /></label>)}
      <div className="flex items-end"><Button variant="primary" type="submit">Create limit</Button></div>
      {error && <Notice tone="error" className="md:col-span-2 xl:col-span-4">{error}</Notice>}
    </form>
  );
}

function levelColor(index: number, count: number): string {
  if (index === count - 1) return "#ef4444";
  if (index === count - 2) return "#dc6b24";
  return "#f59e0b";
}

function selectorName(rule: AlertRuleView): string {
  return rule.targetSelector ? Object.entries(rule.targetSelector).map(([key, value]) => `${key}: ${value}`).join(", ") : "Resource selector";
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
