import { useSyncExternalStore } from "react";
import type { Approval, AgentTask, Host, Message, Question, Session, ToolExecution, Workspace } from "@dsh-mobile/domain";
import type { Hello, MobileEvent, Snapshot } from "@dsh-mobile/protocol";
export interface AppState {
  connection: "connecting" | "online" | "offline" | "pairing" | "error";
  error?: string; hello?: Hello; host?: Host; revision: number; controlRevisions: Record<string, number>;
  sessions: Record<string, Session>; workspaces: Record<string, Workspace>;
  tasks: Record<string, AgentTask>; approvals: Record<string, Approval>; questions: Record<string, Question>;
  events: Record<string, MobileEvent[]>; cursors: Record<string, string | undefined>;
}
export const initialState = (): AppState => ({ connection: "connecting", revision: 0, controlRevisions: {}, sessions: {}, workspaces: {}, tasks: {}, approvals: {}, questions: {}, events: {}, cursors: {} });
const index = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map(i => [i.id, i]));
export type Action =
  | { type: "connection"; value: AppState["connection"]; error?: string }
  | { type: "hello"; value: Hello }
  | { type: "snapshot"; value: Snapshot }
  | { type: "events"; events: MobileEvent[] }
  | { type: "cursor"; sessionId: string; cursor?: string }
  | { type: "reset" };
export function mergeEvents(previous: MobileEvent[], incoming: MobileEvent[]): MobileEvent[] {
  // Sorting the ledger (instead of dropping seq <= high-watermark) also
  // accepts late history pages and deltas that arrived out of order.
  const events = new Map(previous.map(e => [e.id, e]));
  for (const e of incoming) if (!events.has(e.id)) events.set(e.id, e);
  return [...events.values()].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}
export function reducer(state: AppState, action: Action): AppState {
  if (action.type === "reset") return initialState();
  if (action.type === "connection") return { ...state, connection: action.value, error: action.error };
  if (action.type === "hello") return { ...state, hello: action.value };
  if (action.type === "cursor") return { ...state, cursors: { ...state.cursors, [action.sessionId]: action.cursor } };
  if (action.type === "snapshot") {
    const s = action.value;
    return { ...state, host: s.host, revision: s.revision, controlRevisions: {}, sessions: index(s.sessions), workspaces: index(s.workspaces), tasks: index(s.tasks), approvals: index(s.approvals), questions: index(s.questions) };
  }
  const next = { ...state, controlRevisions: { ...state.controlRevisions }, events: { ...state.events }, sessions: { ...state.sessions }, tasks: { ...state.tasks }, approvals: { ...state.approvals }, questions: { ...state.questions } };
  for (const event of action.events) {
    const previous = next.events[event.sessionId] ?? [];
    const isJournal = event.kind.startsWith("message.") || event.kind === "tool.updated" || event.kind.startsWith("session.");
    if (isJournal) {
      next.events[event.sessionId] = mergeEvents(previous, [event]);
      if (event.kind === "session.updated" && event.revision > state.revision && next.sessions[event.sessionId]) {
        const latest = next.events[event.sessionId].filter(e => e.kind === "session.updated").at(-1);
        if (latest?.kind === "session.updated") next.sessions[event.sessionId] = { ...next.sessions[event.sessionId], status: latest.status, updatedAt: latest.time };
      }
      if (event.kind === "session.renamed" && event.revision > state.revision && next.sessions[event.sessionId]) {
        const latest = next.events[event.sessionId].filter(e => e.kind === "session.renamed").at(-1);
        if (latest?.kind === "session.renamed") next.sessions[event.sessionId] = { ...next.sessions[event.sessionId], title: latest.title };
      }
      continue;
    }
    // An authoritative control snapshot clears stale pending interactions.
    if (event.revision <= state.revision) continue;
    const key = event.kind === "task.updated" ? event.task.id : event.kind === "task.removed" ? event.taskId : event.kind === "attention.approval" ? event.approval.id : event.kind === "attention.question" ? event.question.id : "attentionId" in event ? event.attentionId : event.id;
    if (event.revision <= (next.controlRevisions[key] ?? 0)) continue;
    next.controlRevisions[key] = event.revision;
    if (event.kind === "task.updated") next.tasks[event.task.id] = event.task;
    if (event.kind === "task.removed") delete next.tasks[event.taskId];
    if (event.kind === "attention.approval") next.approvals[event.approval.id] = event.approval;
    if (event.kind === "attention.question") next.questions[event.question.id] = event.question;
    if (event.kind === "attention.resolved") {
      const target = event.target === "approval" ? next.approvals : next.questions;
      if (target[event.attentionId]) target[event.attentionId] = { ...target[event.attentionId], state: event.state };
    }
  }
  return next;
}
let state = initialState();
const listeners = new Set<() => void>();
export const store = {
  get: () => state,
  dispatch(action: Action) { state = reducer(state, action); listeners.forEach(fn => fn()); },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export function useStore() { return useSyncExternalStore(store.subscribe, store.get, store.get); }
export function projectConversation(events: MobileEvent[]): { messages: Message[]; tools: ToolExecution[]; timeline: TimelineItem[] } {
  const messages = new Map<string, Message>(), tools = new Map<string, ToolExecution>();
  for (const e of events) {
    if (e.kind.startsWith("message.") && "messageId" in e) {
      const m = messages.get(e.messageId) ?? { id: e.messageId, sessionId: e.sessionId, role: "assistant" as const, text: "", images: [], complete: false, seq: e.seq, time: e.time };
      if (e.kind === "message.delta") { if (!m.complete) m.text += e.text; }
      else if (e.kind === "message.completed") { Object.assign(m, { role: e.role, text: e.text, images: e.images, complete: true }); }
      else if (e.kind === "message.started" && !m.complete) { m.role = e.role; }
      messages.set(m.id, m);
    }
    if (e.kind === "tool.updated") {
      const previous = tools.get(e.toolId);
      tools.set(e.toolId, { id: e.toolId, sessionId: e.sessionId, name: e.name || previous?.name || "Tool operation", status: e.status, preview: e.preview, seq: previous?.seq ?? e.seq, time: e.time });
    }
    if (e.kind === "session.updated" && ["idle", "failed"].includes(e.status)) {
      for (const m of messages.values()) m.complete = true;
      // A stopped turn ends the stream, but does not establish tool success.
      for (const tool of tools.values()) if (tool.status === "running") tool.status = "unknown";
    }
  }
  const keptMessages = [...messages.values()].filter(m => m.text || m.images.length || !m.complete);
  const keptTools = [...tools.values()];
  // Interleave messages and tools by their first seq, so the conversation can
  // be rendered in true chronological order instead of tools lumped at the end.
  const timeline: TimelineItem[] = [
    ...keptMessages.map(message => ({ kind: "message" as const, message })),
    ...keptTools.map(tool => ({ kind: "tool" as const, tool })),
  ].sort((a, b) => {
    const first = a.kind === "message" ? a.message : a.tool, second = b.kind === "message" ? b.message : b.tool;
    return first.seq - second.seq || first.time - second.time || first.id.localeCompare(second.id);
  });
  return { messages: keptMessages, tools: keptTools, timeline };
}
export type TimelineItem = { kind: "message"; message: Message } | { kind: "tool"; tool: ToolExecution };
