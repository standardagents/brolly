// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ImportProgressView } from "../src/client/onboarding/ingest.js";
import type { InitialIngestionResponse } from "../src/client/types.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("initial import progress", () => {
  it("renders capability planning before work units have been persisted", async () => {
    const container = await render({
      ingestion: { job: { id: "job", status: "planning", startedAt: 1, updatedAt: 1 }, collectors: [] },
      running: true,
      error: "",
      billingConnected: true,
    });

    expect(container.querySelector("[data-import-state='planning']")).not.toBeNull();
    expect(container.querySelectorAll("[role='progressbar']")).toHaveLength(0);
  });

  it("uses persisted dataset-days for processed, imported, unavailable, and remaining progress", async () => {
    const ingestion: InitialIngestionResponse = {
      job: { id: "job", status: "running", startedAt: 1, updatedAt: 2 },
      collectors: [
        collector("graphql:workers", 90, 32, 8, 1),
        collector("graphql:d1", 60, 30, 0, 1),
        collector("billing", 90, 31, 0, 2),
      ],
    };
    const container = await render({ ingestion, running: true, error: "", billingConnected: true });
    const progress = [...container.querySelectorAll<HTMLElement>("[role='progressbar']")];

    expect(container.querySelector("[data-import-state='importing']")).not.toBeNull();
    expect(progress).toHaveLength(2);
    expect(progress[0]?.getAttribute("aria-valuemax")).toBe("150");
    expect(progress[0]?.getAttribute("aria-valuenow")).toBe("70");
    expect(progress[0]?.dataset).toMatchObject({ importComplete: "62", importFailed: "8" });
    expect(progress[1]?.getAttribute("aria-valuemax")).toBe("90");
    expect(progress[1]?.getAttribute("aria-valuenow")).toBe("31");
    expect(progress[1]?.dataset).toMatchObject({ importComplete: "31", importFailed: "0" });
  });

  it("keeps terminal coverage gaps visible and hides a fully successful import", async () => {
    const withGap: InitialIngestionResponse = {
      job: { id: "job", status: "complete_with_gaps", startedAt: 1, updatedAt: 2 },
      collectors: [collector("graphql:workers", 90, 80, 10, 0)],
    };
    const container = await render({ ingestion: withGap, running: false, error: "", billingConnected: false });
    expect(container.querySelector("[data-import-state='complete_with_gaps']")).not.toBeNull();
    expect(container.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("90");

    await act(async () => {
      root!.render(<ImportProgressView
        ingestion={{ ...withGap, job: { ...withGap.job!, status: "complete" }, collectors: [collector("graphql:workers", 90, 90, 0, 0)] }}
        running={false}
        error=""
        billingConnected={false}
      />);
    });
    expect(container.children).toHaveLength(0);
  });
});

function collector(key: string, totalUnits: number, completeUnits: number, failedUnits: number, pending: number) {
  return {
    collector: key,
    label: key,
    total: 3,
    complete: completeUnits > 0 ? 1 : 0,
    failed: failedUnits > 0 ? 1 : 0,
    pending,
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
