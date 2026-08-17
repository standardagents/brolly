import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { dateTime } from "../format";
import type { AlertLineView, AlertRuleView, LedgerMetricDefinition, LedgerResource } from "../types";
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
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError("");
    const [ruleResult, resourceResult, metricResult] = await Promise.all([
      api<{ rules: AlertRuleView[] }>("/api/alert-rules", token),
      api<{ resources: LedgerResource[] }>("/api/ledger/resources?limit=500", token),
      api<{ metricDefinitions: LedgerMetricDefinition[] }>("/api/metric-definitions", token),
    ]);
    setRules(ruleResult.rules);
    setResources(resourceResult.resources);
    setMetrics(metricResult.metricDefinitions);
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
        {creating && <CreateRuleForm token={token} resources={resources} metrics={metrics} onCreated={async () => { setCreating(false); await load(); }} />}
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
          onAutomation={updates => updateRule(rule, updates)}
          onDelete={() => removeRule(rule)}
        />
      )) : (
        <Panel><EmptyState icon="wallet" title="No ledger limits yet">Create a rule with Warning and Emergency lines or complete setup to migrate existing budgets.</EmptyState></Panel>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function RuleCard({ rule, targetResource, resourceName, token, onReload, onToggle, onAutomation, onDelete }: {
  rule: AlertRuleView;
  targetResource: LedgerResource | null;
  resourceName: string;
  token: string;
  onReload: () => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onAutomation: (updates: Partial<AlertRuleView>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const targetType = targetResource?.resourceType ?? rule.targetResourceType;
  const exactControlTarget = targetType?.endsWith(":resource") || targetType?.endsWith(":object");
  const aggregateControlTarget = Boolean(targetType) && !exactControlTarget;
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
          <thead><tr><Th>Line</Th><Th>Threshold</Th><Th>Action</Th><Th>Repeat</Th><Th>State</Th><Th /></tr></thead>
          <tbody>
            {rule.lines.map(line => <LineRow key={line.id} line={line} token={token} onReload={onReload} />)}
          </tbody>
        </Table>
      </TableScroll>
      <div className="flex flex-wrap items-start justify-between gap-4 border-t border-line-soft px-5 py-4">
        <div className="grid gap-2 text-xs text-muted">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={rule.autoQuarantine}
              disabled={!exactControlTarget}
              onChange={event => void onAutomation({ autoQuarantine: event.target.checked })}
            />
            Allow exact-resource quarantine after the confirmation window
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={rule.autoQuarantineContributors}
              disabled={!aggregateControlTarget}
              onChange={event => void onAutomation({ autoQuarantineContributors: event.target.checked })}
            />
            Allow deterministic contributor quarantine for aggregate targets
          </label>
          <small>Automatic controls still require complete, fresh, unsampled usage evidence, verified fuses, inherited permission, and rate-limit capacity.</small>
        </div>
        <Button onClick={() => setAdding(!adding)}>{adding ? "Close line form" : "Add threshold line"}</Button>
      </div>
      {adding && <AddLineForm ruleId={rule.id} token={token} onAdded={async () => { setAdding(false); await onReload(); }} />}
    </Panel>
  );
}

function LineRow({ line, token, onReload }: { line: AlertLineView; token: string; onReload: () => Promise<void> }) {
  const [value, setValue] = useState(String(line.thresholdValue));
  const [label, setLabel] = useState(line.label);
  const [color, setColor] = useState(line.color);
  const [priority, setPriority] = useState(String(line.priority));
  const [action, setAction] = useState<"notify" | "quarantine">(line.action ?? "notify");
  const [repeatHours, setRepeatHours] = useState(line.repeatIntervalMs ? String(line.repeatIntervalMs / 3_600_000) : "");
  const [enabled, setEnabled] = useState(line.enabled);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api(`/api/alert-lines/${encodeURIComponent(line.id)}`, token, {
        method: "PUT",
        body: JSON.stringify({
          ...line, label, color, priority: Number(priority), thresholdValue: Number(value), action,
          repeatIntervalMs: repeatHours ? Number(repeatHours) * 3_600_000 : null, enabled,
        }),
      });
      await onReload();
    } finally { setBusy(false); }
  }

  async function remove() {
    await api(`/api/alert-lines/${encodeURIComponent(line.id)}`, token, { method: "DELETE" });
    await onReload();
  }

  return (
    <Tr>
      <Td><span className="flex items-center gap-2"><input aria-label={`${label} color`} className={`size-8 ${COMPACT_FIELD}`} type="color" value={color} onChange={event => setColor(event.target.value)} /><span className="grid gap-1"><input className={`min-h-8 ${COMPACT_FIELD}`} value={label} onChange={event => setLabel(event.target.value)} /><label className="flex items-center gap-1 text-[10px] text-faint">Priority<input className={`w-16 px-1 ${COMPACT_FIELD}`} type="number" step="1" value={priority} onChange={event => setPriority(event.target.value)} /></label></span></span></Td>
      <Td><input className={`min-h-8 w-32 text-right ${COMPACT_FIELD}`} type="number" min="0" step="any" value={value} onChange={event => setValue(event.target.value)} /></Td>
      <Td><select className={`min-h-8 ${COMPACT_FIELD}`} value={action} onChange={event => setAction(event.target.value as typeof action)}><option value="notify">Notify</option><option value="quarantine">Quarantine</option></select></Td>
      <Td><label className="flex items-center gap-1"><input className={`min-h-8 w-20 text-right ${COMPACT_FIELD}`} type="number" min={1 / 60} step="any" value={repeatHours} onChange={event => setRepeatHours(event.target.value)} placeholder="Once" /><small>hours</small></label></Td>
      <Td><label className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{enabled ? "Enabled" : "Disabled"}</label></Td>
      <Td><span className="flex justify-end gap-2"><LinkButton disabled={busy} onClick={() => void save()}>Save</LinkButton><button type="button" className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[13px] font-[620] text-danger hover:underline" onClick={() => void remove()}>Remove</button></span></Td>
    </Tr>
  );
}

