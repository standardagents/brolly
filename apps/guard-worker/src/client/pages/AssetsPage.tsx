import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Button, DetailBlock, Drawer, EmptyState, ExternalAction, Icon, InfoTip, LinkButton, Notice, Panel, PanelHead, Pill, ProductIcon, Select, Table, TableScroll, Td, Th, Tr, type Tone } from "../components/ui";
import { compactId, dateTime, money, relativeTime } from "../format";
import { tierDescription, tierLabel } from "../lib/meta";
import type { Route } from "../router";
import type { Asset, AssetTier, DashboardData } from "../types";

const TIER_OPTIONS: AssetTier[] = ["unclassified", "control_plane", "critical", "standard", "disposable"];

const TIER_TONE: Record<string, Tone> = {
  control_plane: "blue",
  critical: "danger",
  standard: "good",
  disposable: "purple",
  unclassified: "warn",
};

/** Protection-tier badge: the square tag shape in sentence case at the old 11px size. */
function TierBadge({ tier }: { tier: AssetTier }) {
  return (
    <Pill tone={TIER_TONE[tier] ?? "neutral"} shape="tag" className="text-[11px] font-[720] tracking-normal normal-case">
      {tierLabel(tier)}
    </Pill>
  );
}

function assetBudgetKey(asset: Pick<Asset, "family" | "scope" | "id">): string {
  return `${asset.family}:${asset.scope}:${asset.id}`;
}

