import type { Dispatch, SetStateAction } from "react";
import type { Policy } from "../types";
import type { AlertLevel } from "./levels";
import { StepIntro } from "./BudgetSteps";

/**
 * Placeholder for per-level actions. The final design assigns an action to
 * every alert level with the new configuration input. Until then this step
 * carries the single emergency-level control mode from the policy.
 */
export function ActionsStep({ levels, policy, setPolicy }: {
  levels: AlertLevel[];
  policy: Policy;
  setPolicy: Dispatch<SetStateAction<Policy>>;
}) {
  return <>
    <StepIntro title="Actions per level">Choose what Brolly does when a limit reaches each level. Every level notifies its channels. Stop actions are available at the emergency level today; per-level actions for {levels.map(level => level.label).join(", ")} arrive with the next configuration input.</StepIntro>
    <div className="flex items-center justify-between gap-[18px] rounded-panel border border-line-soft bg-panel-soft px-[18px] py-4">
      <div>
        <strong className="text-[14px]">Emergency</strong>
        <p className="mt-1 max-w-[52ch] text-[12.5px] text-muted">Automatic mode applies an installed fuse; recovery remains manual.</p>
      </div>
      <select
        className="min-h-10 flex-none rounded-field border border-field-line bg-field px-3 text-ink"
        value={policy.mode}
        onChange={event => setPolicy(current => ({ ...current, mode: event.target.value as Policy["mode"] }))}
      >
        <option value="observe">Notify only</option>
        <option value="approval">Notify and prepare a stop action for approval</option>
        <option value="automatic">Notify and quarantine automatically</option>
      </select>
    </div>
  </>;
}
