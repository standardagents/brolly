import App from "./App";
import { LimitsChartPreview } from "./limits-chart-preview";

export function ClientRoot({ pathname = location.pathname }: { pathname?: string }) {
  return pathname === "/__limits-chart-preview" ? <LimitsChartPreview /> : <App />;
}
