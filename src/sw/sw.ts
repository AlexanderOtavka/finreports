/// <reference lib="webworker" />
/**
 * The service worker: the app's shell (index.html and every built file) comes from a cache, so
 * the app opens at once, and opens with no network at all. The data is not cached here: the
 * page keeps its own copy (src/web/store.ts) and refreshes it from the API in the background.
 *
 * The build (vite.config.ts) replaces the manifest below with this build's files and a hash of
 * them, so every build is a new sw.js: the browser installs it next to the old one, it caches
 * the new files, takes over, and drops the old cache. The page that is open keeps running the
 * build it started with; the next launch opens the new one.
 */
export {};
declare const self: ServiceWorkerGlobalScope;

const BUILD: { version: string; files: string[] } = JSON.parse("__SW_MANIFEST__");
const SCOPE = "/reports/";
const CACHE = `shell-${BUILD.version}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // index.html is cached under the URL navigations ask for.
      await cache.addAll([SCOPE, ...BUILD.files.filter((f) => f !== "index.html").map((f) => SCOPE + f)]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // The app itself, whatever the report, range and drill path in its query string. Login,
  // the API and health go to the network as before.
  if (req.mode === "navigate" && (url.pathname === SCOPE || url.pathname === `${SCOPE}index.html`)) {
    event.respondWith(fromCache(SCOPE, req));
  } else if (BUILD.files.some((f) => url.pathname === SCOPE + f)) {
    event.respondWith(fromCache(url.pathname, req));
  }
});

async function fromCache(key: string, req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  return (await cache.match(key)) ?? fetch(req);
}
