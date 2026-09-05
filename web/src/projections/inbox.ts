import type { AppState } from "../state/store";
import type { AttentionItem } from "@dsh-mobile/domain";
export function projectInbox(state: AppState): AttentionItem[] {
  const title = (id: string) => state.sessions[id]?.title ?? "Session";
  const items: AttentionItem[] = [
    ...Object.values(state.approvals).filter(a => a.state === "pending" && state.hello?.capabilities.includes("approvals")).map(a => ({ id: a.id, sessionId: a.sessionId, title: title(a.sessionId), kind: "approval" as const })),
    ...Object.values(state.questions).filter(q => q.state === "pending" && state.hello?.capabilities.includes("questions")).map(q => ({ id: q.id, sessionId: q.sessionId, title: title(q.sessionId), kind: "question" as const })),
    ...Object.values(state.tasks).filter(t => ["completed", "failed"].includes(t.status)).map(t => ({ id: t.id, sessionId: t.sessionId, title: t.title, kind: t.status as "completed" | "failed" })),
  ];
  for (const s of Object.values(state.sessions)) if (s.status === "waiting" && !items.some(i => i.sessionId === s.id)) items.push({ id: s.id, sessionId: s.id, title: s.title, kind: "waiting" });
  return items;
}
