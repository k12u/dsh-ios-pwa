import { randomUUID } from "node:crypto";
import type { ApprovalResponse, Capability, MobileEvent, QuestionResponse, SendPromptInput, Snapshot } from "@dsh-mobile/protocol";
import { GatewayError, type HarnessAdapter } from "../normalization/adapter";
export class DemoAdapter implements HarnessAdapter {
  private listeners = new Set<(event: MobileEvent) => void>();
  private logs = new Map<string, MobileEvent[]>();
  private images = new Map<string, { metadata: any; data: Uint8Array; sessionId: string }>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private seq = 0;
  private state: Omit<Snapshot, "kind" | "revision"> = {
    host: { id: "demo", name: "Local preview", status: "online", adapter: "Demo · no agent runtime" },
    workspaces: [{ id: "workspace", title: "Mobile workspace", path: "~/projects/mobile" }],
    sessions: [
      { id: "welcome", workspaceId: "workspace", title: "Build a better mobile experience", status: "idle", updatedAt: Date.now() },
      { id: "review", workspaceId: "workspace", title: "Review the authentication flow", status: "waiting", updatedAt: Date.now() - 60_000 },
    ],
    tasks: [{ id: "task-1", sessionId: "welcome", title: "Create the mobile foundation", status: "completed", detail: "Protocol, gateway and app shell" }, { id: "task-2", sessionId: "review", title: "Review the authentication flow", status: "waiting", detail: "Your input is needed" }],
    approvals: [{ id: "approval-1", sessionId: "review", toolName: "apply_patch", reason: "Update the authentication middleware.", argumentsPreview: "src/auth.ts · add origin validation", state: "pending" }],
    questions: [{ id: "question-1", sessionId: "review", state: "pending", fields: [{ id: "next", title: "Which part should we review first?", multiple: false, options: [{ id: "pairing", label: "Pairing", description: "One-time links and device sessions" }, { id: "sync", label: "Reconnect", description: "History and realtime synchronization" }] }] }],
  };
  constructor() {
    this.emit("welcome", { kind: "message.completed", messageId: "welcome-user", role: "user", text: "Help me keep an eye on my agent from my phone.", images: [] });
    this.emit("welcome", { kind: "tool.updated", toolId: "inspect", name: "Inspect workspace", status: "completed", preview: "Reviewed the project structure." });
    this.emit("welcome", { kind: "message.completed", messageId: "welcome-agent", role: "assistant", text: "Your workspace is ready.\n\nUse **Inbox** for decisions that need your attention, **Tasks** to follow progress, and **Sessions** to continue a conversation.\n\nThis is a local preview. Messages stream here without calling an AI model.", images: [] });
  }
  capabilities(): Capability[] { return ["sessions", "workspaces", "streaming", "tasks", "approvals", "questions", "images", "cancel", "steer"]; }
  snapshot() { return Promise.resolve(structuredClone(this.state)); }
  history(sessionId: string, cursor?: string) {
    this.session(sessionId); const before = cursor === undefined ? Infinity : Number(cursor);
    const all = (this.logs.get(sessionId) ?? []).filter(e => e.seq < before);
    const events = all.slice(-40);
    return Promise.resolve({ sessionId, events, ...(all.length > 40 ? { cursor: String(events[0].seq) } : {}) });
  }
  private session(id: string) { const s = this.state.sessions.find(s => s.id === id); if (!s) throw new GatewayError(404, "session-not-found", "Session not found"); return s; }
  private emit(sessionId: string, value: any) {
    const seq = ++this.seq;
    const event: MobileEvent = { ...value, sessionId, id: sessionId + ":" + seq, seq, time: Date.now(), revision: 0 };
    this.logs.set(sessionId, [...(this.logs.get(sessionId) ?? []), event]);
    this.listeners.forEach(fn => fn(event));
  }
  async createSession(workspaceId?: string) {
    const id = randomUUID(); this.state.sessions.unshift({ id, workspaceId, title: "New session", status: "idle", updatedAt: Date.now() }); return { sessionId: id };
  }
  async sendPrompt(input: SendPromptInput) {
    const session = this.session(input.sessionId);
    if (this.timers.has(session.id)) {
      if (input.mode === "steer") await this.cancelSession(session.id);
      else throw new GatewayError(409, "busy", "The preview supports one prompt at a time. Use Steer or wait.");
    }
    const images = input.images.map(i => {
      const id = randomUUID(); const data = Buffer.from(i.data, "base64"); const metadata = { id, name: i.name, mediaType: i.mediaType, bytes: data.length };
      this.images.set(id, { metadata, data, sessionId: session.id }); return metadata;
    });
    this.emit(session.id, { kind: "message.completed", messageId: input.requestId, role: "user", text: input.text, images });
    session.title = session.title === "New session" ? input.text.slice(0, 60) || "Image conversation" : session.title;
    session.status = "running"; session.updatedAt = Date.now();
    this.emit(session.id, { kind: "session.updated", status: "running" });
    const messageId = randomUUID();
    const answer = "This is a streamed preview response. Your message reached the gateway and the conversation will survive a reconnect. Connect the Harness plugin to run real tasks.";
    this.emit(session.id, { kind: "message.started", messageId, role: "assistant", text: "", images: [] });
    let position = 0;
    this.timers.set(session.id, setInterval(() => {
      this.emit(session.id, { kind: "message.delta", messageId, text: answer.slice(position, position + 6) }); position += 6;
      if (position >= answer.length) {
        clearInterval(this.timers.get(session.id)); this.timers.delete(session.id);
        this.emit(session.id, { kind: "message.completed", messageId, role: "assistant", text: answer, images: [] });
        session.status = "idle"; this.emit(session.id, { kind: "session.updated", status: "idle" });
      }
    }, 65));
  }
  async cancelSession(sessionId: string) { this.session(sessionId).status = "idle"; clearInterval(this.timers.get(sessionId)); this.timers.delete(sessionId); this.emit(sessionId, { kind: "session.updated", status: "idle" }); }
  async respondApproval(input: ApprovalResponse) {
    const a = this.state.approvals.find(a => a.id === input.id && a.sessionId === input.sessionId && a.state === "pending");
    if (!a) throw new GatewayError(409, "not-pending", "Already resolved");
    a.state = input.outcome; this.emit(a.sessionId, { kind: "attention.resolved", attentionId: a.id, target: "approval", state: a.state });
  }
  async respondQuestion(input: QuestionResponse) {
    const q = this.state.questions.find(q => q.id === input.id && q.sessionId === input.sessionId && q.state === "pending");
    if (!q) throw new GatewayError(409, "not-pending", "Already resolved");
    q.state = "answered"; this.emit(q.sessionId, { kind: "attention.resolved", attentionId: q.id, target: "question", state: q.state });
  }
  async attachment(sessionId: string, id: string) { const image = this.images.get(id); if (!image || image.sessionId !== sessionId) throw new GatewayError(404, "image-not-found", "Image not found"); return image; }
  subscribe(fn: (e: MobileEvent) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  dispose() { this.timers.forEach(clearInterval); this.listeners.clear(); }
}
