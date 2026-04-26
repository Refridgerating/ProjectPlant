import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthShell } from "./AuthShell";
import { initSettings } from "./settings";
import "./styles/index.css";

async function bootstrap() {
  await initSettings().catch(() => undefined);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <BrowserRouter>
        <AuthShell />
      </BrowserRouter>
    </React.StrictMode>
  );
}

void bootstrap();
