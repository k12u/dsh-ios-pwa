import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable, Duplex } from "node:stream";
import * as WebSockets from "ws";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createGateway } from "../gateway/src/server";
import { Registry } from "../gateway/src/auth/registry";
import { DemoAdapter } from "../gateway/src/adapters/demo";
class Response extends Writable {
  statusCode = 200; headers: Record<string, any> = {}; headersSent = false; chunks: Buffer[] = [];
  setHeader(key: string, value: unknown) { this.headers[key.toLowerCase()] = value; }
  writeHead(code: number, headers: Record<string, unknown>) { this.statusCode = code; this.headersSent = true; for (const [k, v] of Object.entries(headers)) this.setHeader(k, v); }
  _write(chunk: Buffer, _encoding: string, next: () => void) { this.chunks.push(Buffer.from(chunk)); next(); }
  get text() { return Buffer.concat(this.chunks).toString(); }
}
function harness() {
  const registry = new Registry(), adapter = new DemoAdapter();
  const app = createGateway(adapter, { registry, origin: "https://mobile.example", staticDir: resolve("web/dist") });
  async function request(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
    const req = Readable.from(options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]);
    Object.assign(req, { method: options.method ?? (options.body === undefined ? "GET" : "POST"), url: path, headers: { "content-type": "application/json", origin: options.origin ?? "https://mobile.example", cookie: options.cookie }, socket: { remoteAddress: "127.0.0.1" } });
    const response = new Response();
    const done = new Promise<Response>((resolve, reject) => { response.on("finish", () => resolve(response)); response.on("error", reject); });
    app.server.emit("request", req, response);
    return done;
  }
  async function pair() {
    const token = registry.createPairing().token;
    const response = await request("/api/pair", { body: { token, name: "Test browser" } });
    return response;
  }
  return { registry, adapter, app, request, pair };
}
test("HTTP pairing uses secure HttpOnly cookie; CSRF is enforced on every mutation", async () => {
  const h = harness();
  try {
    const paired = await h.pair(); assert.equal(paired.statusCode, 200);
    const cookie = paired.headers["set-cookie"];
    for (const value of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/", "__Host-dsh="]) assert.ok(cookie.includes(value));
    assert.ok(!paired.text.includes("credential"));
    assert.equal((await h.request("/api/snapshot")).statusCode, 401);
    assert.equal((await h.request("/api/snapshot", { cookie })).statusCode, 200);
    assert.equal((await h.request("/api/sessions", { cookie, origin: "https://evil.example", body: {} })).statusCode, 403);
    assert.equal((await h.request("/api/sessions", { cookie, origin: "", body: {} })).statusCode, 403);
    assert.equal((await h.request("/api/pair", { origin: "https://evil.example", body: { token: h.registry.createPairing().token } })).statusCode, 403);
    const created = await h.request("/api/sessions", { cookie, body: {} }); assert.equal(created.statusCode, 200); assert.ok(JSON.parse(created.text).sessionId);
  } finally { await h.app.close(); }
});
test("a paired device can issue one-time links for additional devices", async () => {
  const h = harness();
  try {
    assert.equal((await h.request("/api/pairing", { body: {} })).statusCode, 401);
    const cookie = (await h.pair()).headers["set-cookie"];
    const issued = await h.request("/api/pairing", { cookie, body: {} }); assert.equal(issued.statusCode, 200);
    const { url, expiresAt } = JSON.parse(issued.text);
    assert.ok(url.startsWith("https://mobile.example/pair?t="));
    assert.ok(expiresAt > Date.now());
    const token = new URL(url).searchParams.get("t");
    const added = await h.request("/api/pair", { body: { token, name: "Second device" } }); assert.equal(added.statusCode, 200);
    const second = added.headers["set-cookie"];
    assert.notEqual(second, cookie);
    assert.equal((await h.request("/api/snapshot", { cookie: second })).statusCode, 200);
    assert.equal((await h.request("/api/pair", { body: { token, name: "Reuse" } })).statusCode, 401);
  } finally { await h.app.close(); }
});
test("model catalog is session-scoped, selection is validated and capability-gated", async () => {
  const h = harness();
  try {
    const cookie = (await h.pair()).headers["set-cookie"];
    assert.equal((await h.request("/api/sessions/welcome/models")).statusCode, 401);
    const catalog = JSON.parse((await h.request("/api/sessions/welcome/models", { cookie })).text);
    assert.equal(catalog.sessionId, "welcome");
    assert.ok(catalog.current.provider && catalog.current.model);
    assert.ok(catalog.routable);
    assert.ok(catalog.groups.every((g: any) => g.id && g.name && g.models.length > 0));
    assert.equal((await h.request("/api/model", { cookie, body: { sessionId: "welcome", provider: "missing", model: "missing" } })).statusCode, 400);
    assert.equal((await h.request("/api/model", { cookie, body: { sessionId: "nope", provider: catalog.current.provider, model: catalog.current.model } })).statusCode, 404);
    assert.equal((await h.request("/api/model", { cookie, origin: "https://evil.example", body: { sessionId: "welcome", provider: catalog.groups[0].id, model: catalog.groups[0].models[0].id } })).statusCode, 403);
    assert.equal((await h.request("/api/model", { cookie, body: { sessionId: "welcome", provider: catalog.groups[0].id, model: catalog.groups[0].models[0].id } })).statusCode, 200);
    const after = JSON.parse((await h.request("/api/sessions/welcome/models", { cookie })).text);
    assert.equal(after.current.model, catalog.groups[0].models[0].id);
    const gated = h.adapter.capabilities.bind(h.adapter);
    h.adapter.capabilities = () => gated().filter((c: any) => c !== "models");
    assert.equal((await h.request("/api/sessions/welcome/models", { cookie })).statusCode, 409);
    assert.equal((await h.request("/api/model", { cookie, body: { sessionId: "welcome", provider: catalog.groups[0].id, model: catalog.groups[0].models[0].id } })).statusCode, 409);
  } finally { await h.app.close(); }
});
test("prompt retries are idempotent; changed body cannot reuse an ID", async () => {
  const h = harness();
  try {
    const cookie = (await h.pair()).headers["set-cookie"];
    const input = { sessionId: "welcome", requestId: "f56338bc-3cf6-46f1-b81c-074b20e48a96", text: "Hello", mode: "queue", images: [] };
    const [first, second] = await Promise.all([h.request("/api/prompt", { cookie, body: input }), h.request("/api/prompt", { cookie, body: input })]);
    assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200);
    const history = JSON.parse((await h.request("/api/sessions/welcome/history", { cookie })).text);
    assert.equal(history.events.filter((e: any) => e.messageId === input.requestId).length, 1);
    assert.equal((await h.request("/api/prompt", { cookie, body: { ...input, text: "Changed" } })).statusCode, 409);
    assert.equal((await h.request("/api/cancel", { cookie, body: { sessionId: "welcome" } })).statusCode, 200);
  } finally { await h.app.close(); }
});
test("HTTP output strips accidental adapter internals before reaching the client", async () => {
  const h = harness();
  try {
    const cookie = (await h.pair()).headers["set-cookie"];
    const history = h.adapter.history.bind(h.adapter);
    h.adapter.history = async (sessionId, cursor) => {
      const page = await history(sessionId, cursor);
      return { ...page, internalPipeline: { private: true }, events: page.events.map(event => ({ ...event, raw: { type: "assistant/chunk" }, turn: 99 })) };
    };
    const snapshot = h.adapter.snapshot.bind(h.adapter);
    h.adapter.snapshot = async () => {
      const state = await snapshot();
      return { ...state, internalPipeline: {}, sessions: state.sessions.map(session => ({ ...session, projections: { private: true } })) };
    };
    h.adapter.createSession = async () => ({ sessionId: "f56338bc-3cf6-46f1-b81c-074b20e48a96", internalPipeline: { private: true } });
    for (const response of [
      await h.request("/api/sessions/welcome/history", { cookie }),
      await h.request("/api/snapshot", { cookie }),
      await h.request("/api/sessions", { cookie, body: {} }),
    ]) {
      assert.equal(response.statusCode, 200);
      assert.doesNotMatch(response.text, /internalPipeline|projections|assistant\/chunk|"raw"|"turn"/);
    }
  } finally { await h.app.close(); }
});
test("approval is authoritative, first responder wins, revocation is immediate", async () => {
  const h = harness();
  try {
    const cookie = (await h.pair()).headers["set-cookie"];
    const body = { id: "approval-1", sessionId: "review", outcome: "allowed-once" };
    assert.equal((await h.request("/api/approval", { cookie, body: { ...body, sessionId: "welcome" } })).statusCode, 409);
    assert.equal((await h.request("/api/approval", { cookie, body })).statusCode, 200);
    assert.equal((await h.request("/api/approval", { cookie, body })).statusCode, 409);
    const devices = JSON.parse((await h.request("/api/devices", { cookie })).text);
    assert.equal((await h.request("/api/revoke", { cookie, body: { id: devices.current } })).statusCode, 200);
    assert.equal((await h.request("/api/snapshot", { cookie })).statusCode, 401);
  } finally { await h.app.close(); }
});
test("static shell serves deep links and denies traversal, raw RPC and disabled push", async () => {
  const h = harness();
  try {
    const shell = await h.request("/session/opaque");
    assert.equal(shell.statusCode, 200); assert.match(shell.text, /DSH Mobile/);
    assert.equal((await h.request("/%2e%2e%2fpackage.json")).statusCode, 404);
    assert.equal((await h.request("/assets/nonexistent.js")).statusCode, 404);
    const cookie = (await h.pair()).headers["set-cookie"];
    assert.equal((await h.request("/api/remote", { cookie, body: { namespace: "session" } })).statusCode, 404);
    assert.equal((await h.request("/push/key", { cookie })).statusCode, 409);
    assert.equal(shell.headers["referrer-policy"], "no-referrer");
    assert.match(shell.headers["content-security-policy"], /frame-ancestors 'none'/);
  } finally { await h.app.close(); }
});
test("WebSocket upgrades reject cross-origin and unauthenticated handshakes before opening a socket", async () => {
  const h = harness();
  try {
    let output = "";
    const socket = { end(value: string) { output = value; } };
    h.app.server.emit("upgrade", { url: "/ws/mobile", headers: { origin: "https://evil.example" } }, socket, Buffer.alloc(0));
    assert.match(output, /403/);
    h.app.server.emit("upgrade", { url: "/ws/mobile", headers: { origin: "https://mobile.example" } }, socket, Buffer.alloc(0));
    assert.match(output, /401/);
  } finally { await h.app.close(); }
});
test("real WebSocket framing buffers concurrent events until the authoritative snapshot is sent", async () => {
  const h = harness();
  const frames: any[] = [];
  const Receiver = (WebSockets as unknown as { Receiver: new (options: { isServer: boolean }) => Writable }).Receiver;
  const receiver = new Receiver({ isServer: false });
  receiver.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString())));
  class MemorySocket extends Duplex {
    handshake = "";
    _read() {}
    _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
      if (!this.handshake) { this.handshake = chunk.toString(); callback(); }
      else receiver.write(chunk, callback);
    }
  }
  const socket = new MemorySocket();
  try {
    const cookie = (await h.pair()).headers["set-cookie"];
    const original = h.adapter.snapshot.bind(h.adapter);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    h.adapter.snapshot = async () => { await gate; return original(); };
    h.app.server.emit("upgrade", { method: "GET", url: "/ws/mobile", headers: {
      origin: "https://mobile.example", cookie, upgrade: "websocket",
      "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13",
    } }, socket, Buffer.alloc(0));
    await h.adapter.respondApproval({ id: "approval-1", sessionId: "review", outcome: "rejected" });
    assert.equal(frames.some(f => f.kind === "attention.resolved"), false);
    release();
    await new Promise(r => setTimeout(r, 10));
    assert.match(socket.handshake, /101 Switching Protocols/);
    const index = frames.findIndex(f => f.kind === "snapshot");
    assert.ok(index >= 0);
    assert.ok(frames.findIndex(f => f.kind === "attention.resolved") > index);
    assert.equal(frames[index].approvals.find((a: any) => a.id === "approval-1").state, "rejected");
  } finally { socket.destroy(); receiver.destroy(); await h.app.close(); }
});
