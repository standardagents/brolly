import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "../api";
import type { OnboardingBudgetEstimates, Policy } from "../types";

export function useBudgetEstimates(token: string, policy: Policy, setPolicy: Dispatch<SetStateAction<Policy>>) {
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
      const [result] = await Promise.all([
        api<OnboardingBudgetEstimates>("/api/onboarding/estimates", token, { method: "POST" }),
        new Promise(resolve => setTimeout(resolve, 1400)),
      ]);
      setEstimates(result);
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
      const suggestion = applySuggestions(policy, result);
      setPolicy(suggestion.policy);
      setSuggestionNotice(suggestion.notice);
    } catch (cause) {
      setSuggestionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [estimates, policy, setPolicy, token]);

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

function applySuggestions(policy: Policy, result: OnboardingBudgetEstimates): { policy: Policy; notice: string } {
  const familySuggestions = Object.entries(result.families).filter(([family]) => family in policy.familyDailySpend);
  const assetSuggestions = Object.entries(result.assets).filter(([key]) => key in policy.assetDailySpend);
  const familyDailySpend = { ...policy.familyDailySpend };
  const assetDailySpend = { ...policy.assetDailySpend };
  for (const [family, suggestion] of familySuggestions) familyDailySpend[family] = suggestion.limits;
  for (const [key, suggestion] of assetSuggestions) assetDailySpend[key] = suggestion.limits;

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
      accountDailySpend: result.account && !result.account.partial ? result.account.limits : policy.accountDailySpend,
    },
  };
}
