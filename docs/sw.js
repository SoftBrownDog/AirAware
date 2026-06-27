/* AirAware service worker — offline-capable app shell.
 *
 * Strategy: cache-first for the static shell (so the app opens offline), and
 * always go to the network for live air-quality / geocoding APIs (never cache
 * readings — stale air data would be misleading). Bump CACHE on shell changes.
 */
const CACHE = "airaware-shell-v2";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Live data is never cached — always fetch fresh, fail honestly when offline.
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate for the shell: serve cache instantly for offline
  // speed, but always refresh it in the background so a new deploy is picked
  // up on the next visit without manual cache-busting.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((resp) => {
            if (resp && resp.ok) cache.put(request, resp.clone());
            return resp;
          })
          .catch(() => cached || cache.match("./index.html"));
        return cached || network;
      })
    )
  );
});
