import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { PROTOCOL, GATEWAY_VERSION, approvalResponseSchema, createdSessionSchema, createSessionSchema, eventSchema, historyPageSchema, modelsSchema, pairingSchema, promptSchema, pushSubscriptionSchema, questionResponseSchema, selectModelSchema, snapshotSchema, type MobileEvent } from "@dsh-mobile/protocol";
import { Registry, RateLimiter, hash } from "./auth/registry";
import { GatewayError, type HarnessAdapter } from "./normalization/adapter";
import { PushService, validatePushEndpoint } from "./push/web-push";

export interface ServerOptions { origin: string; staticDir: string; registry: Registry; push?: PushService }
export function createGateway(adapter: HarnessAdapter, options: ServerOptions) {
  const origin = new URL(options.origin).origin;
  const secure = origin.startsWith("https:");
  if (!secure && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) throw new Error("HTTPS is required outside localhost");
  const cookieName = secure ? "__Host-dsh" : "dsh_dev";
  const cookie = (value: string, maxAge = 2592000) => cookieName + "=" + value + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + maxAge + (secure ? "; Secure" : "");
  const pairLimit = new RateLimiter(10), requestLimit = new RateLimiter(180);
  const clients = new Map<any, { deviceId: string; buffered?: MobileEvent[] }>();
  const requests = new Map<string, { digest: string; promise: Promise<void>; until: number }>();
  let revision = 0;
  const caps = () => [...adapter.capabilities(), ...(options.push ? ["push"] : [])];
  const authenticate = (req: IncomingMessage) => {
    const credential = (req.headers.cookie ?? "").split(";").map(s => s.trim()).find(s => s.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
    const device = options.registry.authenticate(credential);
    if (!device) throw new GatewayError(401, "unauthorized", "Pair this browser to continue.");
    return device;
  };
  const checkOrigin = (req: IncomingMessage) => { if (req.headers.origin !== origin) throw new GatewayError(403, "origin", "Request origin rejected"); };
  const requireCapability = (cap: string) => { if (!caps().includes(cap)) throw new GatewayError(409, "unsupported", "This host does not support that feature."); };
  const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  async function body(req: IncomingMessage) {
    if (!req.headers["content-type"]?.startsWith("application/json")) throw new GatewayError(415, "content-type", "JSON is required");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 21_000_000) throw new GatewayError(413, "too-large", "Request exceeds the upload limit"); chunks.push(Buffer.from(chunk)); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new GatewayError(400, "invalid-json", "Invalid JSON"); }
  }
  async function snapshot() {
    // Subscribe before reading, then replay every event since the beginning
    // of the snapshot. Overlap is safe; missing a concurrent resolution is not.
    const cut = revision;
    const value = await adapter.snapshot();
    return snapshotSchema.parse({ ...value, kind: "snapshot", revision: cut });
  }
  const server = http.createServer((req, res) => { void handle(req, res).catch(error => {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof z.ZodError) json(res, { code: "validation", message: "Invalid request fields" }, 400);
    else if (error instanceof GatewayError) json(res, { code: error.code, message: error.message }, error.status);
    else json(res, { code: "unavailable", message: "The host could not complete this request." }, 503);
  }); });
  server.on("error", error => console.error("[mobile-pwa] Listener unavailable:", error.message));
  server.requestTimeout = 30_000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const url = new URL(req.url ?? "/", origin);
    const path = url.pathname;
    if (!["GET", "HEAD"].includes(req.method ?? "")) checkOrigin(req);
    if (req.method === "POST" && path === "/api/pair") {
      pairLimit.check(req.socket.remoteAddress ?? "unknown");
      const input = pairingSchema.parse(await body(req));
      const result = options.registry.pair(input.token, input.name);
      res.setHeader("Set-Cookie", cookie(result.credential));
      json(res, { device: { id: result.device.id, name: result.device.name } }); return;
    }
    if (path === "/version.json" && req.method === "GET") { json(res, { protocol: PROTOCOL, version: GATEWAY_VERSION }); return; }
    if (path.startsWith("/api/") || path.startsWith("/push/")) {
      const device = authenticate(req);
      requestLimit.check(device.id);
      if (req.method === "GET" && path === "/api/snapshot") { json(res, await snapshot()); return; }
      if (req.method === "GET" && path === "/api/devices") { json(res, { current: device.id, devices: options.registry.list() }); return; }
      if (req.method === "POST" && path === "/api/pairing") { pairLimit.check(device.id); const pair = options.registry.createPairing(); json(res, { url: origin + "/pair?t=" + pair.token, expiresAt: pair.expiresAt }); return; }
      if (req.method === "POST" && path === "/api/revoke") {
        const { id } = z.object({ id: z.string().uuid() }).parse(await body(req));
        options.registry.revoke(id);
        adapter.refreshAccess?.();
        for (const [ws, client] of clients) if (client.deviceId === id) ws.close(4001, "Revoked");
        if (id === device.id) res.setHeader("Set-Cookie", cookie("", 0));
        json(res, { accepted: true }); return;
      }
      const historyMatch = path.match(/^\/api\/sessions\/([^/]+)\/history$/);
      if (req.method === "GET" && historyMatch) { json(res, historyPageSchema.parse(await adapter.history(decodeURIComponent(historyMatch[1]), url.searchParams.get("cursor") ?? undefined))); return; }
      const modelsMatch = path.match(/^\/api\/sessions\/([^/]+)\/models$/);
      if (req.method === "GET" && modelsMatch) { requireCapability("models"); json(res, modelsSchema.parse(await adapter.models(decodeURIComponent(modelsMatch[1])))); return; }
      if (req.method === "POST" && path === "/api/model") { requireCapability("models"); await adapter.selectModel(selectModelSchema.parse(await body(req))); json(res, { accepted: true }); return; }
      const imageMatch = path.match(/^\/api\/sessions\/([^/]+)\/images\/([^/]+)$/);
      if (req.method === "GET" && imageMatch) {
        requireCapability("images");
        const image = await adapter.attachment(decodeURIComponent(imageMatch[1]), decodeURIComponent(imageMatch[2]));
        if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.metadata.mediaType)) throw new GatewayError(415, "image-type", "Unsupported image");
        res.writeHead(200, { "Content-Type": image.metadata.mediaType, "Content-Length": image.data.length, "Cache-Control": "no-store", "X-Content-SHA256": createHash("sha256").update(image.data).digest("hex") }); res.end(image.data); return;
      }
      if (req.method === "POST" && path === "/api/sessions") { requireCapability("sessions"); json(res, createdSessionSchema.parse(await adapter.createSession(createSessionSchema.parse(await body(req)).workspaceId))); return; }
      if (req.method === "POST" && path === "/api/prompt") {
        const input = promptSchema.parse(await body(req));
        requireCapability("sessions"); if (input.mode === "steer") requireCapability("steer"); if (input.images.length) requireCapability("images");
        for (const [key, value] of requests) if (value.until < Date.now()) requests.delete(key);
        const key = device.id + ":" + input.requestId;
        const digest = hash(JSON.stringify(input));
        let record = requests.get(key);
        if (record && record.digest !== digest) throw new GatewayError(409, "request-conflict", "This request ID was already used.");
        if (!record) {
          if (requests.size > 10_000) throw new GatewayError(429, "busy", "Try again shortly.");
          record = { digest, promise: adapter.sendPrompt(input), until: Date.now() + 86400_000 }; requests.set(key, record);
        }
        await record.promise; json(res, { accepted: true }); return;
      }
      if (req.method === "POST" && path === "/api/cancel") { requireCapability("cancel"); const input = z.object({ sessionId: z.string().min(1).max(256) }).parse(await body(req)); await adapter.cancelSession(input.sessionId); json(res, { accepted: true }); return; }
      if (req.method === "POST" && path === "/api/approval") { requireCapability("approvals"); await adapter.respondApproval(approvalResponseSchema.parse(await body(req))); json(res, { accepted: true }); return; }
      if (req.method === "POST" && path === "/api/question") { requireCapability("questions"); await adapter.respondQuestion(questionResponseSchema.parse(await body(req))); json(res, { accepted: true }); return; }
      if (req.method === "GET" && path === "/push/key") { requireCapability("push"); json(res, { key: options.push!.publicKey }); return; }
      if (req.method === "POST" && path === "/push/subscription") {
        requireCapability("push");
        const subscription = pushSubscriptionSchema.parse(await body(req));
        try { validatePushEndpoint(subscription.endpoint); } catch { throw new GatewayError(400, "push-provider", "Unsupported push provider"); }
        options.registry.subscribe(device.id, subscription); json(res, { accepted: true }); return;
      }
      if (req.method === "DELETE" && path === "/push/subscription") { options.registry.subscribe(device.id); json(res, { accepted: true }); return; }
      throw new GatewayError(404, "not-found", "Not found");
    }
    if (path.startsWith("/ws/") || !["GET", "HEAD"].includes(req.method ?? "")) throw new GatewayError(404, "not-found", "Not found");
    const root = await realpath(options.staticDir);
    const appRoute = path === "/" || path === "/pair" || /^\/(session|approval|question)\/[^/]+$/.test(path);
    let target = resolve(root, appRoute ? "index.html" : "." + decodeURIComponent(path));
    try { target = await realpath(target); } catch { throw new GatewayError(404, "not-found", "Not found"); }
    if (!target.startsWith(root + sep) || !(await stat(target)).isFile()) throw new GatewayError(404, "not-found", "Not found");
    const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream", "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" });
    res.end(req.method === "HEAD" ? undefined : await readFile(target));
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on("upgrade", (req, socket, head) => {
    try {
      if (new URL(req.url ?? "/", origin).pathname !== "/ws/mobile") throw new GatewayError(404, "not-found", "Not found");
      checkOrigin(req); const device = authenticate(req); requestLimit.check(device.id);
      if (clients.size >= 100) throw new GatewayError(503, "busy", "Connection limit");
      wss.handleUpgrade(req, socket, head, (ws: any) => {
        const client = { deviceId: device.id, buffered: [] as MobileEvent[] | undefined }; clients.set(ws, client);
        ws.on("error", () => ws.terminate()); ws.on("close", () => clients.delete(ws));
        ws.on("message", () => ws.close(1008, "Use authenticated HTTP for requests"));
        ws.send(JSON.stringify({ kind: "hello", protocol: PROTOCOL, minSupportedProtocol: PROTOCOL, gatewayVersion: GATEWAY_VERSION, capabilities: caps() }));
        void snapshot().then(value => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ kind: "hello", protocol: PROTOCOL, minSupportedProtocol: PROTOCOL, gatewayVersion: GATEWAY_VERSION, capabilities: caps() }));
          ws.send(JSON.stringify(value));
          for (const event of client.buffered ?? []) ws.send(JSON.stringify(event));
          client.buffered = undefined;
        }).catch(() => ws.close(1013, "Host unavailable"));
      });
    } catch (error) { const status = error instanceof GatewayError ? error.status : 400; socket.end("HTTP/1.1 " + status + " Rejected\r\nConnection: close\r\n\r\n"); }
  });
  const unsubscribe = adapter.subscribe(normalized => {
    const event = eventSchema.parse({ ...normalized, revision: ++revision });
    for (const [ws, client] of clients) {
      if (!options.registry.active(client.deviceId)) { ws.close(4001, "Expired"); continue; }
      if (client.buffered) { client.buffered.push(event); if (client.buffered.length > 2000) ws.close(1013, "Resync required"); }
      else if (ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 4_000_000) ws.close(1013, "Slow client");
        else ws.send(JSON.stringify(event));
      }
    }
    void options.push?.notify(event);
  });
  const heartbeat = setInterval(() => {
    adapter.refreshAccess?.();
    for (const [ws, client] of clients) {
      if (!options.registry.active(client.deviceId) || ws.waitingPong) { ws.terminate(); continue; }
      ws.waitingPong = true; ws.once("pong", () => { ws.waitingPong = false; }); ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  return { server, async close() { clearInterval(heartbeat); unsubscribe(); for (const ws of clients.keys()) ws.terminate(); wss.close(); adapter.dispose(); await new Promise<void>(r => server.close(() => r())); } };
}
