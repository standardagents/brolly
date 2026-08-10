import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/pages.css";
import "./styles/wizard.css";
import "./styles/docs.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
