import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { LimitsChartPreview } from "./limits-chart-preview";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(<StrictMode>{location.pathname === "/__limits-chart-preview" ? <LimitsChartPreview /> : <App />}</StrictMode>);
