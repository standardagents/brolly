import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Button, Icon, ProductIcon } from "../components/ui";
import type { ConfigurationData, OnboardingData } from "../types";
import type { RuntimeIntegration } from "./model";

const MACHINE_CHECKS = ["apiAccess", "fuseSecret", "runtimeBundle", "activeDeployment"] as const;
/** The backend refuses more Worker scripts than this per verify request. */
const MAX_SCRIPTS_PER_VERIFY = 5;

type VerifyResult = { verified: boolean; detail: string };

/** One discovered resource: product glyph, name, and a supporting line. */
function ResourceLabel({ family, name, children }: { family: string; name: string; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ProductIcon family={family} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <strong className="truncate text-[13.5px]">{name}</strong>
        <small className="text-[12px] text-faint">{children}</small>
      </span>
    </span>
  );
}

/** Right-hand cell: the resource's verification state. */
function VerifyBadge({ result, busy }: { result: VerifyResult | undefined; busy: boolean }) {
  const cell = "justify-self-end text-right text-[12.5px] font-[650] max-md:justify-self-start max-md:text-left";
  if (busy) return <span className={`${cell} text-faint`}>Verifying…</span>;
  if (!result) return <span className={`${cell} text-faint`}>Not verified</span>;
  if (result.verified) {
    return (
      <span className={`${cell} inline-flex items-center gap-1.5 whitespace-nowrap text-good`}>
        <Icon name="check" className="size-4" /> Breaker verified
      </span>
    );
  }
  return <span className={`${cell} text-warn-ink`} title={result.detail}>{result.detail || "Breaker not detected"}</span>;
}

/** One shared column template so every row's cells line up across sections. */
const RUNTIME_MAP_ROW = "grid grid-cols-[minmax(0,1.6fr)_minmax(150px,.6fr)_minmax(170px,.55fr)] items-center gap-3.5 border-t border-line-soft py-[11px] first-of-type:border-t-0 max-md:grid-cols-1 max-md:gap-2";

