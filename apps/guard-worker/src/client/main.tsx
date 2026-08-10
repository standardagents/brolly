import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./protection.css";
import "./budgets.css";
import "./tooltips.css";
import "./dashboard-enhancements.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
