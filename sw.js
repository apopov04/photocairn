// Offline support. The app shell is cached on install; everything else
// (AI models, the WebAssembly runtime) is cached the first time it's used.
const VERSION = "photocairn-v21";
const SHELL = [
  "./", "index.html", "css/app.css", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png",
  "js/main.js", "js/editor.js", "js/ops.js", "js/tools.js", "js/paint.js", "js/psd.js", "js/menus.js", "js/metadata.js", "js/metadata-ui.js", "js/ui.js", "js/icons.js", "js/snap.js", "js/text.js", "js/history.js", "js/bg-worker.js", "js/api.js", "js/api-spec.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k.startsWith("photocairn-v") && k !== VERSION).map((k) => caches.delete(k)),
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Models are cached by the worker itself (photocairn-models-*).
  if (url.pathname.includes("/models/")) return;
  // Network first for the app shell so updates arrive; cache as fallback.
  e.respondWith(
    // Bypass the HTTP cache so app updates arrive on the next load.
    (e.request.mode === "navigate" ? fetch(e.request) : fetch(e.request, { cache: "no-cache" })).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
