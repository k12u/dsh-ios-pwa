import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import WebSocket from "ws";
import { DemoAdapter } from "../gateway/src/adapters/demo";
import { Registry } from "../gateway/src/auth/registry";
import { createGateway } from "../gateway/src/server";
import { decodeEvent } from "@dsh-mobile/protocol";
import { mergeEvents, projectConversation } from "../web/src/state/store";
const origin = "http://localhost:8789", registry = new Registry(), adapter = new DemoAdapter();
const app = createGateway(adapter, { origin, registry, staticDir: resolve("web/dist") });
const sockets: WebSocket[] = [];
try {
  app.server.listen(8789, "127.0.0.1"); await once(app.server, "listening");
  const request = async (path: string, body?: unknown, cookie?: string) => fetch("http://127.0.0.1:8789" + path, { method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const paired = await request("/api/pair", { token: registry.createPairing().token, name: "CI browser" });
  assert.equal(paired.status, 200); const cookie = paired.headers.get("set-cookie")!.split(";")[0];
  function connect() {
    const frames: any[] = [];
    const ws = new WebSocket("ws://127.0.0.1:8789/ws/mobile", { headers: { Origin: origin, Cookie: cookie } }); sockets.push(ws);
    ws.on("message", data => frames.push(JSON.parse(data.toString())));
    const wait = async (predicate: (frame: any) => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!frames.some(predicate)) { if (Date.now() > deadline) throw new Error("Expected WebSocket frame did not arrive"); await new Promise(r => setTimeout(r, 20)); }
      return frames.find(predicate);
    };
    return { ws, frames, wait };
  }
  const first = connect(); await first.wait(f => f.kind === "snapshot");
  assert.equal((await request("/api/approval", { id: "approval-1", sessionId: "review", outcome: "allowed-once" }, cookie)).status, 200);
  await first.wait(f => f.kind === "attention.resolved");
  const promptId = crypto.randomUUID();
  assert.equal((await request("/api/prompt", { requestId: promptId, sessionId: "welcome", text: "Smoke", mode: "queue", images: [] }, cookie)).status, 200);
  await first.wait(f => f.kind === "message.delta");
  first.ws.close(); await once(first.ws, "close");
  const next = connect(); const snapshot = await next.wait(f => f.kind === "snapshot");
  assert.equal(snapshot.approvals.find((a: any) => a.id === "approval-1")?.state, "allowed-once");
  await next.wait(f => f.kind === "message.completed" && f.role === "assistant");
  const history: any = await (await request("/api/sessions/welcome/history", undefined, cookie)).json();
  const events = next.frames.flatMap(f => { const e = decodeEvent(f); return e ? [e] : []; });
  const projection = projectConversation(mergeEvents(history.events, events));
  assert.equal(projection.messages.filter(m => m.id === promptId).length, 1);
  assert.ok(projection.messages.at(-1)?.text.endsWith("real tasks."));
  console.log("TCP HTTP/WebSocket pairing, streaming, reconnect, history merge and approval smoke passed.");
} finally { for (const ws of sockets) ws.terminate(); await app.close(); }
