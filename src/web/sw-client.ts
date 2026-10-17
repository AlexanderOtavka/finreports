import { useSyncExternalStore } from "react";

/**
 * The page's side of the service worker (src/sw/sw.ts). A page opened by a worker runs the
 * build that worker cached; when a newer build's worker takes over, the page says so and
 * offers to reload into it.
 */
let updateReady = false;
const listeners = new Set<() => void>();

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  // Without a worker in charge yet, the first one taking over is this very build.
  const cached = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!cached || updateReady) return;
    updateReady = true;
    for (const l of listeners) l();
  });
  navigator.serviceWorker
    .register("/reports/sw.js", { scope: "/reports/" })
    .then((reg) => {
      // Browsers look for a new sw.js on a navigation; an installed app is mostly resumed, so
      // look again whenever it comes back to the front.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => undefined);
      });
    })
    .catch(() => undefined);
}

/** Whether a newer build is ready: a reload opens it. */
export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => updateReady,
  );
}
