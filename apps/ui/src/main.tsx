import React from "react";
import ReactDOM from "react-dom/client";
import { AuthShell } from "./AuthShell";
import "./styles/index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AuthShell />
  </React.StrictMode>
);
