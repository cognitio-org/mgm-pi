import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { installChunkReload } from "./lib/chunk-reload.ts";
import { initSentry } from "./lib/sentry.ts";

// Before anything else renders, so a crash during the very first render still reaches Sentry.
initSentry();
installChunkReload();

const el = document.getElementById("root");
if (!el) throw new Error("missing #root element");

createRoot(el).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
