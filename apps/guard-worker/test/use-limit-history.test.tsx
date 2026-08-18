// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useLimitHistory } from "../src/client/components/limits-chart/use-limit-history";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function Harness() {
  const history = useLimitHistory({ value: 0 });
  return (
    <div>
      <button type="button" data-action="a" onClick={() => history.record({ value: 1 })}>Record A</button>
      <button type="button" data-action="b" onClick={() => history.record({ value: 2 })}>Record B</button>
      <button type="button" data-action="c" onClick={() => history.record({ value: 3 })}>Record C</button>
      <button type="button" data-action="undo" disabled={!history.canUndo} onClick={() => history.undo()}>Undo</button>
      <button type="button" data-action="redo" disabled={!history.canRedo} onClick={() => history.redo()}>Redo</button>
      <output>{JSON.stringify({ canUndo: history.canUndo, canRedo: history.canRedo })}</output>
    </div>
  );
}

describe("useLimitHistory", () => {
  it("walks a committed timeline and drops redo entries after a new record", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Harness />); });
    const button = (action: string) => container.querySelector(`button[data-action="${action}"]`) as HTMLButtonElement;

    await act(async () => { button("a").click(); });
    await act(async () => { button("b").click(); });
    expect(button("undo").disabled).toBe(false);
    expect(button("redo").disabled).toBe(true);

    await act(async () => { button("undo").click(); });
    expect(button("undo").disabled).toBe(false);
    expect(button("redo").disabled).toBe(false);
    await act(async () => { button("redo").click(); });
    expect(button("redo").disabled).toBe(true);

    await act(async () => { button("undo").click(); });
    await act(async () => { button("c").click(); });
    expect(button("redo").disabled).toBe(true);
  });
});

