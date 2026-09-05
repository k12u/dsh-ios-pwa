import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { decodeEvent, decodeHello, eventSchema, snapshotSchema, type MobileEvent } from "@dsh-mobile/protocol";
import { initialState, mergeEvents, projectConversation, reducer } from "../web/src/state/store";
import { normalizeEvent, normalizeTasks } from "../gateway/src/adapters/harness-events";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Markdown, safeLink } from "../web/src/components/Markdown";
const raw = [
  { type: "step/start", seq: 1, time: 1, data: { turn: 1, step: 1 } },
  { type: "assistant/chunk", seq: 2, time: 2, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "Hello " } } },
  { type: "assistant/chunk", seq: 3, time: 3, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "world" } } },
  { type: "assistant/message", seq: 4, time: 4, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "Hello world" }] } } },
];
const events = raw.flatMap(e => normalizeEvent("s1", e));
test("raw Harness events are normalized rather than forwarded into the Mobile Protocol", () => {
  const input = { ...raw[1], internalPipeline: { secret: "internal" }, data: { ...raw[1].data, rawRpc: { namespace: "internal" } } };
  assert.equal(decodeEvent(input), undefined);
  const [normalized] = normalizeEvent("s1", input);
  assert.equal(normalized.kind, "message.delta");
  assert.deepEqual(Object.keys(normalized).sort(), ["id", "sessionId", "seq", "time", "revision", "kind", "messageId", "text"].sort());
  assert.doesNotMatch(JSON.stringify(normalized), /internalPipeline|rawRpc|assistant\/chunk/);
  assert.deepEqual(normalizeEvent("s1", { type: "future/internal", seq: 90, time: 90, data: input.data }), []);
});
test("history/realtime overlap, out of order pages and completion have one canonical message", () => {
  const merged = mergeEvents([events[2], events[1]], [events[3], events[0], ...events]);
  assert.equal(merged.length, 4);
  const view = projectConversation(merged);
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].text, "Hello world");
  assert.equal(view.messages[0].complete, true);
});
test("unknown event kinds and additive fields are forward compatible", () => {
  assert.equal(decodeEvent({ kind: "future.event" }), undefined);
  assert.equal(decodeEvent({ ...events[1], nextField: "ignored" })?.kind, "message.delta");
  assert.equal("nextField" in decodeEvent({ ...events[1], nextField: "ignored" })!, false);
  assert.equal(decodeEvent({ ...events[1], seq: "bad" }), undefined);
  assert.equal(decodeHello({ kind: "hello", protocol: 2, minSupportedProtocol: 1, gatewayVersion: "next", capabilities: ["future-capability"] }).protocol, 2);
  assert.throws(() => decodeHello({ kind: "hello", protocol: 2, minSupportedProtocol: 2, gatewayVersion: "next", capabilities: [] }), /update/);
});
test("snapshot drops stale pending state; old request cannot reopen resolved approval", () => {
  const approval = { id: "a1", sessionId: "s1", toolName: "shell", reason: "Review", state: "pending" };
  const requested = eventSchema.parse({ kind: "attention.approval", id: "request", sessionId: "s1", seq: 1, time: 1, revision: 10, approval });
  const resolved = eventSchema.parse({ kind: "attention.resolved", id: "resolved", sessionId: "s1", seq: 2, time: 2, revision: 11, target: "approval", attentionId: "a1", state: "rejected" });
  let state = reducer(initialState(), { type: "events", events: [requested, resolved, requested] });
  assert.equal(state.approvals.a1.state, "rejected");
  state = reducer(state, { type: "snapshot", value: snapshotSchema.parse({ kind: "snapshot", revision: 20, host: { id: "h", name: "Host", status: "online" }, sessions: [], workspaces: [], tasks: [], approvals: [], questions: [] }) });
  state = reducer(state, { type: "events", events: [requested] });
  assert.equal(Object.keys(state.approvals).length, 0);
});
test("older history status cannot override authoritative reconnect status", () => {
  let state = initialState();
  state.sessions.s1 = { id: "s1", title: "Session", status: "idle", updatedAt: 20 }; state.revision = 20;
  state = reducer(state, { type: "events", events: [eventSchema.parse({ kind: "session.updated", id: "old", sessionId: "s1", seq: 1, time: 1, revision: 0, status: "running" })] });
  assert.equal(state.sessions.s1.status, "idle");
});
test("cancellation closes partial output without inventing successful tool results", () => {
  const stopped = eventSchema.parse({ kind: "session.updated", id: "stop", sessionId: "s1", seq: 5, time: 5, status: "idle" });
  const tool = eventSchema.parse({ kind: "tool.updated", id: "tool", sessionId: "s1", seq: 4, time: 4, toolId: "t", name: "Test", status: "running" });
  const view = projectConversation([...events.slice(0, 3), tool, stopped]);
  assert.equal(view.messages[0].complete, true); assert.equal(view.messages[0].text, "Hello world");
  assert.equal(view.tools[0].status, "unknown");
});
test("task projection understands nested upstream goals", () => {
  const tasks = normalizeTasks("s1", { todos: [{ content: "Inspect", status: "completed" }], goal: { goal: { id: "g", objective: "Ship", phase: "active" } } });
  assert.equal(tasks[0].title, "Ship"); assert.equal(tasks[0].status, "running"); assert.equal(tasks[1].status, "completed");
});
test("CommonMark/GFM rendering never interprets raw HTML or executable links", () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: '# Title\n\n**Bold**\n\n<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n| A | B |\n|---|---|\n| 1 | 2 |' }));
  assert.match(html, /<strong>.*Bold.*<\/strong>/); assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<script>|href="javascript:/); assert.match(html, /&lt;script&gt;/);
  for (const url of ["javascript:alert(1)", "data:text/html,x", "vbscript:evil"]) assert.equal(safeLink(url), undefined);
});
test("shared fixtures are accepted by the gateway encoder and browser decoder", () => {
  for (const file of readdirSync("packages/protocol/fixtures")) {
    const value = JSON.parse(readFileSync("packages/protocol/fixtures/" + file, "utf8"));
    if (value.kind === "hello") { decodeHello(value); continue; }
    if (value.kind === "future.event") { assert.equal(decodeEvent(value), undefined); continue; }
    const encoded = eventSchema.parse(value); assert.deepEqual(decodeEvent(JSON.parse(JSON.stringify(encoded))), encoded);
  }
});