export function RuntimeIntegrationMap({ assets, token, values, onChange, autoRun = false }: {
  assets: OnboardingData["scopedAssets"];
  token: string;
  values: Record<string, RuntimeIntegration>;
  onChange: (values: Record<string, RuntimeIntegration>) => void;
  autoRun?: boolean;
}) {
  const workers = assets.filter(asset => asset.family === "workers");
  const namespaces = assets.filter(asset => asset.family === "durable_objects");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, VerifyResult>>({});
  const [notice, setNotice] = useState("");
  const autoRanRef = useRef(false);

  const scripts = [...new Set(
    assets.map(asset => values[asset.key]?.workerScript.trim() ?? "").filter(Boolean),
  )];

  async function verifyAll() {
    setBusy(true);
    setNotice("");
    try {
      const batch = scripts.slice(0, MAX_SCRIPTS_PER_VERIFY);
      const data = await api<ConfigurationData>("/api/configuration/verify", token, {
        method: "POST",
        body: JSON.stringify({ workerScripts: batch }),
      });
      const next: Record<string, VerifyResult> = {};
      for (const script of batch) {
        const worker = data.workers.find(item => item.id === script);
        if (!worker) { next[script] = { verified: false, detail: "Worker not found in Cloudflare" }; continue; }
        const failing = MACHINE_CHECKS.map(key => worker.checks[key]).find(item => item.state !== "pass");
        next[script] = failing ? { verified: false, detail: failing.detail || failing.label } : { verified: true, detail: "" };
      }
      setResults(next);
      onChange(Object.fromEntries(assets.map(asset => {
        const integration = values[asset.key] ?? { workerScript: "", installed: false };
        return [asset.key, { ...integration, installed: next[integration.workerScript.trim()]?.verified === true }];
      })));
      if (scripts.length > batch.length) setNotice(`Cloudflare checks cover ${MAX_SCRIPTS_PER_VERIFY} Workers per minute. Verify again in a minute for the rest.`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const resultFor = (key: string) => results[values[key]?.workerScript.trim() ?? ""];
  const hasResults = Object.keys(results).length > 0;
  const verifiedCount = assets.filter(asset => resultFor(asset.key)?.verified).length;

  useEffect(() => {
    if (autoRun && !autoRanRef.current && scripts.length) {
      autoRanRef.current = true;
      void verifyAll();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one automatic pass on mount
  }, [autoRun]);

  return (
    <section className="mt-1 overflow-hidden rounded-panel border border-line">
      <header className="flex items-center justify-between gap-4 border-b border-line-soft bg-panel-soft px-4 py-3 max-md:flex-col max-md:items-start">
        <p className="text-[12.5px] text-muted">
          {busy
            ? "Checking each Worker in Cloudflare…"
            : hasResults
              ? <><strong className="text-ink">{verifiedCount} of {assets.length} resources verified.</strong> Unverified resources stay alert-only.</>
              : "Unverified resources stay alert-only."}
        </p>
        <Button variant={hasResults ? "secondary" : "primary"} className="shrink-0" disabled={busy || !scripts.length} onClick={() => void verifyAll()}>
          <Icon name="refresh" /> {busy ? "Verifying…" : hasResults ? "Re-verify" : "Verify deployments"}
        </Button>
      </header>
      {workers.length > 0 && (
        <div className="px-4 pt-1.5 pb-3.5">
          <h3 className="mt-2.5 mb-1.5 text-[12px] uppercase tracking-[.07em] text-faint">Worker scripts</h3>
          {workers.map(asset => (
            <div className={RUNTIME_MAP_ROW} key={asset.key}>
              <ResourceLabel family="workers" name={asset.name}>Needs <code>brollyWorker(env)</code> before application work.</ResourceLabel>
              <span aria-hidden="true" className="max-md:hidden" />
              <VerifyBadge result={resultFor(asset.key)} busy={busy} />
            </div>
          ))}
        </div>
      )}
      {namespaces.length > 0 && (
        <div className="px-4 pt-1.5 pb-3.5">
          <h3 className="mt-2.5 mb-1.5 text-[12px] uppercase tracking-[.07em] text-faint">Durable Object namespaces</h3>
          {namespaces.map(asset => {
            const owner = values[asset.key]?.workerScript.trim() ?? "";
            return (
              <div className={RUNTIME_MAP_ROW} key={asset.key}>
                <ResourceLabel family="durable_objects" name={asset.name}>
                  {owner
                    ? <>Needs <code>brollyDurableObject(ctx, env)</code> after <code>super()</code>.</>
                    : "Waiting for Cloudflare to report the owning Worker."}
                </ResourceLabel>
                <span className="flex flex-col gap-1 text-[11px] font-[750] uppercase tracking-[.05em] text-faint">
                  <span>Owning Worker</span>
                  <code>{owner || "Not reported"}</code>
                </span>
                {owner ? <VerifyBadge result={resultFor(asset.key)} busy={busy} /> : <span aria-hidden="true" className="max-md:hidden" />}
              </div>
            );
          })}
        </div>
      )}
      {!assets.length && <p className="p-4 text-[13px] leading-[1.5] text-faint">No Worker scripts or Durable Object namespaces were discovered. Finish setup for alerts, run a scan, then return to Budgets to verify breakers.</p>}
      {notice && <p className="mx-4 mb-3 rounded-field border border-warn-line bg-warn-soft px-[13px] py-[9px] text-[12.5px] text-warn-ink">{notice}</p>}
      <div className="mx-4 mb-3.5 rounded-field border border-line-soft bg-panel-soft px-[13px] py-[11px] text-[12.5px] leading-[1.5] text-muted">
        <strong>Automatic quarantine runs only after every safety check passes.</strong> If any check fails, Brolly sends an alert and changes nothing in Cloudflare.
      </div>
    </section>
  );
}
