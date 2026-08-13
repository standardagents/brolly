import { useCallback, useState } from "react";
import { api } from "../api";
import type { OnboardingData, Policy } from "../types";
import type { RuntimeIntegration } from "./model";

export function useOnboardingSave(
  token: string,
  data: OnboardingData,
  policy: Policy,
  integrations: Record<string, RuntimeIntegration>,
  onSaved: () => Promise<void>,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/onboarding", token, {
        method: "POST",
        body: JSON.stringify({
          policy: { ...policy, version: new Date().toISOString() },
          integrations: data.scopedAssets.map(asset => ({
            family: asset.family,
            id: asset.id,
            workerScript: integrations[asset.key]?.workerScript || undefined,
            installed: integrations[asset.key]?.installed === true,
          })),
        }),
      });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [data.scopedAssets, integrations, onSaved, policy, token]);

  return { busy, error, save };
}
