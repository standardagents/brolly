import { ProductIcon } from "../components/ui";
import type { OnboardingData } from "../types";
import type { RuntimeIntegration } from "./model";

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
    <section className="runtime-map">
      <header>
        <div>
          <strong>Connect the resources Brolly discovered</strong>
          <p>Only check an item after deploying the exact guard shown above. Unchecked resources still alert, but Brolly will not claim precise shutdown protection.</p>
        </div>
      </header>
      {workers.length > 0 && (
        <div className="runtime-map-group">
          <h3>Worker scripts</h3>
          {workers.map(asset => (
            <label className="runtime-map-row" key={asset.key}>
              <span>
                <ProductIcon family="workers" />
                <span><strong>{asset.name}</strong><small>Confirm <code>brollyWorker(env)</code> runs before application work.</small></span>
              </span>
              <span className="runtime-confirm">
                <input type="checkbox" checked={values[asset.key]?.installed ?? false} onChange={event => update(asset.key, { installed: event.target.checked })} /> Ingress fuse installed
              </span>
            </label>
          ))}
        </div>
      )}
      {namespaces.length > 0 && (
        <div className="runtime-map-group">
          <h3>Durable Object namespaces</h3>
          {namespaces.map(asset => (
            <div className="runtime-map-row namespace" key={asset.key}>
              <span>
                <ProductIcon family="durable_objects" />
                <span><strong>{asset.name}</strong><small>Cloudflare reports the Worker that owns this namespace.</small></span>
              </span>
              <span className="runtime-worker-field"><span>Owning Worker</span><code>{values[asset.key]?.workerScript || "Not reported"}</code></span>
              <label className="runtime-confirm">
                <input
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
      {!assets.length && <p className="empty-small">No Worker scripts or Durable Object namespaces were discovered. Finish setup for alerts, run a scan, then return to Budgets to map the runtime fuse.</p>}
      <div className="runtime-map-note">
        <strong>Automatic mode is fail-safe:</strong> Brolly only uses Cloudflare&apos;s ownership mapping, a recent successful runtime verification, and two consecutive emergency samples. Missing evidence produces an alert—not a guessed deployment.
      </div>
    </section>
  );
}
