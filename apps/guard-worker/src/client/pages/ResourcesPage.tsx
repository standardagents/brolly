import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { compactId, dateTime, relativeTime } from "../format";
import type { LedgerResource } from "../types";
import { Button, CellStack, DetailBlock, Drawer, EmptyState, Eyebrow, Field, Icon, LinkButton, Notice, Panel, PanelHead, ProductIcon, Select, Table, TableScroll, Td, Th, Tr } from "../components/ui";
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
      <Panel>
        <PanelHead
          eyebrow="Canonical inventory"
          title="Resources and protection inheritance"
          sub="Automatic-quarantine policy follows the account hierarchy. A denied or excluded ancestor blocks automatic controls for every descendant."
          actions={<Button variant="secondary" onClick={() => onNavigate("usage")}><Icon name="trend" /> Usage history</Button>}
        />
        <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
          <label className="flex min-h-9 items-center gap-[7px] rounded-field border border-field-line bg-panel px-2.5 focus-within:border-orange focus-within:shadow-[0_0_0_3px_#f6821f1f]">
            <Icon name="search" className="size-[15px] text-faint" />
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Find a resource"
              className="min-w-[190px] border-0 bg-transparent text-[13px] outline-none"
            />
          </label>
          <select
            value={family}
            onChange={event => setFamily(event.target.value)}
            aria-label="Product family"
            className="min-h-9 rounded-field border border-field-line bg-panel px-2.5 text-[13px] text-ink"
          >
            <option value="">All products</option>
            {families.map(item => <option key={item} value={item}>{display(item)}</option>)}
          </select>
        </div>
        {resources.length ? (
          <TableScroll>
            <Table>
              <thead><tr><Th>Resource</Th><Th>Type</Th><Th>Coverage</Th><Th>Control</Th><Th>Automatic policy</Th><Th>Last active</Th><Th /></tr></thead>
              <tbody>{resources.map(resource => (
                <Tr clickable key={resource.id} onClick={() => setSelected(resource)}>
                  <Td>
                    <CellStack
                      titleClassName="flex items-center gap-2"
                      title={<><ProductIcon family={resource.productFamily} />{resource.displayName}</>}
                      sub={<>{compactId(resource.cloudflareId)} · {resource.childCount} children</>}
                    />
                  </Td>
                  <Td>{scope(resource.resourceType)}</Td>
                  <Td><QualityBadge quality={resource.coverageStatus} /></Td>
                  <Td><CellStack title={resource.controlCapability.replaceAll("_", " ")} sub={`Breaker ${resource.runtimeFuseStatus}`} /></Td>
                  <Td>{resource.excluded ? "Excluded" : resource.autoQuarantinePolicy}</Td>
                  <Td>{resource.lastActiveAt ? relativeTime(resource.lastActiveAt) : "No activity observed"}</Td>
                  <Td className="whitespace-nowrap text-right">
                    <LinkButton onClick={event => { event.stopPropagation(); setSelected(resource); }}>Details <Icon name="arrow" /></LinkButton>
                  </Td>
                </Tr>
              ))}</tbody>
            </Table>
            {nextCursor && <div className="flex justify-center border-t border-line-soft p-3"><Button variant="secondary" onClick={() => void load(true)}>Load more resources</Button></div>}
          </TableScroll>
        ) : <EmptyState icon="layers" title="No matching resources">Inventory and billing catchalls appear after their collectors run.</EmptyState>}
        {error && <Notice tone="error" className="m-5">{error}</Notice>}
      </Panel>
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

  const detailRow = "grid grid-cols-[125px_1fr] gap-2.5 border-t border-line-soft py-2 text-[12.5px]";

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
      header={<div><Eyebrow>{display(resource.productFamily)} · {scope(resource.resourceType)}</Eyebrow><h2 id="resource-title">{resource.displayName}</h2><p>{resource.cloudflareId}</p></div>}
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}
    >
      <DetailBlock title="Ledger state">
        <dl className="my-3">
          <div className={detailRow}><dt className="text-faint">Coverage</dt><dd className="m-0 min-w-0 break-all"><QualityBadge quality={resource.coverageStatus} /></dd></div>
          <div className={detailRow}><dt className="text-faint">First seen</dt><dd className="m-0 min-w-0 break-all">{dateTime(resource.firstSeenAt)}</dd></div>
          <div className={detailRow}><dt className="text-faint">Last inventoried</dt><dd className="m-0 min-w-0 break-all">{dateTime(resource.lastSeenAt)}</dd></div>
          <div className={detailRow}><dt className="text-faint">Last active</dt><dd className="m-0 min-w-0 break-all">{dateTime(resource.lastActiveAt)}</dd></div>
          <div className={detailRow}><dt className="text-faint">Oldest day</dt><dd className="m-0 min-w-0 break-all">{resource.oldestDay ?? "History pending"}</dd></div>
          <div className={detailRow}><dt className="text-faint">Open alerts</dt><dd className="m-0 min-w-0 break-all">{resource.openAlerts}</dd></div>
        </dl>
        <Button variant="secondary" full onClick={onUsage}>Open usage explorer</Button>
      </DetailBlock>
      <DetailBlock title="Automatic control boundary">
        <Field label="Policy">
          <Select value={policy} onChange={event => setPolicy(event.target.value as LedgerResource["autoQuarantinePolicy"])}>
            <option value="inherit">Inherit</option>
            <option value="allow">Allow when a rule opts in</option>
            <option value="deny">Deny for this subtree</option>
          </Select>
        </Field>
        <Field label="Protection tier">
          <Select value={tier} onChange={event => setTier(event.target.value as LedgerResource["tier"])}>
            <option value="unclassified">Unclassified</option>
            <option value="control_plane">Control plane</option>
            <option value="critical">Critical</option>
            <option value="standard">Standard</option>
            <option value="disposable">Disposable</option>
          </Select>
        </Field>
        <label className="my-[13px] inline-flex items-center gap-2 text-[12.5px] font-[650] whitespace-nowrap">
          <input type="checkbox" checked={excluded} onChange={event => setExcluded(event.target.checked)} className="size-[15px] accent-orange" /> Exclude this resource and descendants from automatic quarantine
        </label>
        <small className="block text-[12.5px] leading-[1.5] text-muted">Rules remain able to alert and prepare operator-reviewed controls. Circuit breaker verification and complete fresh evidence are still required for automatic execution.</small>
        {error && <Notice tone="error">{error}</Notice>}
        <Button variant="primary" full disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save protection boundary"}</Button>
      </DetailBlock>
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