export function AssetsPage({ data, token, onNavigate, onBudgets }: {
  data: DashboardData;
  token: string;
  onNavigate: (route: Route) => void;
  onBudgets: () => void;
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [family, setFamily] = useState("");
  const [tier, setTier] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Asset | null>(null);

  const load = useCallback(async () => {
    setError("");
    const params = new URLSearchParams();
    if (family) params.set("family", family);
    if (tier) params.set("tier", tier);
    if (search.trim()) params.set("search", search.trim());
    params.set("limit", "250");
    try {
      const result = await api<{ assets: Asset[] }>(`/api/assets?${params}`, token);
      setAssets(result.assets);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [token, family, tier, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  const unclassified = data.assets.tiers.unclassified ?? 0;

  return (
    <>
      <section className="mb-4 grid grid-cols-[repeat(auto-fill,minmax(252px,1fr))] gap-2.5" aria-label="Discovered products">
        {data.assets.families.map(item => {
          const active = family === item.family;
          return (
            <button
              type="button"
              key={item.family}
              className={`flex cursor-pointer items-center gap-2.5 rounded-panel border bg-panel px-3 py-2.5 text-left transition-[border-color] duration-[130ms] ${
                active
                  ? "border-orange shadow-[0_0_0_1px_var(--orange)]"
                  : "border-line hover:border-[#b9c1ca] dark:hover:border-[#59626d]"
              }`}
              onClick={() => setFamily(active ? "" : item.family)}
              aria-pressed={active}
            >
              <ProductIcon family={item.family} tone={active ? "orange" : "neutral"} />
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <strong className="truncate text-[13px]">{item.label}</strong>
                <small className="truncate text-[11.5px] text-faint">{item.assets} discovered{item.gaps ? ` · ${item.gaps} coverage gap${item.gaps === 1 ? "" : "s"}` : ""}</small>
              </span>
              <b className="text-[17px] tabular-nums">{item.assets}</b>
            </button>
          );
        })}
      </section>

      <Panel aria-label="Asset inventory">
        <PanelHead
          title="Inventory"
          titleExtra={
            <InfoTip label="How does asset inventory work?">
              <h4>One bounded account inventory</h4>
              <p>Brolly asks Cloudflare's control-plane APIs for resource lists; it does not invoke every Worker or wake individual Durable Objects.</p>
              <p>Rows are discovered resources, not billable usage. Classification here decides which stops Brolly may ever prepare: control-plane and critical assets only alert.</p>
            </InfoTip>
          }
          sub={
            <>
              {data.summary.assets} discovered resources.
              {unclassified > 0 && <> <LinkButton inline onClick={() => setTier("unclassified")}>{unclassified} need classification</LinkButton>.</>}
            </>
          }
          actions={
            <>
              <label className="flex min-h-9 items-center gap-[7px] rounded-field border border-field-line bg-panel px-2.5 focus-within:border-orange focus-within:shadow-[0_0_0_3px_#f6821f1f]">
                <Icon name="search" className="size-[15px] text-faint" />
                <input
                  type="search"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Search name or ID"
                  aria-label="Search assets"
                  className="min-w-[190px] border-0 bg-transparent text-[13px] outline-none"
                />
              </label>
              <select
                value={tier}
                onChange={event => setTier(event.target.value)}
                aria-label="Filter by protection tier"
                className="min-h-9 rounded-field border border-field-line bg-panel px-2.5 text-[13px] text-ink"
              >
                <option value="">All tiers</option>
                {TIER_OPTIONS.map(option => <option key={option} value={option}>{tierLabel(option)}</option>)}
              </select>
            </>
          }
        />

        {error && <Notice tone="error" className="mx-5 mb-3.5 [overflow-wrap:anywhere]">{error}</Notice>}
        {!assets ? (
          <p className="px-5 py-2.5 text-[13px] text-muted">Loading inventory…</p>
        ) : assets.length ? (
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th scope="col">Asset</Th>
                  <Th scope="col">Tier</Th>
                  <Th scope="col">Daily budget</Th>
                  <Th scope="col">Open incidents</Th>
                  <Th scope="col">Last signal</Th>
                  <Th scope="col"><span className="sr-only">Open</span></Th>
                </tr>
              </thead>
              <tbody>
                {assets.map(asset => {
                  const budget = data.policy.assetDailySpend[assetBudgetKey(asset)];
                  return (
                    <Tr key={`${asset.family}:${asset.id}`} clickable onClick={() => setSelected(asset)}>
                      <Td>
                        <span className="flex min-w-0 items-center gap-[11px]">
                          <ProductIcon family={asset.family} />
                          <span className="flex min-w-0 flex-col gap-[3px]">
                            <strong className="max-w-[46ch] truncate">{asset.name ?? compactId(asset.id)}</strong>
                            <small className="text-[12px] text-faint">{scopeLabel(asset)}</small>
                          </span>
                        </span>
                      </Td>
                      <Td><TierBadge tier={asset.tier} /></Td>
                      <Td numeric>{budget ? `${money(budget.emergency)} emergency` : "Product default"}</Td>
                      <Td numeric>
                        {asset.incidentCount
                          ? <span className="inline-block min-w-[22px] rounded-full bg-danger-bg px-[7px] py-0.5 text-center font-[750] text-danger">{asset.incidentCount}</span>
                          : "0"}
                      </Td>
                      <Td>{asset.lastSignalAt ? relativeTime(asset.lastSignalAt) : "No samples yet"}</Td>
                      <Td className="whitespace-nowrap text-right">
                        <LinkButton onClick={event => { event.stopPropagation(); setSelected(asset); }}>
                          Details <Icon name="arrow" />
                        </LinkButton>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableScroll>
        ) : (
          <EmptyState icon="search" title="No matching assets">
            {search || family || tier ? "Try a different search or filter." : "Run an account scan to discover resources."}
          </EmptyState>
        )}
      </Panel>

      {selected && (
        <AssetDrawer
          asset={selected}
          budget={data.policy.assetDailySpend[assetBudgetKey(selected)] ?? null}
          familyBudget={data.policy.familyDailySpend[selected.family] ?? null}
          cloudflareUrl={data.assets.families.find(item => item.family === selected.family)?.cloudflareUrl}
          token={token}
          onClose={() => setSelected(null)}
          onBudgets={onBudgets}
          onNavigate={onNavigate}
          onChanged={load}
        />
      )}
    </>
  );
}

function scopeLabel(asset: Asset): string {
  if (asset.family === "durable_objects") {
    return asset.scope === "namespace" ? "Durable Object namespace" : `Durable Object · namespace ${asset.parentId ? compactId(asset.parentId) : "unknown"}`;
  }
  if (asset.family === "workers") return "Worker script";
  return `${asset.scope === "zone" ? "Zone" : "Resource"} · ${asset.family.replaceAll("_", " ")}`;
}

function AssetDrawer({ asset, budget, familyBudget, cloudflareUrl, token, onClose, onBudgets, onNavigate, onChanged }: {
  asset: Asset;
  budget: { warning: number; critical: number; emergency: number } | null;
  familyBudget: { warning: number; critical: number; emergency: number } | null;
  cloudflareUrl?: string;
  token: string;
  onClose: () => void;
  onBudgets: () => void;
  onNavigate: (route: Route) => void;
  onChanged: () => Promise<void>;
}) {
  const [tier, setTier] = useState<AssetTier>(asset.tier);
  const owningWorker = asset.family === "workers" ? asset.id : asset.tags.cloudflareWorkerScript ?? "";
  const [fuseInstalled, setFuseInstalled] = useState(asset.tags.brollyFuse === "true");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const fuseCapable = asset.family === "durable_objects" || asset.family === "workers";
  const effectiveBudget = budget ?? familyBudget;

  const detailRow = "grid grid-cols-[125px_1fr] gap-2.5 border-t border-line-soft py-2 text-[12.5px]";

  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const tags = fuseCapable ? { brollyFuse: fuseInstalled ? "true" : null } : {};
      await api(`/api/assets/${encodeURIComponent(asset.family)}/${encodeURIComponent(asset.id)}`, token, {
        method: "PATCH",
        body: JSON.stringify({ tier, tags }),
      });
      setSaved(true);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      onClose={onClose}
      labelledBy="asset-drawer-title"
      header={
        <div>
          <TierBadge tier={asset.tier} />
          <h2 id="asset-drawer-title">{asset.name ?? compactId(asset.id)}</h2>
          <p>{scopeLabel(asset)}</p>
        </div>
      }
      footer={<Button variant="secondary" onClick={onClose}>Done</Button>}
    >
      <DetailBlock title="Details">
        <dl className="my-3">
          <div className={detailRow}><dt className="text-faint">Resource ID</dt><dd className="m-0 min-w-0 break-all"><code>{asset.id}</code></dd></div>
          {asset.parentId && <div className={detailRow}><dt className="text-faint">Parent</dt><dd className="m-0 min-w-0 break-all"><code>{asset.parentId}</code></dd></div>}
          <div className={detailRow}><dt className="text-faint">Discovered</dt><dd className="m-0 min-w-0 break-all">{dateTime(asset.discoveredAt)}</dd></div>
          <div className={detailRow}><dt className="text-faint">Last inventoried</dt><dd className="m-0 min-w-0 break-all">{dateTime(asset.seenAt)}</dd></div>
          <div className={detailRow}><dt className="text-faint">Last telemetry</dt><dd className="m-0 min-w-0 break-all">{asset.lastSignalAt ? dateTime(asset.lastSignalAt) : "No samples recorded"}</dd></div>
          <div className={detailRow}><dt className="text-faint">Open incidents</dt><dd className="m-0 min-w-0 break-all">{asset.incidentCount}</dd></div>
        </dl>
        {cloudflareUrl && (
          <ExternalAction href={cloudflareUrl}>
            Open in Cloudflare <Icon name="external" />
          </ExternalAction>
        )}
      </DetailBlock>

      <DetailBlock title="Daily budget">
        {effectiveBudget ? (
          <p className="mt-0 mb-2.5 text-[13px] leading-[1.55] text-muted">
            {budget ? "This resource has its own budget: " : "Inherits the product-family budget: "}
            warns at {money(effectiveBudget.warning)}, critical at {money(effectiveBudget.critical)}, emergency at {money(effectiveBudget.emergency)} per rolling day.
          </p>
        ) : (
          <p className="mt-0 mb-2.5 text-[13px] leading-[1.55] text-muted">No budget is set for this resource or its product family yet; only account-level limits apply.</p>
        )}
        <Button variant="secondary" full onClick={onBudgets}>Edit budgets</Button>
      </DetailBlock>

      <DetailBlock title="Protection tier">
        <p className="mt-0 mb-2.5 text-[13px] leading-[1.55] text-muted">The tier decides which controls Brolly may ever prepare for this asset.</p>
        <label className="my-[13px] flex flex-col gap-1.5 text-[13px] font-[680]">
          Tier
          <Select value={tier} onChange={event => setTier(event.target.value as AssetTier)}>
            {TIER_OPTIONS.map(option => <option key={option} value={option}>{tierLabel(option)}</option>)}
          </Select>
          <small className="font-[450] leading-[1.5] text-muted">{tierDescription(tier)}</small>
        </label>
        {fuseCapable && (
          <div>
            <strong>Owning Worker</strong>
            <p className="mt-0 mb-2.5 text-[13px] leading-[1.55] text-muted"><code>{owningWorker || "Not reported by Cloudflare"}</code></p>
            <label className="my-[13px] inline-flex items-center gap-2 text-[12.5px] font-[650] whitespace-nowrap">
              <input
                type="checkbox"
                checked={fuseInstalled}
                disabled={!owningWorker}
                onChange={event => setFuseInstalled(event.target.checked)}
                className="size-[15px] accent-orange"
              /> Runtime fuse installed
            </label>
            <small className="block text-[12.5px] font-[450] leading-[1.5] text-muted">
              Worker ownership comes from Cloudflare inventory and cannot be typed or overridden. Confirm the fuse only after installing @standardagents/brolly-runtime and BROLLY_FUSE.
              Verify the installation on the <LinkButton inline onClick={() => { onClose(); onNavigate("configuration"); }}>Configuration page</LinkButton>.
            </small>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {saved && <Notice tone="success" role="status">Classification saved.</Notice>}
        <Button variant="primary" full disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save classification"}
        </Button>
      </DetailBlock>
    </Drawer>
  );
}
