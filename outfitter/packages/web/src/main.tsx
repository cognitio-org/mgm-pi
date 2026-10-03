import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { installChunkReload } from "./lib/chunk-reload.ts";
import { initSentry } from "./lib/sentry.ts";

// Reads the fleet settings and starts Sentry only if an operator turned it on (lib/sentry.ts). Not
// awaited: the app renders at once.
void initSentry();
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
