import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Drawer, EmptyState, Icon, InfoTip, ProductIcon } from "../components/ui";
import { compactId, dateTime, money, relativeTime } from "../format";
import { tierDescription, tierLabel } from "../lib/meta";
import type { Route } from "../router";
import type { Asset, AssetTier, DashboardData } from "../types";

const TIER_OPTIONS: AssetTier[] = ["unclassified", "control_plane", "critical", "standard", "disposable"];

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
      <section className="family-strip" aria-label="Discovered products">
        {data.assets.families.map(item => (
          <button
            type="button"
            key={item.family}
            className={`family-chip ${family === item.family ? "active" : ""}`}
            onClick={() => setFamily(family === item.family ? "" : item.family)}
            aria-pressed={family === item.family}
          >
            <ProductIcon family={item.family} tone={family === item.family ? "orange" : "neutral"} />
            <span>
              <strong>{item.label}</strong>
              <small>{item.assets} discovered{item.gaps ? ` · ${item.gaps} coverage gap${item.gaps === 1 ? "" : "s"}` : ""}</small>
            </span>
            <b>{item.assets}</b>
          </button>
        ))}
      </section>

      <section className="panel" aria-label="Asset inventory">
        <div className="panel-head">
          <div>
            <h2 className="heading-with-info">
              Inventory
              <InfoTip label="How does asset inventory work?">
                <h4>One bounded account inventory</h4>
                <p>Brolly asks Cloudflare's control-plane APIs for resource lists; it does not invoke every Worker or wake individual Durable Objects.</p>
                <p>Rows are discovered resources, not billable usage. Classification here decides which stops Brolly may ever prepare: control-plane and critical assets only alert.</p>
              </InfoTip>
            </h2>
            <p className="panel-sub">
              {data.summary.assets} discovered resources.
              {unclassified > 0 && <> <button type="button" className="link-button inline" onClick={() => setTier("unclassified")}>{unclassified} need classification</button>.</>}
            </p>
          </div>
          <div className="asset-toolbar">
            <label className="search-field">
              <Icon name="search" />
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search name or ID"
                aria-label="Search assets"
              />
            </label>
            <select value={tier} onChange={event => setTier(event.target.value)} aria-label="Filter by protection tier">
              <option value="">All tiers</option>
              {TIER_OPTIONS.map(option => <option key={option} value={option}>{tierLabel(option)}</option>)}
            </select>
          </div>
        </div>

        {error && <p className="form-error page-error">{error}</p>}
        {!assets ? (
          <p className="loading-inline">Loading inventory…</p>
        ) : assets.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Asset</th>
                  <th scope="col">Tier</th>
                  <th scope="col">Daily budget</th>
                  <th scope="col">Open incidents</th>
                  <th scope="col">Last signal</th>
                  <th scope="col"><span className="visually-hidden">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {assets.map(asset => {
                  const budget = data.policy.assetDailySpend[assetBudgetKey(asset)];
                  return (
                    <tr key={`${asset.family}:${asset.id}`} className="clickable" onClick={() => setSelected(asset)}>
                      <td>
                        <span className="cell-with-icon">
                          <ProductIcon family={asset.family} />
                          <span className="cell-main">
                            <strong>{asset.name ?? compactId(asset.id)}</strong>
                            <small>{scopeLabel(asset)}</small>
                          </span>
                        </span>
                      </td>
                      <td><span className={`tier-badge ${asset.tier}`}>{tierLabel(asset.tier)}</span></td>
                      <td className="numeric">{budget ? `${money(budget.emergency)} emergency` : "Product default"}</td>
                      <td className="numeric">{asset.incidentCount ? <span className="incident-count">{asset.incidentCount}</span> : "0"}</td>
                      <td>{asset.lastSignalAt ? relativeTime(asset.lastSignalAt) : "No samples yet"}</td>
                      <td className="row-open">
                        <button type="button" className="link-button" onClick={event => { event.stopPropagation(); setSelected(asset); }}>
                          Details <Icon name="arrow" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon="search" title="No matching assets">
            {search || family || tier ? "Try a different search or filter." : "Run an account scan to discover resources."}
          </EmptyState>
        )}
      </section>

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
  const [workerScript, setWorkerScript] = useState(asset.tags.workerScript ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const fuseCapable = asset.family === "durable_objects" || asset.family === "workers";
  const effectiveBudget = budget ?? familyBudget;

  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const tags = fuseCapable
        ? workerScript.trim()
          ? { workerScript: workerScript.trim(), brollyFuse: "true" }
          : { workerScript: null, brollyFuse: null }
        : {};
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
          <span className={`tier-badge ${asset.tier}`}>{tierLabel(asset.tier)}</span>
          <h2 id="asset-drawer-title">{asset.name ?? compactId(asset.id)}</h2>
          <p>{scopeLabel(asset)}</p>
        </div>
      }
      footer={<button type="button" className="button secondary" onClick={onClose}>Done</button>}
    >
      <section className="detail-block">
        <h3>Details</h3>
        <dl>
          <div><dt>Resource ID</dt><dd><code>{asset.id}</code></dd></div>
          {asset.parentId && <div><dt>Parent</dt><dd><code>{asset.parentId}</code></dd></div>}
          <div><dt>Discovered</dt><dd>{dateTime(asset.discoveredAt)}</dd></div>
          <div><dt>Last inventoried</dt><dd>{dateTime(asset.seenAt)}</dd></div>
          <div><dt>Last telemetry</dt><dd>{asset.lastSignalAt ? dateTime(asset.lastSignalAt) : "No samples recorded"}</dd></div>
          <div><dt>Open incidents</dt><dd>{asset.incidentCount}</dd></div>
        </dl>
        {cloudflareUrl && (
          <a className="button secondary full" href={cloudflareUrl} target="_blank" rel="noreferrer">
            Open in Cloudflare <Icon name="external" />
          </a>
        )}
      </section>

      <section className="detail-block">
        <h3>Daily budget</h3>
        {effectiveBudget ? (
          <p>
            {budget ? "This resource has its own budget: " : "Inherits the product-family budget: "}
            warns at {money(effectiveBudget.warning)}, critical at {money(effectiveBudget.critical)}, emergency at {money(effectiveBudget.emergency)} per rolling day.
          </p>
        ) : (
          <p>No budget is set for this resource or its product family yet; only account-level limits apply.</p>
        )}
        <button type="button" className="button secondary full" onClick={onBudgets}>Edit budgets</button>
      </section>

      <section className="detail-block">
        <h3>Protection tier</h3>
        <p>The tier decides which controls Brolly may ever prepare for this asset.</p>
        <label>
          Tier
          <select value={tier} onChange={event => setTier(event.target.value as AssetTier)}>
            {TIER_OPTIONS.map(option => <option key={option} value={option}>{tierLabel(option)}</option>)}
          </select>
          <small>{tierDescription(tier)}</small>
        </label>
        {fuseCapable && (
          <label>
            Owning Worker script (runtime fuse)
            <input
              type="text"
              value={workerScript}
              onChange={event => setWorkerScript(event.target.value)}
              placeholder={asset.family === "workers" ? asset.id : "my-worker"}
            />
            <small>
              Set this only after installing @standardagents/brolly-runtime and the BROLLY_FUSE secret in that Worker.
              Verify the installation on the <button type="button" className="link-button inline" onClick={() => { onClose(); onNavigate("configuration"); }}>Configuration page</button>.
            </small>
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        {saved && <p className="form-success" role="status">Classification saved.</p>}
        <button type="button" className="button primary full" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save classification"}
        </button>
      </section>
    </Drawer>
  );
}
