import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { compactId, dateTime, relativeTime } from "../format";
import type { LedgerResource } from "../types";
import { Drawer, EmptyState, Icon, ProductIcon } from "../components/ui";
import type { Route } from "../router";
import { QualityBadge } from "./UsagePage";

export function ResourcesPage({ token, onNavigate }: { token: string; onNavigate: (route: Route) => void }) {
  const [resources, setResources] = useState<LedgerResource[]>([]);
  const [families, setFamilies] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [family, setFamily] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<LedgerResource | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (append = false) => {
    const params = new URLSearchParams({ limit: "500" });
    if (family) params.set("family", family);
    if (search.trim()) params.set("q", search.trim());
    if (append && nextCursor) params.set("cursor", nextCursor);
    const result = await api<{ resources: LedgerResource[]; families: string[]; nextCursor: string | null }>(`/api/ledger/resources?${params}`, token);
    setResources(current => append ? [...current, ...result.resources] : result.resources);
    setFamilies(result.families);
    setNextCursor(result.nextCursor);
    setSelected(current => current ? result.resources.find(item => item.id === current.id) ?? (append ? current : null) : null);
  }, [family, nextCursor, search, token]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(false).catch(cause => setError(message(cause))), search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [family, search, token]);

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Canonical inventory</p>
            <h2>Resources and protection inheritance</h2>
            <p className="panel-sub">Automatic-quarantine policy follows the account hierarchy. A denied or excluded ancestor blocks automatic controls for every descendant.</p>
          </div>
          <button className="button secondary" type="button" onClick={() => onNavigate("usage")}><Icon name="trend" /> Usage history</button>
        </div>
        <div className="asset-toolbar px-5 pb-3">
          <label className="search-field"><Icon name="search" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a resource" /></label>
          <select value={family} onChange={event => setFamily(event.target.value)} aria-label="Product family">
            <option value="">All products</option>
            {families.map(item => <option key={item} value={item}>{display(item)}</option>)}
          </select>
        </div>
        {resources.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Resource</th><th>Type</th><th>Coverage</th><th>Control</th><th>Automatic policy</th><th>Last active</th><th /></tr></thead>
              <tbody>{resources.map(resource => (
                <tr className="clickable" key={resource.id} onClick={() => setSelected(resource)}>
                  <td><span className="cell-main"><strong className="flex items-center gap-2"><ProductIcon family={resource.productFamily} />{resource.displayName}</strong><small>{compactId(resource.cloudflareId)} · {resource.childCount} children</small></span></td>
                  <td>{scope(resource.resourceType)}</td>
                  <td><QualityBadge quality={resource.coverageStatus} /></td>
                  <td><span className="cell-main"><strong>{resource.controlCapability.replaceAll("_", " ")}</strong><small>Fuse {resource.runtimeFuseStatus}</small></span></td>
                  <td>{resource.excluded ? "Excluded" : resource.autoQuarantinePolicy}</td>
                  <td>{resource.lastActiveAt ? relativeTime(resource.lastActiveAt) : "No activity observed"}</td>
                  <td><button className="link-button" type="button" onClick={event => { event.stopPropagation(); setSelected(resource); }}>Details <Icon name="arrow" /></button></td>
                </tr>
              ))}</tbody>
            </table>
            {nextCursor && <div className="flex justify-center border-t border-[var(--line-soft)] p-3"><button className="button secondary" type="button" onClick={() => void load(true)}>Load more resources</button></div>}
          </div>
        ) : <EmptyState icon="layers" title="No matching resources">Inventory and billing catchalls appear after their collectors run.</EmptyState>}
        {error && <p className="form-error m-5">{error}</p>}
      </section>
      {selected && <ResourceDrawer resource={selected} token={token} onClose={() => setSelected(null)} onChanged={load} onUsage={() => { setSelected(null); onNavigate("usage"); }} />}
    </>
  );
}

function ResourceDrawer({ resource, token, onClose, onChanged, onUsage }: {
  resource: LedgerResource;
  token: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onUsage: () => void;
}) {
  const [policy, setPolicy] = useState(resource.autoQuarantinePolicy);
  const [excluded, setExcluded] = useState(resource.excluded);
  const [tier, setTier] = useState(resource.tier);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/ledger/resources/${encodeURIComponent(resource.id)}/protection`, token, {
        method: "PUT",
        body: JSON.stringify({ policy, excluded, tier }),
      });
      await onChanged();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  }

  return (
    <Drawer
      onClose={onClose}
      labelledBy="resource-title"
      header={<div><p className="eyebrow">{display(resource.productFamily)} · {scope(resource.resourceType)}</p><h2 id="resource-title">{resource.displayName}</h2><p>{resource.cloudflareId}</p></div>}
      footer={<button className="button secondary" onClick={onClose}>Done</button>}
    >
      <section className="detail-block">
        <h3>Ledger state</h3>
        <dl>
          <div><dt>Coverage</dt><dd><QualityBadge quality={resource.coverageStatus} /></dd></div>
          <div><dt>First seen</dt><dd>{dateTime(resource.firstSeenAt)}</dd></div>
          <div><dt>Last inventoried</dt><dd>{dateTime(resource.lastSeenAt)}</dd></div>
          <div><dt>Last active</dt><dd>{dateTime(resource.lastActiveAt)}</dd></div>
          <div><dt>Oldest day</dt><dd>{resource.oldestDay ?? "History pending"}</dd></div>
          <div><dt>Open alerts</dt><dd>{resource.openAlerts}</dd></div>
        </dl>
        <button className="button secondary full" type="button" onClick={onUsage}>Open usage explorer</button>
      </section>
      <section className="detail-block">
        <h3>Automatic control boundary</h3>
        <label>Policy<select value={policy} onChange={event => setPolicy(event.target.value as LedgerResource["autoQuarantinePolicy"])}><option value="inherit">Inherit</option><option value="allow">Allow when a rule opts in</option><option value="deny">Deny for this subtree</option></select></label>
        <label>Protection tier<select value={tier} onChange={event => setTier(event.target.value as LedgerResource["tier"])}><option value="unclassified">Unclassified</option><option value="control_plane">Control plane</option><option value="critical">Critical</option><option value="standard">Standard</option><option value="disposable">Disposable</option></select></label>
        <label className="runtime-confirm"><input type="checkbox" checked={excluded} onChange={event => setExcluded(event.target.checked)} /> Exclude this resource and descendants from automatic quarantine</label>
        <small>Rules remain able to alert and prepare operator-reviewed controls. Runtime fuse verification and complete fresh evidence are still required for automatic execution.</small>
        {error && <p className="form-error">{error}</p>}
        <button className="button primary full" disabled={busy} type="button" onClick={() => void save()}>{busy ? "Saving…" : "Save protection boundary"}</button>
      </section>
    </Drawer>
  );
}

function scope(value: string): string {
  return value === "account" || value === "product" ? display(value) : display(value.split(":").at(-1) ?? value);
}

function display(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
