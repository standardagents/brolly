import { useState, type Dispatch, type SetStateAction } from "react";
import { api } from "../api";
import { targetName, type NotificationTargetsState } from "../components/notifications";
import { Button, ChannelLogo, Notice, Spinner } from "../components/ui";
import type { NotificationTarget, Severity } from "../types";
import { StepIntro } from "./BudgetSteps";

/**
 * One alert level. Levels are ordered left to right. A channel assigned at one
 * level also receives every level to its right, so channel sets are additive.
 *
 * Built-in levels map to the persisted `minimumSeverity` on a notification
 * target. Custom levels exist only in wizard state for now; the persistence
 * shape for them is settled together with the new configuration input.
 */
export interface AlertLevel {
  key: string;
  label: string;
  severity: Severity | null;
}

export const DEFAULT_ALERT_LEVELS: AlertLevel[] = [
  { key: "warning", label: "Warning", severity: "warning" },
  { key: "critical", label: "Critical", severity: "critical" },
  { key: "emergency", label: "Emergency", severity: "emergency" },
];

/** Channel start level per target id: index into the levels array, or -1 for "no level". */
export type LevelAssignments = Record<string, number>;

export function AlertLevelsStep({ token, targets: state, levels, setLevels, assignments, setAssignments }: {
  token: string;
  targets: NotificationTargetsState;
  levels: AlertLevel[];
  setLevels: Dispatch<SetStateAction<AlertLevel[]>>;
  assignments: LevelAssignments;
  setAssignments: Dispatch<SetStateAction<LevelAssignments>>;
}) {
  const { targets, loading, error, setError, load } = state;
  const [draft, setDraft] = useState("");
  const channels = targets;

  function startLevel(target: NotificationTarget): number {
    if (target.id in assignments) return assignments[target.id]!;
    const index = levels.findIndex(level => level.severity === target.minimumSeverity);
    return index === -1 ? 0 : index;
  }

  async function assign(target: NotificationTarget, index: number) {
    setAssignments(current => ({ ...current, [target.id]: index }));
    const severity = levels[index]?.severity;
    if (!severity) return;
    setError("");
    try {
      await api(`/api/targets/${encodeURIComponent(target.id)}`, token, { method: "PATCH", body: JSON.stringify({ minimumSeverity: severity }) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function addLevel() {
    const label = draft.trim();
    if (!label) return;
    const key = `custom:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    if (levels.some(level => level.key === key)) return;
    setLevels(current => [...current, { key, label, severity: null }]);
    setDraft("");
  }

  return <>
    <StepIntro title="Alert levels">Levels run from left to right. A channel you assign at one level also receives every level to its right. Warning, Critical, and Emergency are built in; add your own levels after them.</StepIntro>
    {loading && <Spinner />}
    {!loading && channels.length === 0 && <Notice tone="error">No alert channels yet. Go back to the previous step and connect at least one channel.</Notice>}
    {channels.length > 0 && (
      <div className="overflow-x-auto rounded-panel border border-line">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-panel-soft text-left text-[12px] text-muted">
              <th className="px-4 py-3 font-[680]">Channel</th>
              {levels.map(level => <th key={level.key} className="px-4 py-3 text-center font-[680]">{level.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {channels.map(target => {
              const start = startLevel(target);
              return (
                <tr key={target.id} className="border-t border-line-soft">
                  <td className="px-4 py-3"><span className="flex items-center gap-2"><ChannelLogo kind={target.kind} />{targetName(target)}</span></td>
                  {levels.map((level, index) => {
                    const inherited = index > start;
                    const starts = index === start;
                    return (
                      <td key={level.key} className="px-4 py-3 text-center">
                        <button
                          type="button"
                          title={starts ? `Starts at ${level.label}` : inherited ? `Inherited from ${levels[start]!.label}` : `Start at ${level.label}`}
                          aria-pressed={starts}
                          onClick={() => void assign(target, index)}
                          className={`grid size-7 place-items-center rounded-full border text-[12px] ${
                            starts ? "border-orange bg-orange text-white" : inherited ? "border-[#74b996] bg-good-bg text-good" : "border-[#cbd1d7] text-faint dark:border-[#505862]"
                          }`}
                        >
                          {starts || inherited ? "✓" : ""}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
    {error && <Notice tone="error">{error}</Notice>}
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <input
        className="min-h-[38px] rounded-field border border-field-line bg-field px-2.5 text-[13px] text-ink"
        placeholder="New level name"
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); addLevel(); } }}
      />
      <Button variant="secondary" onClick={addLevel} disabled={!draft.trim()}>Add level</Button>
    </div>
  </>;
}
