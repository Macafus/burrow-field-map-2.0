const CACHE_NAME = "burrow-manager-offline-v8";
const APP_SHELL = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  "/burrow-field-map-tab-icon-20260915-v2.ico",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(precacheUrls(APP_SHELL));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/offline.html"));
    return;
  }

  if (isAppAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});

function isAppAsset(url) {
  return (
    url.pathname.startsWith("/_next/") ||
    url.pathname.startsWith("/assets/") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".webmanifest")
  );
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return fetchAndCache(request);
}

async function networkFirst(request, fallbackUrl = "/") {
  try {
    return await fetchAndCache(request);
  } catch {
    return (await caches.match(request)) ?? (await caches.match("/")) ?? (await caches.match(fallbackUrl));
  }
}

async function fetchAndCache(request) {
  const response = await fetch(request);
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
  }
  return response;
}

async function precacheUrls(urls) {
  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(urls.map((url) => cache.add(url)));
}
