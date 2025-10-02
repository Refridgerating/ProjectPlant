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
        <Route path="/" element={<App />} />
        <Route path="/setup" element={<SetupWizard />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
