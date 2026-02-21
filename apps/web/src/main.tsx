import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SetupWizard from "./SetupWizard";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SetupWizard />} />
        <Route path="/setup" element={<SetupWizard />} />
        <Route path="/dashboard" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
