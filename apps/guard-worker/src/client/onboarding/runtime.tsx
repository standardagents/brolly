import { ProductIcon } from "../components/ui";
import type { OnboardingData } from "../types";
import type { RuntimeIntegration } from "./model";

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

const RUNTIME_MAP_ROW = "grid items-center gap-3.5 border-t border-line-soft py-[11px] first-of-type:border-t-0 max-md:grid-cols-1 max-md:gap-2";
const RUNTIME_CONFIRM = "inline-flex items-center gap-2 whitespace-nowrap text-[12.5px] font-[650]";

export function RuntimeIntegrationMap({ assets, values, onChange }: {
  assets: OnboardingData["scopedAssets"];
  values: Record<string, RuntimeIntegration>;
  onChange: (values: Record<string, RuntimeIntegration>) => void;
}) {
  const workers = assets.filter(asset => asset.family === "workers");
  const namespaces = assets.filter(asset => asset.family === "durable_objects");

  function update(key: string, patch: Partial<RuntimeIntegration>) {
    onChange({ ...values, [key]: { ...values[key]!, ...patch } });
  }

  return (
    <section className="mt-6 overflow-hidden rounded-panel border border-line">
      <header className="border-b border-line-soft bg-panel-soft px-4 py-3.5">
        <div>
          <strong className="text-[14px]">Connect the resources Brolly discovered</strong>
          <p className="mt-[3px] max-w-[78ch] text-[12.5px] text-muted">Only check an item after deploying the exact guard shown above. Unchecked resources still alert, but Brolly will not claim precise shutdown protection.</p>
        </div>
      </header>
      {workers.length > 0 && (
        <div className="px-4 pt-1.5 pb-3.5">
          <h3 className="mt-2.5 mb-1.5 text-[12px] uppercase tracking-[.07em] text-faint">Worker scripts</h3>
          {workers.map(asset => (
            <label className={`${RUNTIME_MAP_ROW} grid-cols-[minmax(0,1.5fr)_auto]`} key={asset.key}>
              <ResourceLabel family="workers" name={asset.name}>Confirm <code>brollyWorker(env)</code> runs before application work.</ResourceLabel>
              <span className={RUNTIME_CONFIRM}>
                <input className="size-[15px] accent-orange" type="checkbox" checked={values[asset.key]?.installed ?? false} onChange={event => update(asset.key, { installed: event.target.checked })} /> Ingress fuse installed
              </span>
            </label>
          ))}
        </div>
      )}
      {namespaces.length > 0 && (
        <div className="px-4 pt-1.5 pb-3.5">
          <h3 className="mt-2.5 mb-1.5 text-[12px] uppercase tracking-[.07em] text-faint">Durable Object namespaces</h3>
          {namespaces.map(asset => (
            <div className={`${RUNTIME_MAP_ROW} grid-cols-[minmax(0,1.4fr)_minmax(170px,.9fr)_auto]`} key={asset.key}>
              <ResourceLabel family="durable_objects" name={asset.name}>Cloudflare reports the Worker that owns this namespace.</ResourceLabel>
              <span className="flex flex-col gap-1 text-[11px] font-[750] uppercase tracking-[.05em] text-faint">
                <span>Owning Worker</span>
                <code>{values[asset.key]?.workerScript || "Not reported"}</code>
              </span>
              <label className={RUNTIME_CONFIRM}>
                <input
                  className="size-[15px] accent-orange"
                  type="checkbox"
                  checked={values[asset.key]?.installed ?? false}
                  disabled={!values[asset.key]?.workerScript.trim()}
                  onChange={event => update(asset.key, { installed: event.target.checked })}
                /> Constructor fuse installed
              </label>
            </div>
          ))}
        </div>
      )}
      {!assets.length && <p className="p-4 text-[13px] leading-[1.5] text-faint">No Worker scripts or Durable Object namespaces were discovered. Finish setup for alerts, run a scan, then return to Budgets to map the runtime fuse.</p>}
      <div className="mx-4 mb-3.5 rounded-field border border-line-soft bg-panel-soft px-[13px] py-[11px] text-[12.5px] leading-[1.5] text-muted">
        <strong>Automatic mode requires complete evidence:</strong> Brolly uses Cloudflare&apos;s ownership mapping, a recent successful runtime verification, complete fresh unsampled usage, explicit rule opt-in, and the configured confirmation window. Missing evidence produces an alert and leaves Cloudflare unchanged.
      </div>
    </section>
  );
}
