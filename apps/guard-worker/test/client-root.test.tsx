// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/App", () => ({ default: () => <div>Dashboard</div> }));
vi.mock("../src/client/limits-chart-preview", () => ({ LimitsChartPreview: () => <div>Limits chart preview</div> }));

import { ClientRoot } from "../src/client/ClientRoot";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("ClientRoot", () => {
  it("renders the isolated chart preview at its internal route", async () => {
    await render(<ClientRoot pathname="/__limits-chart-preview" />);
    expect(document.body.textContent).toContain("Limits chart preview");
  });

  it("renders the application at other routes", async () => {
    await render(<ClientRoot pathname="/" />);
    expect(document.body.textContent).toContain("Dashboard");
  });
});

async function render(node: React.ReactNode): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}
