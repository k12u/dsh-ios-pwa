import { eventSchema, type MobileEvent, type TaskDTO } from "@dsh-mobile/protocol";
// All raw Harness event vocabulary lives here. Never forward raw objects.
type Raw = { type: string; seq: number; time: number; data?: any };
function textOf(blocks: any[] = []): string { return blocks.filter(b => b?.type === "text").map(b => String(b.text ?? "")).join(""); }
function imagesOf(blocks: any[] = []) {
  return blocks.filter(b => b?.type === "image" && b.attachment).map(b => ({
    id: String(b.attachment.attachmentId), name: String(b.attachment.name ?? "Image"),
    mediaType: b.attachment.mediaType, bytes: b.attachment.bytes,
  }));
}
export function normalizeEvent(sessionId: string, raw: Raw): MobileEvent[] {
  if (!Number.isSafeInteger(raw.seq) || raw.seq < 0) return [];
  const d = raw.data ?? {};
  const base = { sessionId, seq: raw.seq, time: raw.time, revision: 0 };
  const messageId = sessionId + ":assistant:" + d.turn + ":" + d.step;
  let event: any;
  switch (raw.type) {
    case "user/message": event = { kind: "message.completed", role: "user", messageId: sessionId + ":user:" + raw.seq, text: textOf(d.content), images: imagesOf(d.content) }; break;
    case "step/start": event = { kind: "message.started", role: "assistant", messageId }; break;
    case "assistant/chunk":
      if (d.chunk?.type !== "text-delta") return [];
      event = { kind: "message.delta", messageId, text: d.chunk.text }; break;
    case "assistant/message": event = { kind: "message.completed", role: "assistant", messageId, text: textOf(d.message?.content), images: imagesOf(d.message?.content) }; break;
    case "tool/call": event = { kind: "tool.updated", toolId: String(d.callId), name: String(d.name), status: "running", preview: JSON.stringify(d.arguments)?.slice(0, 2000) }; break;
    case "tool/result": event = { kind: "tool.updated", toolId: String(d.message?.source?.callId), name: "", status: d.error ? "failed" : "completed", preview: (d.message?.content ?? []).map((b: any) => textOf(b.content)).join("").slice(0, 2000) }; break;
    case "turn/start": event = { kind: "session.updated", status: "running" }; break;
    case "session/title": event = { kind: "session.renamed", title: String(d.title) }; break;
    case "turn/end": event = { kind: "session.updated", status: d.reason?.kind === "error" ? "failed" : "idle" }; break;
    default: return [];
  }
  const parsed = eventSchema.safeParse({ ...base, ...event, id: sessionId + ":" + raw.seq + ":" + event.kind });
  return parsed.success ? [parsed.data] : [];
}
export function normalizeTasks(sessionId: string, values: any): TaskDTO[] {
  const todos = Array.isArray(values?.todos) ? values.todos : values?.todos?.items ?? [];
  const tasks: TaskDTO[] = todos.map((t: any, i: number) => ({
    id: sessionId + ":todo:" + (t.id ?? i), sessionId, title: String(t.content ?? t.title ?? t.text ?? "Task"),
    status: ({ in_progress: "running", pending: "pending", completed: "completed" } as Record<string, string>)[t.status] ?? "unknown",
  }));
  const goal = values?.goal?.goal ?? values?.goal;
  if (goal?.objective) tasks.unshift({
    id: sessionId + ":goal:" + goal.id, sessionId, title: goal.objective,
    status: ({ active: "running", paused: "waiting", achieved: "completed", complete: "completed", completed: "completed", blocked: "waiting" } as Record<string, string>)[goal.phase ?? goal.status] ?? "unknown",
  });
  return tasks;
}
