/* Service worker — this is what makes the app open with no signal.
 *
 * Strategy:
 *   app shell (html/js/css/icons)  -> cache first, refreshed in the background
 *   everything else (Supabase API) -> network only, never cached
 *
 * Registrations are NOT cached here. They live in IndexedDB, managed by
 * app.js, because they must survive far longer than any cache.
 */

const VERSION = "bvl-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // addAll fails the whole install if any single file 404s; individual
      // puts keep the app installable even if an icon is missing.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Never intercept API traffic — a cached registration response would be a lie.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((c) => c.put(request, copy));
          }
          return response;
        })
        .catch(() => cached || caches.match("./index.html"));

      // Cache first so the app opens instantly and offline; the network copy
      // updates the cache for next time.
      return cached || network;
    }),
  );
});
