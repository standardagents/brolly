import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ClientRoot } from "./ClientRoot";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(<StrictMode><ClientRoot /></StrictMode>);
