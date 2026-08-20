// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelList, ChannelSetupModal, NOTIFICATION_CHANNELS, type NotificationTargetsState } from "../src/client/components/notifications";
import type { NotificationTarget } from "../src/client/types";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

const targets: NotificationTarget[] = [
  { id: "discord", kind: "discord", label: "Ops server", providerId: null, enabled: true, createdAt: 1, updatedAt: 1, lastDeliveryAt: null, lastDeliveryOk: null, lastDeliveryError: null },
  { id: "slack", kind: "slack", label: "Platform alerts", providerId: null, enabled: true, createdAt: 1, updatedAt: 1, lastDeliveryAt: null, lastDeliveryOk: null, lastDeliveryError: null },
];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ChannelList grid", () => {
  it("places the add cell after every saved channel in a responsive grid", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "https://brolly.test").pathname;
      const body = path === "/api/cloudflare-zones" ? { accountId: "account", zones: [{ id: "zone", name: "example.com" }] } : { providers: [] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }));
    const state = {
      targets,
      credentialStorageReady: true,
      loading: false,
      error: "",
      setError: vi.fn(),
      load: vi.fn(async () => {}),
    } as NotificationTargetsState;
    await render(<ChannelList token="test" state={state} layout="grid" />);

    const grid = document.querySelector("[data-channel-grid='true']")!;
    const cells = [...grid.querySelectorAll(":scope > [data-channel-card], :scope > [data-channel-add-cell]")];
    expect(cells).toHaveLength(3);
    expect(cells.at(-1)?.hasAttribute("data-channel-add-cell")).toBe(true);

    await act(async () => button("Add alert channel").click());
    await act(async () => button("Cloudflare Email").click());
    expect(document.querySelector("[role='dialog']")?.textContent).toContain("Add Cloudflare Email");
    expect(document.querySelectorAll("input[aria-label^='Recipient']")).toHaveLength(1);
    await act(async () => button("Add recipient").click());
    expect(document.querySelectorAll("input[aria-label^='Recipient']")).toHaveLength(2);
  });

  it("submits email recipients as one channel group", async () => {
    let submitted: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://brolly.test").pathname;
      if (path === "/api/providers") return json({ providers: [] });
      if (path === "/api/targets" && init?.method === "POST") {
        submitted = JSON.parse(String(init.body));
        return json({ id: "target" });
      }
      return json({});
    }));
    const channel = NOTIFICATION_CHANNELS.find(item => item.kind === "resend")!;
    const onSaved = vi.fn(async () => {});
    await render(<ChannelSetupModal channel={channel} token="test" onClose={() => {}} onSaved={onSaved} />);

    change(document.querySelector("input[placeholder='Resend']")!, "Operations group");
    change(document.querySelector("input[type='password']")!, "secret");
    change(document.querySelectorAll("input[type='email']")[0]!, "alerts@example.com");
    change(document.querySelector("input[aria-label='Recipient 1']")!, "ops@example.com");
    await act(async () => button("Add recipient").click());
    change(document.querySelector("input[aria-label='Recipient 2']")!, "finance@example.com");
    await waitFor(() => expect(button("Save alert channel").disabled).toBe(false));
    await act(async () => button("Save alert channel").click());
    await waitFor(() => expect(submitted).not.toBeNull());

    expect(submitted).toMatchObject({
      kind: "resend",
      label: "Operations group",
      destination: { to: ["ops@example.com", "finance@example.com"] },
    });
    expect(onSaved).toHaveBeenCalledWith("target");
  });
});

async function render(node: React.ReactNode): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(item => item.textContent?.includes(label));
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

function change(input: Element, value: string): void {
  act(() => {
    const field = input as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { assertion(); return; }
    catch (error) { failure = error; await act(async () => { await Promise.resolve(); }); }
  }
  throw failure;
}
