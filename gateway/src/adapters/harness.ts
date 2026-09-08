import { randomUUID } from "node:crypto";
import os from "node:os";
import { eventSchema, modelsSchema, presetsSchema, questionSchema, type ApprovalDTO, type ApprovalResponse, type Capability, type MobileEvent, type QuestionDTO, type QuestionResponse, type SelectModelInput, type SendPromptInput, type SetPresetInput, type TaskDTO } from "@dsh-mobile/protocol";
import { createDshHostAdapter } from "./upstream/dsh-host-adapter.mjs";
import { normalizeEvent, normalizeTasks } from "./harness-events";
import { GatewayError, type HarnessAdapter } from "../normalization/adapter";

// Structural boundary: no runtime package is imported or bundled.
export interface HarnessContext {
  webServer?: { port: number; register(route: { kind: string; path: string; handler: (req: any, res: any) => void }): () => void };
  typert?: { local?: { get(endpoint: string): unknown } };
  typertGateway: { invoke(call: any): Promise<any>; stream(call: any): Promise<AsyncIterable<any>> };
  on(name: string, handler: (...args: any[]) => any, options?: any): () => void;
  effect(handler: () => () => void): void;
}
type Pending<T> = { value: T; resolve: (v: any) => void; reject: (e: unknown) => void; cleanup: () => void; next: () => any };
export class DshAdapter implements HarnessAdapter {
  private api;
  private listeners = new Set<(e: MobileEvent) => void>();
  private approvals = new Map<string, Pending<ApprovalDTO>>();
  private questions = new Map<string, Pending<QuestionDTO>>();
  private tasks = new Map<string, TaskDTO>();
  private disposers: (() => void)[] = [];
  private abort = new AbortController();
  private counter = 0;
  private enabled = new Set<Capability>(["sessions", "streaming", "approvals", "questions", "cancel", "steer", "images", "workspaces", "tasks", "models", "presets"]);
  constructor(private ctx: HarnessContext, private shouldHandle: (sessionId: string) => boolean = () => true) {
    this.api = createDshHostAdapter(ctx.typertGateway);
    this.disposers.push(ctx.on("session/event", (session, event) => {
      for (const e of normalizeEvent(String(session.id), event)) this.emit(e);
    }));
    this.disposers.push(ctx.on("approval/request", (request, next) => {
      if (!request.agent?.id || typeof request.toolName !== "string") return next();
      if (request.signal?.aborted) return next();
      // Never claim exclusive control without a live mobile audience for this
      // session. Falling through to next() leaves the host's own handler
      // (CLI/Web UI) visible instead of stranding the request on an offline phone.
      if (!this.shouldHandle(String(request.agent.id))) return next();
      const value: ApprovalDTO = { id: randomUUID(), sessionId: String(request.agent.id), toolName: request.toolName, reason: request.reason ?? "This operation needs your permission.", state: "pending" };
      return new Promise((resolve, reject) => {
        const abort = () => this.resolveApproval(value.id, "cancelled");
        request.signal?.addEventListener("abort", abort, { once: true });
        this.approvals.set(value.id, { value, resolve, reject, next, cleanup: () => request.signal?.removeEventListener("abort", abort) });
        this.control(value.sessionId, { kind: "attention.approval", approval: value });
      });
    }, { prepend: true }));
    this.disposers.push(ctx.on("user-questions/request", (request, next) => {
      if (!request.agent?.id || !Array.isArray(request.questions) || request.signal?.aborted) return next();
      if (!this.shouldHandle(String(request.agent.id))) return next();
      const parsed = questionSchema.safeParse({ id: randomUUID(), sessionId: String(request.agent.id), state: "pending", fields: request.questions.map((q: any) => ({
        id: q.id, title: q.question, detail: q.detail, multiple: q.multiSelect === true,
        options: (q.options ?? []).map((o: any) => ({ id: o.label, label: o.label, description: o.description })),
      })) });
      if (!parsed.success) return next();
      const value = parsed.data;
      return new Promise((resolve, reject) => {
        const abort = () => this.resolveQuestion(value.id, undefined);
        request.signal?.addEventListener("abort", abort, { once: true });
        this.questions.set(value.id, { value, resolve, reject, next, cleanup: () => request.signal?.removeEventListener("abort", abort) });
        this.control(value.sessionId, { kind: "attention.question", question: value });
      });
    }, { prepend: true }));
    void this.followControl();
  }
  capabilities() {
    const catalog = this.ctx.typert?.local;
    if (typeof catalog?.get !== "function") return [...this.enabled];
    // Strict descriptor presence takes priority over version strings.
    const requires: Partial<Record<Capability, string[]>> = { sessions: ["session/list", "session/create", "session/prompt"], streaming: ["session/follow"], workspaces: ["workspace/follow"], images: ["session/attachment", "session/prompt"], cancel: ["session/cancel"], steer: ["session/prompt"], tasks: ["session/control"], models: ["session/modelCatalog", "session/selectModel"], presets: ["agentPresets/list"] };
    return [...this.enabled].filter(cap => !requires[cap] || requires[cap]!.every(endpoint => catalog.get(endpoint) !== undefined));
  }
  private emit(event: MobileEvent) { for (const listener of this.listeners) listener(event); }
  private control(sessionId: string, value: any) {
    this.emit(eventSchema.parse({ ...value, id: randomUUID(), sessionId, seq: ++this.counter, time: Date.now(), revision: 0 }));
  }
  private async followControl() {
    while (!this.abort.signal.aborted) {
      try {
        for await (const frame of await this.api.openControlStream(this.abort.signal)) {
          this.enabled.add("tasks");
          const blocks = frame.type === "baseline" ? Object.entries(frame.value?.projections ?? {}) : frame.type === "projection" ? [[frame.sessionId, { values: { [frame.key]: frame.value } }]] : [];
          for (const [sessionId, block] of blocks as [string, any][]) {
            const normalized = normalizeTasks(sessionId, block.values);
            for (const task of this.tasks.values()) {
              const affected = frame.type === "baseline" || (frame.key === "todos" && task.id.includes(":todo:")) || (frame.key === "goal" && task.id.includes(":goal:"));
              if (task.sessionId === sessionId && affected && !normalized.some(t => t.id === task.id)) {
                this.tasks.delete(task.id);
                this.control(sessionId, { kind: "task.removed", taskId: task.id });
              }
            }
            for (const task of normalized) {
              const changed = JSON.stringify(this.tasks.get(task.id)) !== JSON.stringify(task);
              this.tasks.set(task.id, task);
              if (changed) this.control(sessionId, { kind: "task.updated", task });
            }
          }
        }
      } catch { this.enabled.delete("tasks"); }
      if (this.abort.signal.aborted) break;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 5000); this.abort.signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  async snapshot() {
    const [sessions, workspaces] = await Promise.all([
      this.api.sessions.list({}, AbortSignal.timeout(12_000)),
      this.api.workspace.list({}, AbortSignal.timeout(12_000)).then(value => { this.enabled.add("workspaces"); return value; }).catch(() => { this.enabled.delete("workspaces"); return { items: [] }; }),
    ]);
    const ws = workspaces.items ?? [];
    return {
      host: { id: "local", name: os.hostname(), status: "online", adapter: "DeepSeek Harness" },
      workspaces: ws.map((w: any) => ({ id: String(w.workspaceId), title: String(w.title ?? w.path), path: String(w.path) })),
      sessions: (sessions.items ?? []).map((s: any) => ({
        id: String(s.sessionId), title: String(s.projections?.values?.title || s.title || "Untitled session"),
        workspaceId: ws.find((w: any) => w.sessionIds?.includes(s.sessionId) || w.path === s.cwd)?.workspaceId,
        updatedAt: s.updatedAt ?? 0, status: s.running ? "running" : "idle",
      })),
      tasks: [...this.tasks.values()], approvals: [...this.approvals.values()].map(p => p.value), questions: [...this.questions.values()].map(p => p.value),
    };
  }
  async history(sessionId: string, cursor?: string) {
    if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new GatewayError(400, "invalid-cursor", "Invalid history cursor");
    const page = await this.api.sessions.history({ sessionId, maxMessages: 40, ...(cursor === undefined ? {} : { beforeSeq: Number(cursor) }) }, AbortSignal.timeout(20_000));
    const raw = page.events.map((r: any) => r.event);
    const events = raw.flatMap((r: any) => normalizeEvent(sessionId, r));
    const before = raw.length ? Math.min(...raw.map((r: any) => r.seq)) : undefined;
    return { sessionId, events, ...(page.hasMore && before !== undefined ? { cursor: String(before) } : {}) };
  }
  async createSession(workspaceId?: string) { const result = await this.api.sessions.create(workspaceId ? { workspaceId } : {}, AbortSignal.timeout(20_000)); return { sessionId: String(result.sessionId) }; }
  async sendPrompt(input: SendPromptInput) {
    await this.api.sessions.prompt({ sessionId: input.sessionId, requestId: input.requestId, mode: input.mode,
      content: [...(input.text ? [{ type: "text", text: input.text }] : []), ...input.images.map(i => ({ type: "image", ...i }))] }, AbortSignal.timeout(20_000));
  }
  async cancelSession(sessionId: string) {
    try { await this.ctx.typertGateway.invoke({ namespace: "session", method: "cancel", args: { request: { sessionId } }, signal: AbortSignal.timeout(20_000) }); }
    catch (e: any) { if (/not.found|unknown|unsupported/i.test(String(e.code))) this.enabled.delete("cancel"); throw e; }
  }
  async attachment(sessionId: string, id: string) {
    const result = await this.api.sessions.attachment({ sessionId, attachmentId: id }, AbortSignal.timeout(20_000));
    return { metadata: { id, name: result.attachment.name ?? "Image", mediaType: result.attachment.mediaType, bytes: result.attachment.bytes }, data: Buffer.from(result.data, "base64") };
  }
  async models(sessionId: string) {
    let catalog: any;
    try { catalog = await this.api.sessions.models({ sessionId }, AbortSignal.timeout(20_000)); }
    catch (e: any) { if (/not.found|unknown|unsupported/i.test(String(e?.code))) this.enabled.delete("models"); throw e; }
    const current = catalog?.current && typeof catalog.current.provider === "string" && typeof catalog.current.model === "string"
      ? { provider: catalog.current.provider, model: catalog.current.model } : null;
    const rawGroups: any[] = Array.isArray(catalog?.groups) ? catalog.groups : [];
    const groups = rawGroups.map((group: any) => {
      const rawModels: any[] = Array.isArray(group?.models) ? group.models : [];
      const options = rawModels.map((m: any) => ({ id: String(m?.id ?? ""), name: String(m?.name ?? m?.id ?? "") })).filter((m: { id: string }) => m.id);
      return { id: String(group?.id ?? ""), name: String(group?.name ?? group?.id ?? ""), models: options };
    }).filter((group: { id: string; models: unknown[] }) => group.id && group.models.length > 0);
    return modelsSchema.parse({ sessionId, current, routable: catalog?.routable === true, groups });
  }
  async selectModel(input: SelectModelInput) {
    const payload: Record<string, unknown> = { sessionId: input.sessionId, provider: input.provider, model: input.model };
    try {
      try {
        // Preserve or default the reasoning effort the way the host's own picker does.
        const catalog = await this.api.sessions.models({ sessionId: input.sessionId }, AbortSignal.timeout(20_000));
        const group = (catalog?.groups ?? []).find((g: any) => g?.id === input.provider);
        const model = (group?.models ?? []).find((m: any) => m?.id === input.model);
        const effort = catalog?.current?.provider === input.provider && catalog?.current?.model === input.model
          ? catalog?.current?.reasoningEffort : model?.reasoning?.defaultEffort;
        if (typeof effort === "string" && effort) payload.reasoningEffort = effort;
      } catch { /* Selection works without an effort hint. */ }
      await this.api.sessions.selectModel(payload, AbortSignal.timeout(20_000));
    } catch (e: any) { if (/not.found|unknown|unsupported/i.test(String(e?.code))) this.enabled.delete("models"); throw e; }
  }
  async presets() {
    let roster: any;
    try { roster = await this.api.agentPresets.list({}, AbortSignal.timeout(20_000)); }
    catch (e: any) { if (/not.found|unknown|unsupported/i.test(String(e?.code))) this.enabled.delete("presets"); throw e; }
    const raw: any[] = Array.isArray(roster?.presets) ? roster.presets : [];
    const presets = raw.map((p: any) => ({
      id: String(p?.id ?? ""),
      name: String(p?.name ?? p?.label ?? p?.title ?? "") || String(p?.id ?? ""),
      ...(typeof p?.description === "string" && p.description ? { description: p.description } : {}),
      default: p?.isDefault === true,
    })).filter((p: { id: string }) => p.id);
    return presetsSchema.parse({ presets });
  }
  async selectPreset(input: SetPresetInput) {
    try {
      // The host keeps the agent-preset default in its own settings namespace.
      await this.api.settings.update({ ns: "agent-presets", patch: { default: input.presetId } }, AbortSignal.timeout(20_000));
    } catch (e: any) { if (/not.found|unknown|unsupported/i.test(String(e?.code))) this.enabled.delete("presets"); throw e; }
  }
  async respondApproval(input: ApprovalResponse) {
    const p = this.approvals.get(input.id);
    if (!p || p.value.sessionId !== input.sessionId) throw new GatewayError(409, "not-pending", "This approval has already been resolved.");
    this.resolveApproval(input.id, input.outcome);
  }
  private resolveApproval(id: string, state: string) {
    const p = this.approvals.get(id); if (!p) return;
    this.approvals.delete(id); p.cleanup(); p.resolve(state);
    this.control(p.value.sessionId, { kind: "attention.resolved", target: "approval", attentionId: id, state });
  }
  async respondQuestion(input: QuestionResponse) {
    const p = this.questions.get(input.id);
    if (!p || p.value.sessionId !== input.sessionId) throw new GatewayError(409, "not-pending", "This question has already been resolved.");
    if (input.answers.length !== p.value.fields.length) throw new GatewayError(400, "bad-answer", "Answer every question.");
    p.value.fields.forEach((q, i) => {
      const a = input.answers[i];
      if (a.id !== q.id || new Set(a.selected).size !== a.selected.length || a.selected.some(id => !q.options.some(o => o.id === id)) || (!q.multiple && (a.selected.length > 1 || (a.custom && a.selected.length))) || (!a.selected.length && !a.custom)) throw new GatewayError(400, "bad-answer", "Invalid question selection.");
    });
    this.resolveQuestion(input.id, { answers: input.answers });
  }
  private resolveQuestion(id: string, answer: unknown) {
    const p = this.questions.get(id); if (!p) return;
    this.questions.delete(id); p.cleanup();
    if (answer) p.resolve(answer); else p.reject(Object.assign(new Error("Question cancelled"), { code: "ASK_ABORTED" }));
    this.control(p.value.sessionId, { kind: "attention.resolved", target: "question", attentionId: id, state: answer ? "answered" : "cancelled" });
  }
  subscribe(callback: (e: MobileEvent) => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  setInteractionAudience(fn: (sessionId: string) => boolean) {
    this.shouldHandle = fn;
    this.refreshAccess();
  }
  refreshAccess(sessionId?: string) {
    for (const [id, pending] of this.approvals) {
      if (sessionId !== undefined && pending.value.sessionId !== sessionId) continue;
      if (this.shouldHandle(pending.value.sessionId)) continue;
      this.approvals.delete(id); pending.cleanup();
      this.control(pending.value.sessionId, { kind: "attention.resolved", target: "approval", attentionId: id, state: "cancelled" });
      Promise.resolve().then(pending.next).then(pending.resolve, pending.reject);
    }
    for (const [id, pending] of this.questions) {
      if (sessionId !== undefined && pending.value.sessionId !== sessionId) continue;
      if (this.shouldHandle(pending.value.sessionId)) continue;
      this.questions.delete(id); pending.cleanup();
      this.control(pending.value.sessionId, { kind: "attention.resolved", target: "question", attentionId: id, state: "cancelled" });
      Promise.resolve().then(pending.next).then(pending.resolve, pending.reject);
    }
  }
  dispose() {
    this.abort.abort(); this.disposers.forEach(d => d());
    for (const p of [...this.approvals.values(), ...this.questions.values()]) { p.cleanup(); Promise.resolve().then(p.next).then(p.resolve, p.reject); }
    this.approvals.clear(); this.questions.clear(); this.listeners.clear();
  }
}
