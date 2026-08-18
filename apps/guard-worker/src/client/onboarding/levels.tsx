import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { AddChannelRow, ChannelCredentialsForm, targetName, type NotificationChannel, type NotificationTargetsState } from "../components/notifications";
import { Button, ChannelLogo, Icon, IconButton, Notice, Popover, Spinner } from "../components/ui";
import { useOutsideClose } from "../lib/outside-close";
import type { AlertEntryKind, AlertLevel, AlertLevelEntry, AlertLevelsResponse } from "../types";
import { slotIndexAt, useDragSession, useFlip, useLeaving, type DragSession } from "./board-motion";
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

const COLUMN_WIDTH = 290;
type Target = NotificationTargetsState["targets"][number];

export function useAlertLevels(token: string) {
  const [levels, setLevels] = useState<AlertLevel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Only the first load shows the spinner; later reloads (after every
  // mutation) swap the data in place so the board never unmounts and flashes.
  const loaded = useRef(false);
  const load = useCallback(async () => {
    if (!loaded.current) setLoading(true);
    setError("");
    try { setLevels((await api<AlertLevelsResponse>("/api/alert-levels", token)).levels); loaded.current = true; }
    catch (cause) { setError(message(cause)); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  return { levels, setLevels, loading, error, setError, load };
}

/** What is being dragged and where it would land. */
type Drag =
  | { kind: "column"; id: string; targetIndex: number; height: number }
  | { kind: "entry"; id: string; action?: "prepare" | "auto"; fromLevelId: string; targetLevelId: string; targetIndex: number; height: number };

export function AlertLevelsStep({ token, targets, board }: { token: string; targets: NotificationTargetsState; board: ReturnType<typeof useAlertLevels> }) {
  const [draft, setDraft] = useState("");
  const [addingAfter, setAddingAfter] = useState<string | null | undefined>(undefined);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [scroll, setScroll] = useState({ atStart: true, atEnd: true });
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  useFlip(boardRef);
  // While something is dragged the board keeps its starting height, so a
  // column losing or gaining a card cannot make the page height jitter.
  useEffect(() => {
    if (drag && lockedHeight === null) setLockedHeight(boardRef.current?.getBoundingClientRect().height ?? null);
    if (!drag && lockedHeight !== null) setLockedHeight(null);
  }, [drag, lockedHeight]);

  const updateScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setScroll({ atStart: scroller.scrollLeft <= 1, atEnd: scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1 });
  }, []);
  useEffect(() => {
    updateScroll();
    window.addEventListener("resize", updateScroll);
    return () => window.removeEventListener("resize", updateScroll);
  }, [updateScroll, board.levels.length, board.loading]);
  const step = (direction: 1 | -1) => scrollerRef.current?.scrollBy({ left: direction * (COLUMN_WIDTH + 12), behavior: "smooth" });

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
    board.setLevels(current => reorder(current, level.id, position).map((item, index) => ({ ...item, position: index })));
    await mutate(`/api/alert-levels/${encodeURIComponent(level.id)}`, { method: "PATCH", body: JSON.stringify({ position }) });
  }

  /** Move a channel entry to `toLevelId` at `toIndex` (index among that level's channel entries). */
  async function moveEntry(entryId: string, fromLevelId: string, toLevelId: string, toIndex: number) {
    const from = board.levels.find(level => level.id === fromLevelId);
    const entry = from?.entries.find(item => item.id === entryId);
    if (!from || !entry) return;
    const optimistic = moveEntryLocally(board.levels, entryId, fromLevelId, toLevelId, toIndex);
    if (!optimistic) return;
    board.setLevels(optimistic.levels);
    board.setError("");
    try {
      if (fromLevelId === toLevelId) {
        await api(`/api/alert-levels/${encodeURIComponent(toLevelId)}/entries/${encodeURIComponent(entryId)}`, token, { method: "PATCH", body: JSON.stringify({ position: optimistic.position }) });
      } else {
        await api(`/api/alert-levels/${encodeURIComponent(fromLevelId)}/entries/${encodeURIComponent(entryId)}`, token, { method: "DELETE" });
        const created = await api<{ entry?: { id: string }; id?: string }>(`/api/alert-levels/${encodeURIComponent(toLevelId)}/entries`, token, {
          method: "POST", body: JSON.stringify({ kind: "channel", targetId: entry.targetId, repeatIntervalMs: entry.repeatIntervalMs }),
        });
        const newId = created.entry?.id ?? created.id;
        if (newId) await api(`/api/alert-levels/${encodeURIComponent(toLevelId)}/entries/${encodeURIComponent(newId)}`, token, { method: "PATCH", body: JSON.stringify({ position: optimistic.position }) });
      }
      await board.load();
    } catch (cause) { board.setError(message(cause)); await board.load(); }
  }

  const columnDrag = useDragSession<{ id: string }>({
    onMove(session) {
      const rects = columnRects(boardRef.current, session.data.id);
      const targetIndex = slotIndexAt(rects, session.x, "x");
      setDrag(current => (current?.kind === "column" && current.targetIndex === targetIndex ? current : { kind: "column", id: session.data.id, targetIndex, height: session.height }));
    },
    onDrop(session) {
      const rects = columnRects(boardRef.current, session.data.id);
      const targetIndex = slotIndexAt(rects, session.x, "x");
      setDrag(null);
      const level = board.levels.find(item => item.id === session.data.id);
      if (level && targetIndex !== level.position) void move(level, targetIndex);
    },
  });

  /** Move a prepare/auto action group to another level (both entries of the group travel together). */
  async function moveAction(mode: "prepare" | "auto", fromLevelId: string, toLevelId: string) {
    if (fromLevelId === toLevelId) return;
    const kinds: AlertEntryKind[] = mode === "prepare" ? ["prepare_stop", "prepare_quarantine"] : ["auto_pause", "auto_quarantine"];
    const from = board.levels.find(level => level.id === fromLevelId);
    const moving = from?.entries.filter(entry => kinds.includes(entry.kind)) ?? [];
    if (!moving.length) return;
    board.setLevels(current => current.map(level => level.id === fromLevelId
      ? { ...level, entries: level.entries.filter(entry => !kinds.includes(entry.kind)) }
      : level.id === toLevelId
        ? { ...level, entries: [...level.entries.filter(entry => !kinds.includes(entry.kind)), ...moving.map(entry => ({ ...entry, levelId: toLevelId }))] }
        : level));
    board.setError("");
    try {
      for (const entry of moving) await api(`/api/alert-levels/${encodeURIComponent(fromLevelId)}/entries/${encodeURIComponent(entry.id)}`, token, { method: "DELETE" });
      for (const kind of kinds) await api(`/api/alert-levels/${encodeURIComponent(toLevelId)}/entries`, token, { method: "POST", body: JSON.stringify({ kind }) });
      await board.load();
    } catch (cause) { board.setError(message(cause)); await board.load(); }
  }

  const entryDrag = useDragSession<{ id: string; levelId: string; action?: "prepare" | "auto" }>({
    onMove(session) {
      const target = entryTarget(boardRef.current, session);
      if (!target) return;
      setDrag(current => (current?.kind === "entry" && current.targetLevelId === target.levelId && current.targetIndex === target.index
        ? current
        : { kind: "entry", id: session.data.id, action: session.data.action, fromLevelId: session.data.levelId, targetLevelId: target.levelId, targetIndex: target.index, height: session.height }));
    },
    onDrop(session) {
      const target = entryTarget(boardRef.current, session);
      setDrag(null);
      if (!target) return;
      if (session.data.action) void moveAction(session.data.action, session.data.levelId, target.levelId);
      else void moveEntry(session.data.id, session.data.levelId, target.levelId, target.index);
    },
  });

  // Visual model: columns in drop order with a placeholder for the dragged
  // column, and entries per level with a placeholder for the dragged entry.
  const visualLevels = useMemo(() => {
    if (drag?.kind !== "column") return board.levels;
    return reorder(board.levels, drag.id, drag.targetIndex);
  }, [board.levels, drag]);
  const usedTargets = useMemo(() => new Set(board.levels.flatMap(level => level.entries.filter(entry => entry.kind === "channel").map(entry => entry.targetId))), [board.levels]);
  const draggedEntry = drag?.kind === "entry" && !drag.action ? board.levels.flatMap(level => level.entries).find(entry => entry.id === drag.id) ?? null : null;
  const usedActions = useMemo(() => ({
    prepare: board.levels.some(level => groupedActions(level.entries).prepare.length > 0),
    auto: board.levels.some(level => groupedActions(level.entries).auto.length > 0),
  }), [board.levels]);
  const columns = useLeaving(visualLevels, level => level.id);

  return <>
    <StepIntro title="Build alert levels">Each entry applies to its column and every column to the right. Columns may stay empty.</StepIntro>
    {board.loading && <Spinner />}
    {board.error && <Notice tone="error">{board.error}</Notice>}
    {!board.loading && (
      /* The scroller bleeds to the wizard card's border (its padding is clamp(26px,4vw,48px), 16px below md) so columns scroll to the edge instead of clipping inside the content box. */
      <div ref={scrollerRef} onScroll={updateScroll} className="-mx-[clamp(26px,4vw,48px)] min-w-0 overflow-x-auto px-[clamp(26px,4vw,48px)] pb-3 max-md:-mx-4 max-md:px-4" aria-label="Alert level board">
        <div ref={boardRef} className="flex min-w-max items-stretch gap-3" style={{ minHeight: lockedHeight ?? undefined }}>
          {columns.map(({ item: level, leaving }) => {
            const index = visualLevels.findIndex(item => item.id === level.id);
            const isDraggedColumn = drag?.kind === "column" && drag.id === level.id;
            return (
              <div key={level.id} data-flip-key={`column:${level.id}`} data-column={level.id} className={`flex-none ${leaving ? "board-out" : "board-in"}`} style={{ width: COLUMN_WIDTH }}>
                {isDraggedColumn ? (
                  <div className="rounded-panel border-2 border-dashed border-orange/60 bg-orange-soft/30" style={{ height: drag.kind === "column" ? drag.height : undefined, minHeight: 120 }} aria-hidden="true" />
                ) : (
                  <LevelColumn
                    level={level}
                    index={index}
                    count={board.levels.length}
                    token={token}
                    targets={targets}
                    usedTargets={usedTargets}
                    usedActions={usedActions}
                    entryDrag={drag?.kind === "entry" ? { ...drag, entry: draggedEntry } : null}
                    onGrabColumn={(event, element) => columnDrag.startDrag(event, { id: level.id }, element, scrollerRef.current)}
                    onGrabEntry={(event, entryId, element) => entryDrag.startDrag(event, { id: entryId, levelId: level.id }, element, scrollerRef.current)}
                    onGrabAction={(event, mode, element) => entryDrag.startDrag(event, { id: `action:${mode}`, levelId: level.id, action: mode }, element, scrollerRef.current)}
                    onMove={position => void move(level, position)}
                    onAddBefore={() => addBefore(level)}
                    onAddAfter={() => setAddingAfter(level.id)}
                    onChanged={board.load}
                    onError={board.setError}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    )}
    {columnDrag.session && (() => {
      const level = board.levels.find(item => item.id === columnDrag.session!.data.id);
      return level ? <Ghost session={columnDrag.session}>
        <div className="rounded-panel shadow-drawer" style={{ width: COLUMN_WIDTH, height: columnDrag.session.height }}>
          <LevelColumn level={level} index={level.position} count={board.levels.length} token={token} targets={targets} usedTargets={usedTargets} usedActions={usedActions} entryDrag={null}
            onGrabColumn={() => {}} onGrabEntry={() => {}} onGrabAction={() => {}} onMove={() => {}} onAddBefore={() => {}} onAddAfter={() => {}} onChanged={async () => {}} onError={() => {}} ghost />
        </div>
      </Ghost> : null;
    })()}
    {entryDrag.session?.data.action && <Ghost session={entryDrag.session}>
      <div className="shadow-drawer" style={{ width: entryDrag.session.width }}><ActionEntry mode={entryDrag.session.data.action} onRemove={() => {}} onGrab={() => {}} ghost /></div>
    </Ghost>}
    {entryDrag.session && draggedEntry && <Ghost session={entryDrag.session}>
      <div className="shadow-drawer" style={{ width: entryDrag.session.width }}>
        <ChannelEntry entry={draggedEntry} slotIndex={-1} leaving={false} target={targets.targets.find(target => target.id === draggedEntry.targetId)} token={token} levelId={draggedEntry.levelId}
          onGrab={() => {}} onChanged={async () => {}} onError={() => {}} ghost />
      </div>
    </Ghost>}
    {addingAfter !== undefined ? (
      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-field border border-line-soft bg-panel-soft p-3">
        <label className="flex flex-col gap-1 text-[12px] font-[680]">Level name<input autoFocus className="min-h-[38px] rounded-field border border-field-line bg-field px-2.5 text-[13px]" value={draft} maxLength={40} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void addLevel(); } }} /></label>
        <Button variant="primary" disabled={!draft.trim()} onClick={() => void addLevel()}>Add level</Button>
        <Button variant="quiet" onClick={() => { setDraft(""); setAddingAfter(undefined); }}>Cancel</Button>
      </div>
    ) : (
      <div className="flex items-center justify-between gap-3">
        {board.levels.length < 8 ? <Button variant="secondary" onClick={() => setAddingAfter(board.levels.at(-1)?.id ?? null)}>Add level</Button> : <span />}
        {!(scroll.atStart && scroll.atEnd) && (
          <div className="inline-flex items-center gap-1.5" role="group" aria-label="Scroll alert levels">
            <IconButton aria-label="Previous level" disabled={scroll.atStart} className="size-8 disabled:cursor-default disabled:opacity-40" onClick={() => step(-1)}><Icon name="arrow" className="size-4 rotate-180" /></IconButton>
            <IconButton aria-label="Next level" disabled={scroll.atEnd} className="size-8 disabled:cursor-default disabled:opacity-40" onClick={() => step(1)}><Icon name="arrow" className="size-4" /></IconButton>
          </div>
        )}
      </div>
    )}
  </>;
}

/** Floating copy of the dragged item that follows the pointer. */
function Ghost({ session, children }: { session: DragSession<unknown>; children: React.ReactNode }) {
  return createPortal(
    <div className="pointer-events-none fixed z-[60] rotate-[1.5deg] opacity-95" style={{ left: session.x - session.grabX, top: session.y - session.grabY }} aria-hidden="true">{children}</div>,
    document.body,
  );
}

function LevelColumn({ level, index, count, token, targets, usedTargets, usedActions, entryDrag, onGrabColumn, onGrabEntry, onGrabAction, onMove, onAddBefore, onAddAfter, onChanged, onError, ghost = false }: {
  level: AlertLevel; index: number; count: number; token: string; targets: NotificationTargetsState; usedTargets: Set<string | null>;
  usedActions: { prepare: boolean; auto: boolean };
  entryDrag: { id: string; action?: "prepare" | "auto"; fromLevelId: string; targetLevelId: string; targetIndex: number; height: number; entry: AlertLevelEntry | null } | null;
  onGrabColumn: (event: React.PointerEvent, element: HTMLElement) => void;
  onGrabEntry: (event: React.PointerEvent, entryId: string, element: HTMLElement) => void;
  onGrabAction: (event: React.PointerEvent, mode: "prepare" | "auto", element: HTMLElement) => void;
  onMove: (position: number) => void; onAddBefore: () => void; onAddAfter: () => void;
  onChanged: () => Promise<void>; onError: (error: string) => void;
  /** Non-interactive copy rendered inside the drag ghost. */
  ghost?: boolean;
}) {
  const [label, setLabel] = useState(level.label);
  const [addOpen, setAddOpen] = useState(false);
  const [newChannel, setNewChannel] = useState<NotificationChannel | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
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

  // Channel entries in visual order: the dragged one removed, a placeholder
  // slot inserted where it would land.
  const channels = level.entries.filter(entry => entry.kind === "channel" && entry.id !== entryDrag?.id);
  const slot = entryDrag && !entryDrag.action && entryDrag.targetLevelId === level.id ? Math.min(entryDrag.targetIndex, channels.length) : -1;
  const actionDragHere = entryDrag?.action && entryDrag.fromLevelId === level.id ? entryDrag.action : null;
  const actionSlotHere = entryDrag?.action && entryDrag.targetLevelId === level.id && entryDrag.fromLevelId !== level.id ? entryDrag.action : null;
  const rows: Array<{ kind: "entry"; entry: AlertLevelEntry } | { kind: "slot" }> = channels.map(entry => ({ kind: "entry" as const, entry }));
  if (slot >= 0) rows.splice(slot, 0, { kind: "slot" });
  const listed = useLeaving(rows.filter((row): row is { kind: "entry"; entry: AlertLevelEntry } => row.kind === "entry").map(row => row.entry), entry => entry.id);

  return (
    <section ref={sectionRef} data-level={ghost ? undefined : level.id} className={`flex h-full flex-col rounded-panel border bg-panel p-3.5 transition-colors ${ghost ? "pointer-events-none border-orange" : entryDrag && entryDrag.targetLevelId === level.id ? "border-orange shadow-[0_0_0_3px_#f6821f1f]" : "border-line"}`}>
      <header className="mb-3 flex items-center gap-1.5">
        <button type="button" className="cursor-grab touch-none rounded px-1 text-faint hover:text-ink active:cursor-grabbing" title="Drag to reorder" aria-label={`Drag ${level.label} to reorder`} onPointerDown={event => onGrabColumn(event, sectionRef.current!)}>⠿</button>
        <input aria-label={`Level name: ${level.label}`} className="min-w-0 flex-1 rounded-field border border-transparent bg-transparent px-1.5 py-1 text-[14px] font-[750] hover:border-field-line focus:border-orange focus:outline-none" value={label} onChange={event => setLabel(event.target.value)} onBlur={() => void rename()} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
        <LevelMenu index={index} count={count} canAdd={count < 8} canDelete={count > 1} onMove={onMove} onAddBefore={onAddBefore} onAddAfter={onAddAfter} onDelete={() => void deleteLevel()} />
      </header>
      <div className="grid gap-2" data-entry-list={level.id}>
        {rows.map((row, position) => row.kind === "slot"
          ? <div key="slot" data-flip-key={`slot:${entryDrag?.id}`} data-entry-slot={position} className="rounded-field border-2 border-dashed border-orange/60 bg-orange-soft/30" style={{ height: entryDrag?.height ?? 74 }} aria-hidden="true" />
          : (
            <ChannelEntry
              key={row.entry.id}
              entry={row.entry}
              slotIndex={position}
              leaving={listed.find(item => item.item.id === row.entry.id)?.leaving ?? false}
              target={targets.targets.find(target => target.id === row.entry.targetId)}
              token={token}
              levelId={level.id}
              onGrab={(event, element) => onGrabEntry(event, row.entry.id, element)}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        {actionEntries.prepare.length > 0 && actionDragHere !== "prepare" && <ActionEntry mode="prepare" onRemove={() => void removeEntries(actionEntries.prepare)} onGrab={(event, element) => onGrabAction(event, "prepare", element)} />}
        {actionEntries.auto.length > 0 && actionDragHere !== "auto" && <ActionEntry mode="auto" onRemove={() => void removeEntries(actionEntries.auto)} onGrab={(event, element) => onGrabAction(event, "auto", element)} />}
        {actionSlotHere && <div data-flip-key={`slot:action:${actionSlotHere}`} className="rounded-field border-2 border-dashed border-orange/60 bg-orange-soft/30" style={{ height: entryDrag?.height ?? 74 }} aria-hidden="true" />}
        {newChannel ? (
          <div className="rounded-field border border-line-soft p-2.5"><ChannelCredentialsForm channel={newChannel} token={token} onCancel={() => setNewChannel(null)} onSaved={async targetId => { await targets.load(); await addEntry("channel", targetId); setNewChannel(null); }} /></div>
        ) : <LevelAddMenu open={addOpen} setOpen={setAddOpen} level={level} targets={targets} usedTargets={usedTargets} usedActions={usedActions} onChannel={targetId => void addEntry("channel", targetId)} onNewChannel={setNewChannel} onAction={mode => void addAction(mode)} />}
      </div>
    </section>
  );
}

function EntryHead({ target }: { target: Target | undefined }) {
  return <div className="flex items-center gap-2">{target && <ChannelLogo kind={target.kind} />}<strong className="min-w-0 flex-1 truncate text-[12.5px]">{target ? targetName(target) : "Removed channel"}</strong></div>;
}

function ChannelEntry({ entry, slotIndex, leaving, target, token, levelId, onGrab, onChanged, onError, ghost = false }: {
  entry: AlertLevelEntry; slotIndex: number; leaving: boolean; target: Target | undefined; token: string; levelId: string;
  onGrab: (event: React.PointerEvent, element: HTMLElement) => void; onChanged: () => Promise<void>; onError: (error: string) => void;
  ghost?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  async function patch(repeatIntervalMs: number | null) { try { await api(`/api/alert-levels/${encodeURIComponent(levelId)}/entries/${encodeURIComponent(entry.id)}`, token, { method: "PATCH", body: JSON.stringify({ repeatIntervalMs }) }); await onChanged(); } catch (cause) { onError(message(cause)); } }
  async function remove() { try { await api(`/api/alert-levels/${encodeURIComponent(levelId)}/entries/${encodeURIComponent(entry.id)}`, token, { method: "DELETE" }); await onChanged(); } catch (cause) { onError(message(cause)); } }
  return (
    <article ref={ref} data-flip-key={ghost ? undefined : `entry:${entry.id}`} data-entry-slot={ghost ? undefined : slotIndex} className={`rounded-field border bg-panel-soft p-2.5 ${ghost ? "pointer-events-none border-orange" : leaving ? "board-out border-line-soft" : "board-in border-line-soft"}`}>
      <div className="flex items-center gap-2">
        <button type="button" className="-ml-1 cursor-grab touch-none rounded px-0.5 text-faint hover:text-ink active:cursor-grabbing" aria-label={`Drag ${target ? targetName(target) : "channel"} to another level`} title="Drag to move" onPointerDown={event => onGrab(event, ref.current!)}>⠿</button>
        <div className="min-w-0 flex-1"><EntryHead target={target} /></div>
        <button type="button" aria-label={`Remove ${target ? targetName(target) : "channel"}`} className="text-faint hover:text-danger" onClick={() => void remove()}><Icon name="x" className="size-4" /></button>
      </div>
      <label className="mt-2 flex items-center justify-between gap-2 text-[11.5px] text-muted">Repeat<select aria-label={`Repeat interval for ${target ? targetName(target) : "channel"}`} className="min-h-8 rounded-field border border-field-line bg-field px-2 text-[12px] text-ink" value={entry.repeatIntervalMs ?? ""} onChange={event => void patch(event.target.value ? Number(event.target.value) : null)}>{INTERVALS.map(interval => <option key={interval.label} value={interval.value}>{interval.label}</option>)}</select></label>
    </article>
  );
}

function ActionEntry({ mode, onRemove, onGrab, ghost = false }: { mode: "prepare" | "auto"; onRemove: () => void; onGrab: (event: React.PointerEvent, element: HTMLElement) => void; ghost?: boolean }) {
  const auto = mode === "auto";
  const ref = useRef<HTMLElement>(null);
  return (
    <article ref={ref} data-flip-key={ghost ? undefined : `action:${mode}`} className={`rounded-field border p-2.5 ${ghost ? "pointer-events-none" : "board-in"} ${auto ? "border-danger-line bg-danger-bg text-danger" : "border-warn-line bg-warn-bg text-warn"}`}>
      <div className="flex items-start gap-2">
        <button type="button" className="-ml-1 cursor-grab touch-none rounded px-0.5 opacity-70 hover:opacity-100 active:cursor-grabbing" aria-label={`Drag ${auto ? "auto" : "prepare"} action to another level`} title="Drag to move" onPointerDown={event => onGrab(event, ref.current!)}>⠿</button>
        <Icon name="alert" className="mt-px size-4" />
        <span className="min-w-0 flex-1">
          <strong className="block text-[12.5px]">{auto ? "Act automatically" : "Prepare an action for your approval"}</strong>
          <span className="block text-[11.5px] leading-[1.4]">{auto
            ? "Brolly stops, quarantines, or pauses the biggest contributors itself. Every action is reversible and audited."
            : "Brolly finds the biggest contributors and prepares a stop, quarantine, or pause. Nothing changes until you approve it."}</span>
        </span>
        <button type="button" aria-label={`Remove ${mode} action`} onClick={onRemove}><Icon name="x" className="size-4" /></button>
      </div>
    </article>
  );
}

function LevelAddMenu({ open, setOpen, level, targets, usedTargets, usedActions, onChannel, onNewChannel, onAction }: { open: boolean; setOpen: (open: boolean) => void; level: AlertLevel; targets: NotificationTargetsState; usedTargets: Set<string | null>; usedActions: { prepare: boolean; auto: boolean }; onChannel: (targetId: string) => void; onNewChannel: (channel: NotificationChannel) => void; onAction: (mode: "prepare" | "auto") => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useOutsideClose([ref, panel], open, () => setOpen(false));
  // A channel can sit in one level only; it applies to every level to the right.
  const available = targets.targets.filter(target => !usedTargets.has(target.id));
  // Actions, like channels, sit in one level and apply to every level to the right.
  const grouped = { prepare: usedActions.prepare ? [level] : [], auto: usedActions.auto ? [level] : [] };
  return <div ref={ref} className="relative"><button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center justify-center gap-1 rounded-field border border-dashed border-line px-3 py-2 text-[12.5px] font-[680] text-muted hover:border-orange hover:text-ink">+ Add</button><Popover anchor={ref} open={open} side="top" align="stretch"><div ref={panel} role="menu" className="grid gap-1 rounded-panel border border-line bg-panel p-1.5 shadow-panel">{available.map(target => <button key={target.id} type="button" role="menuitem" className="flex items-center gap-2 rounded-field px-2 py-1.5 text-left text-[12px] hover:bg-panel-soft" onClick={() => { setOpen(false); onChannel(target.id); }}><ChannelLogo kind={target.kind} />{targetName(target)}</button>)}{available.length === 0 && targets.targets.length > 0 && <p className="px-2 py-1.5 text-[11.5px] text-faint">Every channel is placed. Drag one here to move it.</p>}<AddChannelRow label="Add new channel" onPick={channel => { setOpen(false); onNewChannel(channel); }} />{grouped.prepare.length === 0 && <button type="button" role="menuitem" className="rounded-field px-2 py-2 text-left text-[12px] text-warn hover:bg-warn-bg" onClick={() => { setOpen(false); onAction("prepare"); }}>Prepare an action for your approval</button>}{grouped.auto.length === 0 && <button type="button" role="menuitem" className="rounded-field px-2 py-2 text-left text-[12px] text-danger hover:bg-danger-bg" onClick={() => { setOpen(false); onAction("auto"); }}>Act automatically</button>}</div></Popover></div>;
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

/** Move the level with `id` to `index`, keeping the others in order. */
function reorder(levels: AlertLevel[], id: string, index: number): AlertLevel[] {
  const moved = levels.find(level => level.id === id);
  if (!moved) return levels;
  const rest = levels.filter(level => level.id !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, moved);
  return rest;
}

/** Column rects in board order, excluding the dragged column's own slot. */
function columnRects(board: HTMLDivElement | null, draggedId: string): DOMRect[] {
  if (!board) return [];
  return [...board.querySelectorAll<HTMLElement>("[data-column]")].filter(node => node.dataset.column !== draggedId).map(node => node.getBoundingClientRect());
}

/** The level and channel-slot index under the pointer for an entry drag. */
function entryTarget(board: HTMLDivElement | null, session: DragSession<{ id: string; levelId: string }>): { levelId: string; index: number } | null {
  if (!board) return null;
  const columns = [...board.querySelectorAll<HTMLElement>("[data-level]")];
  const column = columns.find(node => { const rect = node.getBoundingClientRect(); return session.x >= rect.left && session.x <= rect.right; })
    ?? columns.reduce<HTMLElement | null>((closest, node) => {
      const rect = node.getBoundingClientRect();
      const distance = Math.min(Math.abs(session.x - rect.left), Math.abs(session.x - rect.right));
      if (!closest) return node;
      const closestRect = closest.getBoundingClientRect();
      return distance < Math.min(Math.abs(session.x - closestRect.left), Math.abs(session.x - closestRect.right)) ? node : closest;
    }, null);
  if (!column) return null;
  const levelId = column.dataset.level!;
  const rects = [...column.querySelectorAll<HTMLElement>("[data-entry-slot]")]
    .filter(node => node.dataset.flipKey !== `slot:${session.data.id}` && node.dataset.flipKey !== `entry:${session.data.id}`)
    .map(node => node.getBoundingClientRect());
  return { levelId, index: slotIndexAt(rects, session.y, "y") };
}

/**
 * Local (optimistic) version of an entry move. Returns the new level list
 * and the entry's position inside the destination level's full entry list.
 */
export function moveEntryLocally(levels: AlertLevel[], entryId: string, fromLevelId: string, toLevelId: string, toChannelIndex: number): { levels: AlertLevel[]; position: number } | null {
  const from = levels.find(level => level.id === fromLevelId);
  const entry = from?.entries.find(item => item.id === entryId);
  if (!from || !entry) return null;
  const withoutEntry = levels.map(level => ({ ...level, entries: level.entries.filter(item => item.id !== entryId) }));
  const to = withoutEntry.find(level => level.id === toLevelId);
  if (!to) return null;
  const channelPositions = to.entries.map((item, index) => ({ item, index })).filter(({ item }) => item.kind === "channel");
  const clampedIndex = Math.max(0, Math.min(toChannelIndex, channelPositions.length));
  const position = clampedIndex < channelPositions.length
    ? channelPositions[clampedIndex]!.index
    : (channelPositions.at(-1)?.index ?? -1) + 1;
  const entries = [...to.entries];
  entries.splice(position, 0, { ...entry, levelId: toLevelId });
  return {
    levels: withoutEntry.map(level => (level.id === toLevelId ? { ...level, entries: entries.map((item, index) => ({ ...item, position: index })) } : level)),
    position,
  };
}
