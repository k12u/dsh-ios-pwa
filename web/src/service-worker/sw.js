// Replaced at build time. Only the static, public shell enters Cache API.
const VERSION = "__BUILD_ID__";
const CACHE = "dsh-shell-" + VERSION;
const ASSETS = __ASSETS__;
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(["/", ...ASSETS])));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("dsh-shell-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", event => { if (event.data === "ACTIVATE") self.skipWaiting(); });
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/push/") || url.pathname.startsWith("/ws/") || url.pathname === "/version.json" || url.pathname === "/pair") return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      if (response.ok && url.pathname === "/") event.waitUntil(caches.open(CACHE).then(cache => cache.put("/", response.clone())));
      return response;
    }).catch(() => caches.match("/").then(response => response || Response.error())));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch {}
  const allowed = ["Approval required", "An answer is needed", "Task completed", "Task failed", "Agent waiting"];
  const title = allowed.includes(data.title) ? data.title : "Your agent needs attention";
  const url = typeof data.url === "string" && /^\/session\/[^/?#]+$/.test(data.url) ? data.url : "/";
  event.waitUntil(self.registration.showNotification(title, { body: "Open DSH Mobile to see the details.", icon: "/icon-192.png", badge: "/icon-192.png", tag: typeof data.tag === "string" ? data.tag.slice(0, 256) : "attention", data: { url } }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const path = event.notification.data?.url;
  const url = new URL(typeof path === "string" && /^\/session\/[^/?#]+$/.test(path) ? path : "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
    for (const client of clients) if (new URL(client.url).origin === self.location.origin) { await client.navigate(url); return client.focus(); }
    return self.clients.openWindow(url);
  }));
});
