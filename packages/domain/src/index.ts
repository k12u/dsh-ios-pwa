import type { ApprovalDTO, HostDTO, ImageDTO, QuestionDTO, SessionDTO, TaskDTO, WorkspaceDTO } from "@dsh-mobile/protocol";
// These names are the stable application vocabulary, independent of the runtime.
export interface Host extends HostDTO {}
export interface Workspace extends WorkspaceDTO {}
export interface Session extends SessionDTO {}
export interface AgentTask extends TaskDTO {}
export interface Approval extends ApprovalDTO {}
export interface Question extends QuestionDTO {}
export interface Artifact extends ImageDTO { sessionId: string }
export interface Message { id: string; sessionId: string; role: "user" | "assistant"; text: string; images: ImageDTO[]; complete: boolean; seq: number; time: number }
export interface ToolExecution { id: string; sessionId: string; name: string; status: string; preview?: string; seq: number; time: number }
export interface AttentionItem { id: string; sessionId: string; title: string; kind: "approval" | "question" | "completed" | "failed" | "waiting" }
