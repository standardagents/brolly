// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNotificationTargets } from "../src/client/components/notifications.js";
import { AlertLevelsStep, useAlertLevels } from "../src/client/onboarding/levels.js";
import type { AlertLevel } from "../src/client/types.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function Harness() {
  const targets = useNotificationTargets("test-token");
  const board = useAlertLevels("test-token");
  return <AlertLevelsStep token="test-token" targets={targets} board={board} />;
}

describe("alert level board", () => {
  it("renders columns and persists add, interval, and remove entry interactions", async () => {
    const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
    const levels: AlertLevel[] = [
      { id: "warning", position: 0, label: "Warning", entries: [] },
      { id: "critical", position: 1, label: "Critical", entries: [] },
      { id: "emergency", position: 2, label: "Emergency", entries: [] },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://brolly.test").pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (method !== "GET") calls.push({ path, method, body });
      if (path === "/api/targets" && method === "GET") return json({ credentialStorageReady: true, targets: [{
        id: "target-1", kind: "discord", label: "Ops server", providerId: null, enabled: true,
        createdAt: 1, updatedAt: 1, lastDeliveryAt: null, lastDeliveryOk: null, lastDeliveryError: null,
      }] });
      if (path === "/api/alert-levels" && method === "GET") return json({ levels });
      if (path === "/api/alert-levels/warning/entries" && method === "POST") {
        levels[0]!.entries.push({ id: "entry-1", levelId: "warning", kind: "channel", targetId: String(body.targetId), repeatIntervalMs: null, position: 0 });
        return json({ ok: true }, 201);
      }
      if (path === "/api/alert-levels/warning/entries/entry-1" && method === "PATCH") {
        levels[0]!.entries[0]!.repeatIntervalMs = body.repeatIntervalMs as number;
        return json({ ok: true });
      }
      if (path === "/api/alert-levels/warning/entries/entry-1" && method === "DELETE") {
        levels[0]!.entries = [];
        return json({ ok: true });
      }
      return json({ ok: true });
    }));

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Harness />); });
    await waitFor(() => expect(document.querySelectorAll("section[data-level]")).toHaveLength(3));

    const warning = levelColumn("Warning");
    await click(findButton(warning, "+ Add"));
    // The add menu renders through a portal (it must escape the board's horizontal scroller).
    await click(findButton(document.querySelector("[role='menu']") as HTMLElement, "Ops server"));
    await waitFor(() => expect(warning.querySelector("select[aria-label^='Repeat interval']")).not.toBeNull());
    expect(calls[0]).toMatchObject({ path: "/api/alert-levels/warning/entries", method: "POST", body: { kind: "channel", targetId: "target-1", repeatIntervalMs: null } });

    const select = warning.querySelector("select[aria-label^='Repeat interval']") as HTMLSelectElement;
    await act(async () => { select.value = "900000"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await waitFor(() => expect(calls.some(call => call.method === "PATCH" && call.body.repeatIntervalMs === 900000)).toBe(true));

    await click(warning.querySelector("button[aria-label='Remove Ops server']") as HTMLButtonElement);
    await waitFor(() => expect(calls.some(call => call.method === "DELETE")).toBe(true));
    await waitFor(() => expect(warning.querySelector("select[aria-label^='Repeat interval']")).toBeNull());
  });
});

describe("alert level board drag and drop", () => {
  it("reorders a column with a pointer drag and offers each channel once", async () => {
    const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
    const levels: AlertLevel[] = [
      { id: "warning", position: 0, label: "Warning", entries: [{ id: "entry-1", levelId: "warning", kind: "channel", targetId: "target-1", repeatIntervalMs: null, position: 0 }] },
      { id: "critical", position: 1, label: "Critical", entries: [] },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://brolly.test").pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (method !== "GET") calls.push({ path, method, body });
      if (path === "/api/targets") return json({ credentialStorageReady: true, targets: [{ id: "target-1", kind: "discord", label: "Ops server", providerId: null, enabled: true, createdAt: 1, updatedAt: 1, lastDeliveryAt: null, lastDeliveryOk: null, lastDeliveryError: null }] });
      if (path === "/api/providers") return json({ providers: [] });
      if (path === "/api/alert-levels" && method === "GET") return json({ levels });
      return json({ ok: true });
    }));
    Object.assign(HTMLElement.prototype, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => false) });
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Harness />); });
    await waitFor(() => expect(document.querySelectorAll("section[data-level]")).toHaveLength(2));

    // The Critical column's "+ Add" menu does not offer Ops server, which already sits in Warning.
    await click(findButton(levelColumn("Critical"), "+ Add"));
    const menu = document.querySelector("[role='menu']") as HTMLElement;
    expect([...menu.querySelectorAll("button")].some(button => button.textContent?.trim() === "Ops server")).toBe(false);
    const prepare = findButton(menu, "1-click QuarantineBrolly asks you before it quarantines anything.");
    const automatic = findButton(menu, "Automatic QuarantineBrolly quarantines without asking.");
    expect(prepare.querySelector("svg")).not.toBeNull();
    expect(automatic.querySelector("svg")).not.toBeNull();
    // The quarantinable products are listed once, under both action options.
    expect(menu.textContent).toContain("WorkersDurable ObjectsQueuesOnly the resources that are driving the overspend are affected. Quarantines are reversible.");
    expect(menu.querySelectorAll(".product-glyph")).toHaveLength(3);

    await click(findButton(menu, "+ Add new channel"));
    const resend = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Resend"));
    if (!resend) throw new Error("Resend channel option was not rendered");
    await click(resend);
    await waitFor(() => expect(document.querySelector("[role='dialog']")?.textContent).toContain("Add Resend"));
    expect(document.querySelector("[role='dialog']")?.parentElement?.parentElement).toBe(document.body);
    await click(document.querySelector("[role='dialog'] button[aria-label='Close']") as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector("[role='dialog']")).toBeNull());

    // Drag Critical's handle left of Warning: every slot rect is 0×0 in this DOM, so the pointer lands at index 0.
    const handle = levelColumn("Critical").querySelector("button[aria-label='Drag Critical to reorder']") as HTMLButtonElement;
    await act(async () => {
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 400, clientY: 20, button: 0, pointerId: 1 }));
      handle.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 300, clientY: 20, pointerId: 1 }));
      handle.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: -100, clientY: 20, pointerId: 1 }));
    });
    expect(document.querySelector("[aria-hidden='true'].border-dashed")).not.toBeNull();
    // The handle unmounts once its column becomes a placeholder; the browser still delivers pointerup to the document.
    await act(async () => { document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: -100, clientY: 20, pointerId: 1 })); });
    await waitFor(() => expect(calls.some(call => call.method === "PATCH" && call.path === "/api/alert-levels/critical" && call.body.position === 0)).toBe(true));
  });
});

function levelColumn(label: string): HTMLElement {
  const input = [...document.querySelectorAll<HTMLInputElement>("input[aria-label^='Level name']")].find(element => element.value === label);
  if (!input) throw new Error(`Level ${label} was not rendered`);
  return input.closest("section") as HTMLElement;
}

function findButton(parent: ParentNode, text: string): HTMLButtonElement {
  const button = [...parent.querySelectorAll("button")].find(element => element.textContent?.trim() === text);
  if (!button) throw new Error(`Button ${text} was not rendered`);
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => { button.click(); });
}

async function waitFor(assertion: () => void): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { assertion(); return; }
    catch (cause) { error = cause; await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
  }
  throw error;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
