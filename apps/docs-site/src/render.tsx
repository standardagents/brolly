import { renderToString } from "react-dom/server";
import { App } from "./App.js";

export function render(): string {
  return renderToString(<App />);
}
