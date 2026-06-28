// App-shell service worker. Its one job: when a page navigation can't reach the
// origin — a redeploy gap or the device dropping offline — serve the cached
// /offline.html instead of the browser's (or Cloudflare's) raw error. This is
// the deployment-agnostic answer to "Bad gateway during update": the worker
// lives in the user's browser, so it doesn't care what proxy fronts the origin.
//
// Bump CACHE when offline.html changes so clients re-precache it.
const CACHE = "unclaw-shell-v2";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.add(new Request(OFFLINE_URL, { cache: "reload" })))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Only page loads get the fallback. Assets and API calls pass straight
  // through — caching those is the (separate, larger) full-offline feature.
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
