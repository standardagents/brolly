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
    await waitFor(() => expect(document.querySelectorAll("section[draggable='true']")).toHaveLength(3));

    const warning = levelColumn("Warning");
    await click(findButton(warning, "+ Add"));
    await click(findButton(warning, "Ops server"));
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
