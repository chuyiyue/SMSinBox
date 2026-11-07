// Shell cache. Bump the version when the precache list changes so activate
// drops the previous cache. Content images (flags, sender logos) are not
// part of the shell; a later GET still fills them via stale-while-revalidate.
const CACHE = "smsinbox-shell-v1";

const PRECACHE = [
  "/style.css",
  "/css/base.css",
  "/css/components.css",
  "/css/pages.css",
  "/css/shell.css",
  "/css/tokens.css",
  "/api-client.js",
  "/api-mcp.js",
  "/common.js",
  "/device-detail.js",
  "/device-panel.js",
  "/device-store.js",
  "/devices.js",
  "/i18n.js",
  "/inbox.js",
  "/login.js",
  "/notify.js",
  "/pwa.js",
  "/registry.js",
  "/shell.js",
  "/sidebar-boot.js",
  "/theme-boot.js",
  "/totp-settings.js",
  "/ui.js",
  "/users.js",
  "/vendor/qrcode.mjs",
  "/logo.png",
  "/logo-full.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icons.svg",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // /api/ always goes to the network and is never written to the cache.
  if (url.pathname.startsWith("/api/")) return;

  // Don't pin the worker script itself; the browser updates it by byte check.
  if (url.pathname === "/sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  // Static assets: stale-while-revalidate. A cached copy is returned at
  // once, and a background fetch replaces it. The first request waits
  // for the network because there is nothing cached yet.
  event.respondWith(staleWhileRevalidate(event, request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    await storeIfOk(request, response);
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

// waitUntil is called synchronously, before the first await, so the
// background refresh stays alive after a cached response is returned.
function staleWhileRevalidate(event, request) {
  const refresh = refreshStatic(request);
  event.waitUntil(refresh.then(() => undefined));
  return caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await refresh;
    if (response) return response;
    throw new Error("offline");
  });
}

function refreshStatic(request) {
  return fetch(request)
    .then(async (response) => {
      await storeIfOk(request, response);
      return response;
    })
    .catch(() => null);
}

async function storeIfOk(request, response) {
  // Redirected responses cannot be stored; ignore the write rather than
  // failing the request that produced them.
  if (!response || !response.ok || response.type !== "basic" || response.redirected) return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  } catch {
    // A failed cache write must not fail the page.
  }
}