function CreateRuleForm({ token, resources, metrics, onCreated }: {
  token: string;
  resources: LedgerResource[];
  metrics: LedgerMetricDefinition[];
  onCreated: () => Promise<void>;
}) {
  const [targetResourceId, setTargetResourceId] = useState(resources[0]?.id ?? "");
  const [targetSearch, setTargetSearch] = useState("");
  const [targetCandidates, setTargetCandidates] = useState(resources);
  const [metricDefinitionId, setMetricDefinitionId] = useState(metrics[0]?.id ?? "");
  const [measurement, setMeasurement] = useState<AlertRuleView["measurement"]>("usage");
  const [period, setPeriod] = useState<AlertRuleView["period"]>("day");
  const [warning, setWarning] = useState("1");
  const [emergency, setEmergency] = useState("2");
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
          lines: [
            { label: "Warning", color: "#f59e0b", priority: 50, thresholdValue: Number(warning), action: "notify", repeatIntervalMs: null, enabled: true },
            { label: "Emergency", color: "#ef4444", priority: 100, thresholdValue: Number(emergency), action: "notify", repeatIntervalMs: 6 * 60 * 60_000, enabled: true },
          ],
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
      <label className="grid gap-1 text-xs font-bold">Warning<input required type="number" min="0" step="any" className={`min-h-10 ${COMPACT_FIELD}`} value={warning} onChange={event => setWarning(event.target.value)} /></label>
      <label className="grid gap-1 text-xs font-bold">Emergency<input required type="number" min="0" step="any" className={`min-h-10 ${COMPACT_FIELD}`} value={emergency} onChange={event => setEmergency(event.target.value)} /></label>
      <div className="flex items-end"><Button variant="primary" type="submit">Create limit</Button></div>
      {error && <Notice tone="error" className="md:col-span-2 xl:col-span-4">{error}</Notice>}
    </form>
  );
}

function AddLineForm({ ruleId, token, onAdded }: { ruleId: string; token: string; onAdded: () => Promise<void> }) {
  const [label, setLabel] = useState("Critical");
  const [thresholdValue, setThresholdValue] = useState("1.5");
  const [color, setColor] = useState("#dc6b24");
  const [priority, setPriority] = useState("75");
  return (
    <form className="flex flex-wrap items-end gap-3 border-t border-line-soft px-5 py-4" onSubmit={event => {
      event.preventDefault();
      void api(`/api/alert-rules/${encodeURIComponent(ruleId)}/lines`, token, {
        method: "POST",
        body: JSON.stringify({ label, thresholdValue: Number(thresholdValue), color, priority: Number(priority), action: "notify", repeatIntervalMs: null, enabled: true }),
      }).then(onAdded);
    }}>
      <label className="grid gap-1 text-xs font-bold">Label<input required className={`min-h-9 ${COMPACT_FIELD}`} value={label} onChange={event => setLabel(event.target.value)} /></label>
      <label className="grid gap-1 text-xs font-bold">Threshold<input required type="number" min="0" step="any" className={`min-h-9 ${COMPACT_FIELD}`} value={thresholdValue} onChange={event => setThresholdValue(event.target.value)} /></label>
      <label className="grid gap-1 text-xs font-bold">Priority<input required type="number" min="0" className={`min-h-9 w-24 ${COMPACT_FIELD}`} value={priority} onChange={event => setPriority(event.target.value)} /></label>
      <label className="grid gap-1 text-xs font-bold">Color<input type="color" className={`h-9 w-16 ${COMPACT_FIELD}`} value={color} onChange={event => setColor(event.target.value)} /></label>
      <Button variant="primary" type="submit">Add line</Button>
    </form>
  );
}

function selectorName(rule: AlertRuleView): string {
  return rule.targetSelector ? Object.entries(rule.targetSelector).map(([key, value]) => `${key}: ${value}`).join(", ") : "Resource selector";
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
