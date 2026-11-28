import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { registerServiceWorker } from "./sw-client.js";
import "./styles.css";

// Opened from the Home Screen, the app has the bottom of the screen to itself, and its tabs go
// there (styles.css). In Safari the address bar floats there already, so they stay on top.
// iOS has said so in navigator.standalone since before it matched the display-mode query.
const standalone = window.matchMedia("(display-mode: standalone)");
const markStandalone = () => {
  const yes = standalone.matches || (navigator as { standalone?: boolean }).standalone === true;
  document.documentElement.toggleAttribute("data-standalone", yes);
};
markStandalone();
standalone.addEventListener("change", markStandalone);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The app's files from a cache, so it opens at once and offline (src/sw/sw.ts). Not under
// `npm run dev`, whose files change with every edit.
if (import.meta.env.PROD) registerServiceWorker();
