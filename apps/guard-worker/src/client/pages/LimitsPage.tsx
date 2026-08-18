import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { dateTime } from "../format";
import type { AlertLevel, AlertLineView, AlertRuleView, LedgerMetricDefinition, LedgerResource } from "../types";
import { Button, EmptyState, Icon, LinkButton, Notice, Panel, PanelHead, Table, TableScroll, Td, Th, Tr } from "../components/ui";

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
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError("");
    const [ruleResult, resourceResult, metricResult, levelResult] = await Promise.all([
      api<{ rules: AlertRuleView[] }>("/api/alert-rules", token),
      api<{ resources: LedgerResource[] }>("/api/ledger/resources?limit=500", token),
      api<{ metricDefinitions: LedgerMetricDefinition[] }>("/api/metric-definitions", token),
      api<{ levels: AlertLevel[] }>("/api/alert-levels", token),
    ]);
    setRules(ruleResult.rules);
    setResources(resourceResult.resources);
    setMetrics(metricResult.metricDefinitions);
    setLevels(levelResult.levels);
  }, [token]);

  useEffect(() => { void load().catch(cause => setError(message(cause))); }, [load]);
  const resourceNames = useMemo(() => new Map(resources.map(item => [item.id, item.displayName])), [resources]);

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
        {creating && <CreateRuleForm token={token} resources={resources} metrics={metrics} levels={levels} onCreated={async () => { setCreating(false); await load(); }} />}
      </Panel>

      {rules.length ? rules.map(rule => (
        <RuleCard
          key={rule.id}
          rule={rule}
          targetResource={resources.find(item => item.id === rule.targetResourceId) ?? null}
          resourceName={rule.targetDisplayName ?? resourceNames.get(rule.targetResourceId ?? "") ?? selectorName(rule)}
          token={token}
          onReload={load}
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

function RuleCard({ rule, targetResource, resourceName, token, onReload, onToggle, onDelete }: {
  rule: AlertRuleView;
  targetResource: LedgerResource | null;
  resourceName: string;
  token: string;
  onReload: () => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  void targetResource;
  return (
    <Panel>
      <PanelHead
        eyebrow={`${rule.period.replace("_", " ")} · ${rule.measurement.replace("_", " ")}`}
        title={resourceName}
        sub={`${rule.metricDefinitionId} · Updated ${dateTime(rule.updatedAt)}`}
        actions={<>
          <Button onClick={() => void onToggle(!rule.enabled)}>{rule.enabled ? "Pause rule" : "Enable rule"}</Button>
          <Button variant="quiet" onClick={() => void onDelete()}>Delete</Button>
        </>}
      />
      <TableScroll>
        <Table>
          <thead><tr><Th>Alert level</Th><Th>Threshold</Th><Th>State</Th><Th /></tr></thead>
          <tbody>
            {rule.lines.map(line => <LineRow key={line.id} line={line} token={token} onReload={onReload} />)}
          </tbody>
        </Table>
      </TableScroll>
      <p className="border-t border-line-soft px-5 py-3 text-[12px] text-muted">Channel delivery and protective actions follow the alert level board in Budget settings.</p>
    </Panel>
  );
}

function LineRow({ line, token, onReload }: { line: AlertLineView; token: string; onReload: () => Promise<void> }) {
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
      <Td><input className={`min-h-8 w-32 text-right ${COMPACT_FIELD}`} type="number" min="0" step="any" value={value} onChange={event => setValue(event.target.value)} /></Td>
      <Td><label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{enabled ? "Enabled" : "Disabled"}</label></Td>
      <Td><span className="flex justify-end"><LinkButton disabled={busy} onClick={() => void save()}>Save</LinkButton></span></Td>
    </Tr>
  );
}

function CreateRuleForm({ token, resources, metrics, levels, onCreated }: {
  token: string;
  resources: LedgerResource[];
  metrics: LedgerMetricDefinition[];
  levels: AlertLevel[];
  onCreated: () => Promise<void>;
}) {
  const [targetResourceId, setTargetResourceId] = useState(resources[0]?.id ?? "");
  const [targetSearch, setTargetSearch] = useState("");
  const [targetCandidates, setTargetCandidates] = useState(resources);
  const [metricDefinitionId, setMetricDefinitionId] = useState(metrics[0]?.id ?? "");
  const [measurement, setMeasurement] = useState<AlertRuleView["measurement"]>("usage");
  const [period, setPeriod] = useState<AlertRuleView["period"]>("day");
  const [thresholds, setThresholds] = useState<Record<string, string>>(() => Object.fromEntries(levels.map((level, index) => [level.id, String(index + 1)])));
  const [error, setError] = useState("");
  const compatibleMetrics = metrics.filter(metric => {
    const resource = targetCandidates.find(item => item.id === targetResourceId)
      ?? resources.find(item => item.id === targetResourceId);
    return resource?.resourceType === "account" || metric.productFamily === resource?.productFamily;
  });

  useEffect(() => {
    if (!targetSearch.trim()) { setTargetCandidates(resources); return; }
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: targetSearch.trim(), limit: "100" });
      void api<{ resources: LedgerResource[] }>(`/api/ledger/resources?${params}`, token)
        .then(result => {
          setTargetCandidates(result.resources);
          if (!result.resources.some(item => item.id === targetResourceId)) setTargetResourceId(result.resources[0]?.id ?? "");
        })
        .catch(cause => setError(message(cause)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [resources, targetResourceId, targetSearch, token]);

  useEffect(() => {
    if (!compatibleMetrics.some(item => item.id === metricDefinitionId)) setMetricDefinitionId(compatibleMetrics[0]?.id ?? "");
  }, [compatibleMetrics, metricDefinitionId]);

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
      <label className="grid gap-1 text-xs font-bold">Find target<input className={`min-h-10 ${COMPACT_FIELD}`} value={targetSearch} onChange={event => setTargetSearch(event.target.value)} placeholder="Name or exact Cloudflare ID" /></label>
      <label className="grid gap-1 text-xs font-bold">Target<select required className={`min-h-10 ${COMPACT_FIELD}`} value={targetResourceId} onChange={event => setTargetResourceId(event.target.value)}>{targetCandidates.map(item => <option key={item.id} value={item.id}>{item.displayName} · {item.resourceType}</option>)}</select></label>
      <label className="grid gap-1 text-xs font-bold">Metric<select required className={`min-h-10 ${COMPACT_FIELD}`} value={metricDefinitionId} onChange={event => setMetricDefinitionId(event.target.value)}>{compatibleMetrics.map(item => <option key={item.id} value={item.id}>{item.displayName} · {item.productFamily}</option>)}</select></label>
      <label className="grid gap-1 text-xs font-bold">Measurement<select className={`min-h-10 ${COMPACT_FIELD}`} value={measurement} onChange={event => setMeasurement(event.target.value as AlertRuleView["measurement"])}><option value="usage">Usage</option><option value="estimated_cost">Estimated cost</option><option value="billed_cost">Billed cost</option></select></label>
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
