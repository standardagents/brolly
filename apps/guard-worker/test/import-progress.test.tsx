// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportProgress, ImportProgressView, initialIngestionOverallProgress } from "../src/client/onboarding/ingest.js";
import type { InitialIngestionResponse } from "../src/client/types.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("initial import progress", () => {
  it("renders capability planning before work units have been persisted", async () => {
    const container = await render({
      ingestion: { job: { id: "job", status: "planning", startedAt: 1, updatedAt: 1 }, days: null, collectors: [] },
      running: true,
      error: "",
      billingConnected: true,
    });

    expect(container.querySelector("[data-import-state='planning']")).not.toBeNull();
    expect(container.querySelectorAll("[role='progressbar']")).toHaveLength(0);
  });

  it("renders one row from aggregate work before a whole day completes", async () => {
    const ingestion: InitialIngestionResponse = {
      job: { id: "job", status: "running", startedAt: 1_000_000, updatedAt: 1_001_000 },
      days: { total: 90, complete: 0, pending: 90, gaps: 0, failedWindows: 0, errors: [] },
      collectors: [collector(100, 25)],
    };
    const container = await render({ ingestion, running: true, error: "", billingConnected: true, now: 1_240_000 });
    const progress = [...container.querySelectorAll<HTMLElement>("[role='progressbar']")];

    expect(container.querySelector("[data-import-state='importing']")).not.toBeNull();
    expect(progress).toHaveLength(1);
    expect(progress[0]?.getAttribute("aria-valuemax")).toBe("100");
    expect(progress[0]?.getAttribute("aria-valuenow")).toBe("25");
    expect(progress[0]?.dataset).toMatchObject({ importDays: "0", importProgress: "25", importErrors: "0" });
    expect(initialIngestionOverallProgress(ingestion, 1_240_000)).toMatchObject({
      percentage: 25,
      estimatedRemainingMs: 720_000,
      processedUnits: 25,
      totalUnits: 100,
    });

    const trigger = container.querySelector<HTMLButtonElement>("[data-import-details-trigger]");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-import-details]")).toBeNull();
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-import-details]")).not.toBeNull();
    expect(container.querySelectorAll("[data-import-collector]")).toHaveLength(1);
    expect(container.querySelectorAll("[role='progressbar']")).toHaveLength(2);
  });

  it("keeps unavailable source data behind a counted error popover", async () => {
    const ingestion: InitialIngestionResponse = {
      job: { id: "job", status: "running", startedAt: 1, updatedAt: 2 },
      days: { total: 90, complete: 10, pending: 80, gaps: 77, failedWindows: 18, errors: ["coverage gap"] },
      collectors: [collector(100, 10)],
    };
    const container = await render({ ingestion, running: true, error: "", billingConnected: false });
    const progress = container.querySelector<HTMLElement>("[role='progressbar']");
    const trigger = container.querySelector<HTMLButtonElement>("[data-import-error-trigger]");

    expect(progress?.getAttribute("aria-valuenow")).toBe("10");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector("[role='dialog']")).not.toBeNull();
  });

  it("shows the Cloudflare retry countdown and fallback ETA while rate limited", async () => {
    const now = 1_000_000;
    const ingestion: InitialIngestionResponse = {
      job: {
        id: "job",
        status: "running",
        startedAt: now - 60_000,
        updatedAt: now,
        limiterMode: "shared-fallback",
        resumeAt: now + 4 * 60_000,
        sharedQueryLimit: 280,
      },
      days: { total: 90, complete: 45, pending: 45, gaps: 0, failedWindows: 0, errors: [] },
      collectors: [collector(100, 50)],
    };
    const container = await render({ ingestion, running: true, error: "", billingConnected: true, now });
    const panel = container.querySelector<HTMLElement>("[data-import-state='rate_limited']");

    expect(panel?.dataset).toMatchObject({ importLimiterMode: "shared-fallback", importResumeAt: String(now + 4 * 60_000) });
    expect(panel?.textContent).toContain("Cloudflare wait ~4 min · ~5 min total");
    expect(panel?.querySelector("[aria-label='Import paused']")).not.toBeNull();
  });

  it("keeps terminal coverage gaps visible and hides a fully successful import", async () => {
    const withGap: InitialIngestionResponse = {
      job: { id: "job", status: "complete_with_gaps", startedAt: 1, updatedAt: 2 },
      days: { total: 90, complete: 80, pending: 0, gaps: 10, failedWindows: 1, errors: ["coverage gap"] },
      collectors: [collector(100, 80, 20)],
    };
    const container = await render({ ingestion: withGap, running: false, error: "", billingConnected: false });
    expect(container.querySelector("[data-import-state='complete_with_gaps']")).not.toBeNull();
    expect(container.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("100");
    expect(container.querySelector("[data-import-error-trigger]")).not.toBeNull();

    await act(async () => {
      root!.render(<ImportProgressView
        ingestion={{ ...withGap, job: { ...withGap.job!, status: "complete" }, days: { total: 90, complete: 90, pending: 0, gaps: 0, failedWindows: 0, errors: [] } }}
        running={false}
        error=""
        billingConnected={false}
      />);
    });
    expect(container.children).toHaveLength(0);
  });

  it("retries progress polling after a transient request failure", async () => {
    vi.useFakeTimers();
    let progressRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ ok: true });
      progressRequests += 1;
      if (progressRequests === 1) return Response.json({ error: "temporary" }, { status: 500 });
      return Response.json({
        job: { id: "job", status: "complete", startedAt: 1, updatedAt: 2 },
        days: { total: 90, complete: 90, pending: 0, gaps: 0, failedWindows: 0, errors: [] },
        collectors: [],
      } satisfies InitialIngestionResponse);
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<ImportProgress token="token" billingConnected={false} />);
      await Promise.resolve();
    });
    expect(progressRequests).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(progressRequests).toBe(2);
  });

  it("polls an active import every five seconds", async () => {
    vi.useFakeTimers();
    let progressRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ ok: true });
      progressRequests += 1;
      return Response.json({
        job: { id: "job", status: "running", startedAt: 1, updatedAt: 2 },
        days: { total: 90, complete: 0, pending: 90, gaps: 0, failedWindows: 0, errors: [] },
        collectors: [collector(100, 1)],
      } satisfies InitialIngestionResponse);
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<ImportProgress token="token" billingConnected={false} />);
      await Promise.resolve();
    });
    expect(progressRequests).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(progressRequests).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(progressRequests).toBe(2);
  });
});

function collector(totalUnits: number, completeUnits: number, failedUnits = 0) {
  return {
    collector: "graphql:test",
    label: "Test",
    total: 1,
    complete: completeUnits > 0 ? 1 : 0,
    failed: failedUnits > 0 ? 1 : 0,
    pending: completeUnits + failedUnits < totalUnits ? 1 : 0,
    totalUnits,
    completeUnits,
    failedUnits,
    oldestCompleteAt: completeUnits > 0 ? 1 : null,
    errors: failedUnits > 0 ? ["coverage gap"] : [],
  };
}

async function render(props: Parameters<typeof ImportProgressView>[0]): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ImportProgressView {...props} />);
  });
  return container;
}
