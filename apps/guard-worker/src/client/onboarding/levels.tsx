import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { AddChannelRow, ChannelCredentialsForm, targetName, type NotificationChannel, type NotificationTargetsState } from "../components/notifications";
import { Button, ChannelLogo, Icon, Notice, Popover, Spinner } from "../components/ui";
import { useOutsideClose } from "../lib/outside-close";
import type { AlertEntryKind, AlertLevel, AlertLevelEntry, AlertLevelsResponse } from "../types";
import { StepIntro } from "./BudgetSteps";

const INTERVALS = [
  { value: "", label: "Once" },
  { value: "300000", label: "5 min" },
  { value: "900000", label: "15 min" },
  { value: "1800000", label: "30 min" },
  { value: "3600000", label: "1 h" },
  { value: "10800000", label: "3 h" },
  { value: "21600000", label: "6 h" },
  { value: "43200000", label: "12 h" },
  { value: "86400000", label: "24 h" },
] as const;

export function useAlertLevels(token: string) {
  const [levels, setLevels] = useState<AlertLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setLevels((await api<AlertLevelsResponse>("/api/alert-levels", token)).levels); }
    catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  return { levels, loading, error, setError, load };
}

export function AlertLevelsStep({ token, targets, board }: { token: string; targets: NotificationTargetsState; board: ReturnType<typeof useAlertLevels> }) {
  const [draft, setDraft] = useState("");
  const [addingAfter, setAddingAfter] = useState<string | null | undefined>(undefined);
  const [dragged, setDragged] = useState<string | null>(null);

  async function mutate(path: string, init: RequestInit) {
    board.setError("");
    try { await api(path, token, init); await board.load(); }
    catch (cause) { board.setError(message(cause)); }
  }

  async function addLevel() {
    const label = draft.trim();
    if (!label) return;
    await mutate("/api/alert-levels", { method: "POST", body: JSON.stringify({ label, afterLevelId: addingAfter ?? null }) });
    setDraft("");
    setAddingAfter(undefined);
  }

  function addBefore(level: AlertLevel) {
    const index = board.levels.findIndex(item => item.id === level.id);
    setAddingAfter(index > 0 ? board.levels[index - 1]!.id : null);
  }

  async function move(level: AlertLevel, position: number) {
    if (position < 0 || position >= board.levels.length || position === level.position) return;
    await mutate(`/api/alert-levels/${encodeURIComponent(level.id)}`, { method: "PATCH", body: JSON.stringify({ position }) });
  }

  return <>
    <StepIntro title="Build alert levels">Each entry applies to its column and every column to the right. Columns may stay empty.</StepIntro>
    {board.loading && <Spinner />}
    {board.error && <Notice tone="error">{board.error}</Notice>}
    {!board.loading && (
      <div className="overflow-x-auto pb-3" aria-label="Alert level board">
        <div className="flex min-w-max items-stretch gap-3">
          {board.levels.map((level, index) => (
            <LevelColumn
              key={level.id}
              level={level}
              index={index}
              count={board.levels.length}
              token={token}
              targets={targets}
              dragged={dragged}
              onDragStart={() => setDragged(level.id)}
              onDrop={() => { const source = board.levels.find(item => item.id === dragged); setDragged(null); if (source) void move(source, index); }}
              onMove={position => void move(level, position)}
              onAddBefore={() => addBefore(level)}
              onAddAfter={() => setAddingAfter(level.id)}
              onChanged={board.load}
              onError={board.setError}
            />
          ))}
        </div>
      </div>
    )}
    {addingAfter !== undefined ? (
      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-field border border-line-soft bg-panel-soft p-3">
        <label className="flex flex-col gap-1 text-[12px] font-[680]">Level name<input autoFocus className="min-h-[38px] rounded-field border border-field-line bg-field px-2.5 text-[13px]" value={draft} maxLength={40} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void addLevel(); } }} /></label>
        <Button variant="primary" disabled={!draft.trim()} onClick={() => void addLevel()}>Add level</Button>
        <Button variant="quiet" onClick={() => { setDraft(""); setAddingAfter(undefined); }}>Cancel</Button>
      </div>
    ) : board.levels.length < 8 && <Button variant="secondary" onClick={() => setAddingAfter(board.levels.at(-1)?.id ?? null)}>Add level</Button>}
  </>;
}

