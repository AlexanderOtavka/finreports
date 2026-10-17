import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { registerServiceWorker } from "./sw-client.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The app's files from a cache, so it opens at once and offline (src/sw/sw.ts). Not under
// `npm run dev`, whose files change with every edit.
if (import.meta.env.PROD) registerServiceWorker();
