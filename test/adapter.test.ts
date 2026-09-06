import assert from "node:assert/strict";
import { test } from "node:test";
import { DshAdapter } from "../gateway/src/adapters/harness";
function fakeContext() {
  const listeners = new Map<string, (...args: any[]) => any>(), calls: any[] = [];
  const context = {
    typertGateway: {
      async invoke(call: any) {
        calls.push(call);
        if (call.namespace === "agentPresets" && call.method === "list") return {
          presets: [{ id: "creator", trust: "system", isDefault: false }, { id: "standard", name: "Standard", trust: "system", isDefault: true }],
          authorable: true, hasDocument: false,
        };
        if (call.method === "list") return { items: [{ sessionId: "s1", title: "Session", running: false, updatedAt: 1 }] };
        if (call.method === "create") return { sessionId: "s2" };
        if (call.method === "modelCatalog") return {
          default: { provider: "deepseek", model: "chat", reasoningEffort: "high" },
          routableProviders: ["deepseek"],
          groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "chat", name: "Chat" }, { id: "reasoner", name: "Reasoner", reasoning: { efforts: [{ id: "low", name: "Low" }], defaultEffort: "low" } }] }],
          failures: [],
        };
        if (call.method === "selectModel") return { selected: call.args.request };
        return { accepted: true };
      },
      async stream(call: any) {
        calls.push(call);
        return (async function* () {
          if (call.namespace === "workspace") { yield { type: "baseline", value: { items: [{ workspaceId: "w1", title: "Work", path: "/work", sessionIds: ["s1"] }] } }; return; }
          if (call.method === "follow") {
            yield { type: "snapshot", cursor: 2, records: [{ type: "event", event: { type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "Hello" }] } } }], hasMore: false, projections: { asOfSeq: 2, values: {} } }; return;
          }
          yield { type: "baseline", value: { projections: {} } };
          if (!call.signal.aborted) await new Promise<void>(r => call.signal.addEventListener("abort", () => r(), { once: true }));
        })();
      },
    },
    on(name: string, handler: (...args: any[]) => any) { listeners.set(name, handler); return () => { listeners.delete(name); }; },
    effect() {},
  };
  return { context, listeners, calls };
}
test("adapter translates domain calls to verified RC.1 endpoint shapes", async () => {
  const h = fakeContext(), adapter = new DshAdapter(h.context);
  try {
    const snapshot = await adapter.snapshot(); assert.equal(snapshot.sessions[0].workspaceId, "w1");
    assert.deepEqual(h.calls.find(c => c.method === "list").args, { _request: {} });
    assert.equal((await adapter.history("s1")).events[0].kind, "message.completed");
    await adapter.sendPrompt({ sessionId: "s1", requestId: "request-id", text: "Hello", mode: "steer", images: [] });
    assert.deepEqual(h.calls.find(c => c.method === "prompt").args.request, { sessionId: "s1", requestId: "request-id", mode: "steer", content: [{ type: "text", text: "Hello" }] });
    await adapter.cancelSession("s1"); assert.deepEqual(h.calls.find(c => c.method === "cancel").args, { request: { sessionId: "s1" } });
  } finally { adapter.dispose(); }
});
test("model catalog maps upstream selection state into the mobile DTO and preserves reasoning effort", async () => {
  const h = fakeContext(), adapter = new DshAdapter(h.context);
  try {
    assert.equal(adapter.capabilities().includes("models"), true);
    const catalog = await adapter.models("s1");
    assert.deepEqual(catalog, { sessionId: "s1", current: { provider: "deepseek", model: "chat" }, routable: true, groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "chat", name: "Chat" }, { id: "reasoner", name: "Reasoner" }] }] });
    await adapter.selectModel({ sessionId: "s1", provider: "deepseek", model: "chat" });
    assert.deepEqual(h.calls.find(c => c.method === "selectModel").args.request, { sessionId: "s1", provider: "deepseek", model: "chat", reasoningEffort: "high" });
    await adapter.selectModel({ sessionId: "s1", provider: "deepseek", model: "reasoner" });
    assert.deepEqual(h.calls.find(c => c.method === "selectModel" && c.args.request.model === "reasoner").args.request, { sessionId: "s1", provider: "deepseek", model: "reasoner", reasoningEffort: "low" });
  } finally { adapter.dispose(); }
});
test("model endpoints unsupported by the host retire the models capability", async () => {
  const h = fakeContext();
  const invoke = h.context.typertGateway.invoke.bind(h.context.typertGateway);
  h.context.typertGateway.invoke = async (call: any) => { if (call.method === "modelCatalog") throw { code: "unknown-method" }; return invoke(call); };
  const adapter = new DshAdapter(h.context);
  try {
    await assert.rejects(adapter.models("s1"));
    assert.equal(adapter.capabilities().includes("models"), false);
  } finally { adapter.dispose(); }
});
test("agent preset roster maps to the mobile DTO and the default switch targets the host settings namespace", async () => {
  const h = fakeContext(), adapter = new DshAdapter(h.context);
  try {
    assert.equal(adapter.capabilities().includes("presets"), true);
    assert.deepEqual(await adapter.presets(), { presets: [
      { id: "creator", name: "creator", default: false },
      { id: "standard", name: "Standard", default: true },
    ] });
    await adapter.selectPreset({ presetId: "minimal" });
    const update = h.calls.find(c => c.namespace === "settings" && c.method === "update");
    assert.deepEqual(update.args, { ns: "agent-presets", patch: { default: "minimal" } });
  } finally { adapter.dispose(); }
});
test("preset endpoints unsupported by the host retire the presets capability", async () => {
  const h = fakeContext();
  const invoke = h.context.typertGateway.invoke.bind(h.context.typertGateway);
  h.context.typertGateway.invoke = async (call: any) => { if (call.namespace === "agentPresets") throw { code: "unknown-method" }; return invoke(call); };
  const adapter = new DshAdapter(h.context);
  try {
    await assert.rejects(adapter.presets());
    assert.equal(adapter.capabilities().includes("presets"), false);
  } finally { adapter.dispose(); }
});
test("HITL question validation and resolved broadcast preserve deterministic decisions", async () => {
  const h = fakeContext(), adapter = new DshAdapter(h.context), events: any[] = [];
  adapter.subscribe(e => events.push(e));
  try {
    const result = h.listeners.get("user-questions/request")!({ agent: { id: "s1" }, questions: [{ id: "q", question: "Which?", options: [{ label: "A" }, { label: "B" }] }] }, () => "fallback");
    const question = (await adapter.snapshot()).questions[0];
    await assert.rejects(adapter.respondQuestion({ id: question.id, sessionId: "s1", answers: [{ id: "q", selected: ["A", "B"] }] }));
    await assert.rejects(adapter.respondQuestion({ id: question.id, sessionId: "s1", answers: [{ id: "q", selected: ["A"], custom: "X" }] }));
    await adapter.respondQuestion({ id: question.id, sessionId: "s1", answers: [{ id: "q", selected: ["A"] }] });
    assert.deepEqual(await result, { answers: [{ id: "q", selected: ["A"] }] });
    assert.equal(events.at(-1).kind, "attention.resolved");
    assert.equal((await adapter.snapshot()).questions.length, 0);
  } finally { adapter.dispose(); }
});
test("approval cancellation follows the authoritative abort signal", async () => {
  const h = fakeContext(), adapter = new DshAdapter(h.context), signal = new AbortController();
  try {
    const result = h.listeners.get("approval/request")!({ agent: { id: "s1" }, toolName: "shell", signal: signal.signal }, () => "fallback");
    const approval = (await adapter.snapshot()).approvals[0]; assert.equal(approval.state, "pending");
    signal.abort(); assert.equal(await result, "cancelled");
    await assert.rejects(adapter.respondApproval({ id: approval.id, sessionId: "s1", outcome: "allowed-once" }));
  } finally { adapter.dispose(); }
});
test("with no paired mobile device the host's own interaction handler is used", () => {
  const h = fakeContext(), adapter = new DshAdapter(h.context, () => false);
  try { assert.equal(h.listeners.get("approval/request")!({ agent: { id: "s1" }, toolName: "shell" }, () => "host"), "host"); }
  finally { adapter.dispose(); }
});
test("revoking the last device returns pending control to the host rather than leaving it stranded", async () => {
  let audience = true;
  const h = fakeContext(), adapter = new DshAdapter(h.context, () => audience), events: any[] = [];
  adapter.subscribe(e => events.push(e));
  try {
    const result = h.listeners.get("approval/request")!({ agent: { id: "s1" }, toolName: "shell" }, () => "rejected");
    audience = false; adapter.refreshAccess();
    assert.equal(await result, "rejected");
    assert.equal(events.at(-1).state, "cancelled");
    assert.equal((await adapter.snapshot()).approvals.length, 0);
  } finally { adapter.dispose(); }
});