function LevelColumn({ level, index, count, token, targets, dragged, onDragStart, onDrop, onMove, onAddBefore, onAddAfter, onChanged, onError }: {
  level: AlertLevel; index: number; count: number; token: string; targets: NotificationTargetsState; dragged: string | null;
  onDragStart: () => void; onDrop: () => void; onMove: (position: number) => void; onAddBefore: () => void; onAddAfter: () => void;
  onChanged: () => Promise<void>; onError: (error: string) => void;
}) {
  const [label, setLabel] = useState(level.label);
  const [addOpen, setAddOpen] = useState(false);
  const [newChannel, setNewChannel] = useState<NotificationChannel | null>(null);
  const actionEntries = groupedActions(level.entries);
  useEffect(() => setLabel(level.label), [level.label]);

  async function request(path: string, init: RequestInit) {
    onError("");
    try { await api(path, token, init); await onChanged(); }
    catch (cause) { onError(message(cause)); }
  }
  async function rename() {
    const next = label.trim();
    if (!next || next === level.label) { setLabel(level.label); return; }
    await request(`/api/alert-levels/${encodeURIComponent(level.id)}`, { method: "PATCH", body: JSON.stringify({ label: next }) });
  }
  async function addEntry(kind: AlertEntryKind, targetId?: string) {
    await request(`/api/alert-levels/${encodeURIComponent(level.id)}/entries`, { method: "POST", body: JSON.stringify({ kind, targetId, repeatIntervalMs: kind === "channel" ? null : undefined }) });
  }
  async function addAction(mode: "prepare" | "auto") {
    const kinds: AlertEntryKind[] = mode === "prepare" ? ["prepare_stop", "prepare_quarantine"] : ["auto_pause", "auto_quarantine"];
    for (const kind of kinds) if (!level.entries.some(entry => entry.kind === kind)) await addEntry(kind);
  }
  async function removeEntries(entries: AlertLevelEntry[]) {
    for (const entry of entries) await request(`/api/alert-levels/${encodeURIComponent(level.id)}/entries/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
  }
  async function deleteLevel() { await request(`/api/alert-levels/${encodeURIComponent(level.id)}`, { method: "DELETE" }); }

  return (
    <section
      className={`w-[290px] flex-none rounded-panel border bg-panel p-3.5 ${dragged === level.id ? "border-orange opacity-70" : "border-line"}`}
      draggable
      onDragStart={event => { event.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
      onDrop={event => { event.preventDefault(); onDrop(); }}
    >
      <header className="mb-3 flex items-center gap-1.5">
        <span className="cursor-grab text-faint" title="Drag to reorder" aria-hidden="true">⠿</span>
        <input aria-label={`Level name: ${level.label}`} className="min-w-0 flex-1 rounded-field border border-transparent bg-transparent px-1.5 py-1 text-[14px] font-[750] hover:border-field-line focus:border-orange focus:outline-none" value={label} onChange={event => setLabel(event.target.value)} onBlur={() => void rename()} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        <LevelMenu index={index} count={count} canAdd={count < 8} canDelete={count > 1} onMove={onMove} onAddBefore={onAddBefore} onAddAfter={onAddAfter} onDelete={() => void deleteLevel()} />
      </header>
      <div className="grid gap-2">
        {level.entries.filter(entry => entry.kind === "channel").map(entry => <ChannelEntry key={entry.id} entry={entry} target={targets.targets.find(target => target.id === entry.targetId)} token={token} levelId={level.id} onChanged={onChanged} onError={onError} />)}
        {actionEntries.prepare.length > 0 && <ActionEntry mode="prepare" onRemove={() => void removeEntries(actionEntries.prepare)} />}
        {actionEntries.auto.length > 0 && <ActionEntry mode="auto" onRemove={() => void removeEntries(actionEntries.auto)} />}
        {newChannel ? (
          <div className="rounded-field border border-line-soft p-2.5"><ChannelCredentialsForm channel={newChannel} token={token} onCancel={() => setNewChannel(null)} onSaved={async targetId => { await targets.load(); await addEntry("channel", targetId); setNewChannel(null); }} /></div>
        ) : <LevelAddMenu open={addOpen} setOpen={setAddOpen} level={level} targets={targets} onChannel={targetId => void addEntry("channel", targetId)} onNewChannel={setNewChannel} onAction={mode => void addAction(mode)} />}
      </div>
    </section>
  );
}

function ChannelEntry({ entry, target, token, levelId, onChanged, onError }: { entry: AlertLevelEntry; target: NotificationTargetsState["targets"][number] | undefined; token: string; levelId: string; onChanged: () => Promise<void>; onError: (error: string) => void }) {
  async function patch(repeatIntervalMs: number | null) { try { await api(`/api/alert-levels/${encodeURIComponent(levelId)}/entries/${encodeURIComponent(entry.id)}`, token, { method: "PATCH", body: JSON.stringify({ repeatIntervalMs }) }); await onChanged(); } catch (cause) { onError(message(cause)); } }
  async function remove() { try { await api(`/api/alert-levels/${encodeURIComponent(levelId)}/entries/${encodeURIComponent(entry.id)}`, token, { method: "DELETE" }); await onChanged(); } catch (cause) { onError(message(cause)); } }
  return <article className="rounded-field border border-line-soft bg-panel-soft p-2.5"><div className="flex items-center gap-2">{target && <ChannelLogo kind={target.kind} />}<strong className="min-w-0 flex-1 truncate text-[12.5px]">{target ? targetName(target) : "Removed channel"}</strong><button type="button" aria-label={`Remove ${target ? targetName(target) : "channel"}`} className="text-faint hover:text-danger" onClick={() => void remove()}><Icon name="x" className="size-4" /></button></div><label className="mt-2 flex items-center justify-between gap-2 text-[11.5px] text-muted">Repeat<select aria-label={`Repeat interval for ${target ? targetName(target) : "channel"}`} className="min-h-8 rounded-field border border-field-line bg-field px-2 text-[12px] text-ink" value={entry.repeatIntervalMs ?? ""} onChange={event => void patch(event.target.value ? Number(event.target.value) : null)}>{INTERVALS.map(interval => <option key={interval.label} value={interval.value}>{interval.label}</option>)}</select></label></article>;
}

function ActionEntry({ mode, onRemove }: { mode: "prepare" | "auto"; onRemove: () => void }) {
  const auto = mode === "auto";
  return <article className={`rounded-field border p-2.5 ${auto ? "border-danger-line bg-danger-bg text-danger" : "border-warn-line bg-warn-bg text-warn"}`}><div className="flex items-start gap-2"><Icon name="alert" className="mt-px size-4" /><span className="min-w-0 flex-1"><strong className="block text-[12.5px]">{auto ? "Auto quarantine / pause" : "Prepare quarantine / pause"}</strong><span className="block text-[11.5px] leading-[1.4]">Workers, Durable Objects, and Queues. Recovery is manual.</span></span><button type="button" aria-label={`Remove ${mode} action`} onClick={onRemove}><Icon name="x" className="size-4" /></button></div></article>;
}

function LevelAddMenu({ open, setOpen, level, targets, onChannel, onNewChannel, onAction }: { open: boolean; setOpen: (open: boolean) => void; level: AlertLevel; targets: NotificationTargetsState; onChannel: (targetId: string) => void; onNewChannel: (channel: NotificationChannel) => void; onAction: (mode: "prepare" | "auto") => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useOutsideClose([ref, panel], open, () => setOpen(false));
  const used = new Set(level.entries.filter(entry => entry.kind === "channel").map(entry => entry.targetId));
  const grouped = groupedActions(level.entries);
  return <div ref={ref} className="relative"><button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center justify-center gap-1 rounded-field border border-dashed border-line px-3 py-2 text-[12.5px] font-[680] text-muted hover:border-orange hover:text-ink">+ Add</button><Popover anchor={ref} open={open} side="top" align="stretch"><div ref={panel} role="menu" className="grid gap-1 rounded-panel border border-line bg-panel p-1.5 shadow-panel">{targets.targets.filter(target => !used.has(target.id)).map(target => <button key={target.id} type="button" role="menuitem" className="flex items-center gap-2 rounded-field px-2 py-1.5 text-left text-[12px] hover:bg-panel-soft" onClick={() => { setOpen(false); onChannel(target.id); }}><ChannelLogo kind={target.kind} />{targetName(target)}</button>)}<AddChannelRow label="Add new channel" onPick={channel => { setOpen(false); onNewChannel(channel); }} />{grouped.prepare.length === 0 && <button type="button" role="menuitem" className="rounded-field px-2 py-2 text-left text-[12px] text-warn hover:bg-warn-bg" onClick={() => { setOpen(false); onAction("prepare"); }}>Prepare quarantine / pause</button>}{grouped.auto.length === 0 && <button type="button" role="menuitem" className="rounded-field px-2 py-2 text-left text-[12px] text-danger hover:bg-danger-bg" onClick={() => { setOpen(false); onAction("auto"); }}>Auto quarantine / pause</button>}</div></Popover></div>;
}

function LevelMenu({ index, count, canAdd, canDelete, onMove, onAddBefore, onAddAfter, onDelete }: { index: number; count: number; canAdd: boolean; canDelete: boolean; onMove: (position: number) => void; onAddBefore: () => void; onAddAfter: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useOutsideClose([ref, panel], open, () => setOpen(false));
  return <div ref={ref} className="relative"><button type="button" aria-label="Level menu" aria-haspopup="menu" aria-expanded={open} className="rounded-field px-2 py-1 text-faint hover:bg-panel-soft" onClick={() => setOpen(!open)}>•••</button><Popover anchor={ref} open={open} side="bottom" align="end"><div ref={panel} role="menu" className="grid min-w-[150px] gap-0.5 rounded-field border border-line bg-panel p-1 shadow-panel"><MenuButton disabled={index === 0} onClick={() => onMove(index - 1)}>Move left</MenuButton><MenuButton disabled={index === count - 1} onClick={() => onMove(index + 1)}>Move right</MenuButton><MenuButton disabled={!canAdd} onClick={onAddBefore}>Add level before</MenuButton><MenuButton disabled={!canAdd} onClick={onAddAfter}>Add level after</MenuButton><MenuButton disabled={!canDelete} tone="danger" onClick={onDelete}>Delete level</MenuButton></div></Popover></div>;
}

function MenuButton({ children, disabled, tone, onClick }: { children: React.ReactNode; disabled?: boolean; tone?: "danger"; onClick: () => void }) { return <button type="button" role="menuitem" disabled={disabled} className={`rounded px-2 py-1.5 text-left text-[12px] hover:bg-panel-soft disabled:opacity-40 ${tone === "danger" ? "text-danger" : "text-ink"}`} onClick={onClick}>{children}</button>; }

function groupedActions(entries: AlertLevelEntry[]) { return { prepare: entries.filter(entry => entry.kind === "prepare_stop" || entry.kind === "prepare_quarantine"), auto: entries.filter(entry => entry.kind === "auto_pause" || entry.kind === "auto_quarantine") }; }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
