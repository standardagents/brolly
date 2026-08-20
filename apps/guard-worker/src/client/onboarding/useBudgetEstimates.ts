import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "../api";
import { ENTERPRISE_COST_NOTICE } from "../plan-tier";
import type { AlertLevel, OnboardingBudgetEstimates, PlanTier, Policy } from "../types";
import { mapFixedSpendLimits } from "./model";

const DEFAULT_ALERT_LEVELS: AlertLevel[] = [
  { id: "warning", position: 0, label: "Warning", entries: [] },
  { id: "critical", position: 1, label: "Critical", entries: [] },
  { id: "emergency", position: 2, label: "Emergency", entries: [] },
];

export function useBudgetEstimates(token: string, policy: Policy, setPolicy: Dispatch<SetStateAction<Policy>>, levels: AlertLevel[] = DEFAULT_ALERT_LEVELS, planTier?: PlanTier) {
  const [busy, setBusy] = useState(false);
  const [estimates, setEstimates] = useState<OnboardingBudgetEstimates | null>(null);
  const [suggestionNotice, setSuggestionNotice] = useState("");
  const [suggestionError, setSuggestionError] = useState("");
  const [accessNotice, setAccessNotice] = useState("");
  const [accessError, setAccessError] = useState("");

  const acceptBillingAccess = useCallback((result: OnboardingBudgetEstimates) => {
    setEstimates(result);
    setAccessError("");
    setAccessNotice("Billing access saved.");
  }, []);

  const verifyAccess = useCallback(async () => {
    setBusy(true);
    setAccessNotice("");
    setAccessError("");
    try {
      setEstimates(await api<OnboardingBudgetEstimates>("/api/onboarding/estimates", token, { method: "POST" }));
    } catch (cause) {
      setAccessError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [token]);

  const suggestLimits = useCallback(async () => {
    setBusy(true);
    setSuggestionNotice("");
    setSuggestionError("");
    try {
      const result = estimates ?? await api<OnboardingBudgetEstimates>("/api/onboarding/estimates", token, { method: "POST" });
      setEstimates(result);
      const suggestion = applySuggestions(policy, result, levels, planTier);
      setPolicy(suggestion.policy);
      setSuggestionNotice(suggestion.notice);
    } catch (cause) {
      setSuggestionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [estimates, levels, planTier, policy, setPolicy, token]);

  return {
    acceptBillingAccess,
    accessError,
    accessNotice,
    busy,
    estimates,
    suggestionNotice,
    suggestionError,
    suggestLimits,
    verifyAccess,
  };
}

export function applySuggestions(policy: Policy, result: OnboardingBudgetEstimates, levels: AlertLevel[], planTier?: PlanTier): { policy: Policy; notice: string } {
  if (planTier === "enterprise") return { policy, notice: ENTERPRISE_COST_NOTICE };
  const familySuggestions = Object.entries(result.families).filter(([family]) => family in policy.familyDailySpend);
  const assetSuggestions = Object.entries(result.assets).filter(([key]) => key in policy.assetDailySpend);
  const familyDailySpend = { ...policy.familyDailySpend };
  const assetDailySpend = { ...policy.assetDailySpend };
  for (const [family, suggestion] of familySuggestions) familyDailySpend[family] = mapFixedSpendLimits(suggestion.limits, levels);
  for (const [key, suggestion] of assetSuggestions) assetDailySpend[key] = mapFixedSpendLimits(suggestion.limits, levels);

  let notice = "Cloudflare returned no non-zero cost estimate for this window, so no limits were changed.";
  if (familySuggestions.length) {
    const assetNote = assetSuggestions.length ? ` and ${assetSuggestions.length} resource ${assetSuggestions.length === 1 ? "budget" : "budgets"}` : "";
    const accountNote = result.account?.partial ? " The account-wide limit was left unchanged because the scan had partial product coverage." : " The account-wide limit was updated too.";
    notice = `Filled ${familySuggestions.length} product ${familySuggestions.length === 1 ? "budget" : "budgets"}${assetNote}.${accountNote}`;
  }

  return {
    notice,
    policy: {
      ...policy,
      familyDailySpend,
      assetDailySpend,
      accountDailySpend: result.account && !result.account.partial
        ? mapFixedSpendLimits(result.account.limits, levels)
        : policy.accountDailySpend,
    },
  };
}
