import { z } from "zod";

export const PROTOCOL = 1;
export const GATEWAY_VERSION = "0.1.0";
export const capabilities = ["sessions", "workspaces", "streaming", "tasks", "approvals", "questions", "images", "cancel", "steer", "push", "files", "commands", "skills", "models"] as const;
export type Capability = typeof capabilities[number];
const id = z.string().min(1).max(256);
const text = z.string().max(200_000);
const status = z.string().catch("unknown");
export const imageSchema = z.object({ id, name: z.string(), mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]), bytes: z.number().nonnegative() });
export const sessionSchema = z.object({ id, workspaceId: z.string().optional(), title: z.string(), status, updatedAt: z.number() });
export const workspaceSchema = z.object({ id, title: z.string(), path: z.string() });
export const taskSchema = z.object({ id, sessionId: id, title: z.string(), status, detail: z.string().optional() });
export const approvalSchema = z.object({ id, sessionId: id, toolName: z.string(), reason: z.string(), argumentsPreview: z.string().optional(), state: status });
export const questionFieldSchema = z.object({ id, title: z.string(), detail: z.string().optional(), multiple: z.boolean().default(false), options: z.array(z.object({ id, label: z.string(), description: z.string().optional() })).default([]) });
export const questionSchema = z.object({ id, sessionId: id, fields: z.array(questionFieldSchema), state: status });
export const hostSchema = z.object({ id, name: z.string(), status, adapter: z.string().optional() });
const envelope = { id, sessionId: id, seq: z.number().int().nonnegative(), time: z.number(), revision: z.number().int().nonnegative().default(0) };
export const eventSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("message.started"), messageId: id, role: z.enum(["user", "assistant"]), text: text.default(""), images: z.array(imageSchema).default([]) }),
  z.object({ ...envelope, kind: z.literal("message.delta"), messageId: id, text }),
  z.object({ ...envelope, kind: z.literal("message.completed"), messageId: id, role: z.enum(["user", "assistant"]), text, images: z.array(imageSchema).default([]) }),
  z.object({ ...envelope, kind: z.literal("tool.updated"), toolId: id, name: z.string(), status, preview: z.string().optional() }),
  z.object({ ...envelope, kind: z.literal("session.updated"), status }),
  z.object({ ...envelope, kind: z.literal("session.renamed"), title: z.string() }),
  z.object({ ...envelope, kind: z.literal("task.updated"), task: taskSchema }),
  z.object({ ...envelope, kind: z.literal("task.removed"), taskId: id }),
  z.object({ ...envelope, kind: z.literal("attention.approval"), approval: approvalSchema }),
  z.object({ ...envelope, kind: z.literal("attention.question"), question: questionSchema }),
  z.object({ ...envelope, kind: z.literal("attention.resolved"), attentionId: id, target: z.enum(["approval", "question"]), state: status }),
]);
export type MobileEvent = z.infer<typeof eventSchema>;
export const historySchema = z.object({ sessionId: id, events: z.array(z.unknown()), cursor: z.string().optional() });
// Gateway output is stricter than the forward-compatible client decoder.
export const historyPageSchema = historySchema.extend({ events: z.array(eventSchema) });
export const createdSessionSchema = z.object({ sessionId: id });
export const helloSchema = z.object({ kind: z.literal("hello"), protocol: z.number().int(), minSupportedProtocol: z.number().int(), gatewayVersion: z.string(), capabilities: z.array(z.string()) });
export const snapshotSchema = z.object({
  kind: z.literal("snapshot"), revision: z.number().int(), host: hostSchema,
  workspaces: z.array(workspaceSchema), sessions: z.array(sessionSchema),
  tasks: z.array(taskSchema), approvals: z.array(approvalSchema), questions: z.array(questionSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Hello = z.infer<typeof helloSchema>;
export type SessionDTO = z.infer<typeof sessionSchema>;
export type WorkspaceDTO = z.infer<typeof workspaceSchema>;
export type TaskDTO = z.infer<typeof taskSchema>;
export type ApprovalDTO = z.infer<typeof approvalSchema>;
export type QuestionDTO = z.infer<typeof questionSchema>;
export type ImageDTO = z.infer<typeof imageSchema>;
export type HostDTO = z.infer<typeof hostSchema>;
export type HistoryPage = { sessionId: string; events: MobileEvent[]; cursor?: string };
export const promptSchema = z.object({
  requestId: z.string().uuid(), sessionId: id, text: z.string().max(100_000).default(""),
  mode: z.enum(["queue", "steer"]).default("queue"),
  images: z.array(z.object({ mediaType: imageSchema.shape.mediaType, name: z.string().max(255), data: z.string().max(5_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/) })).max(4).default([]),
}).refine(v => v.text.trim().length > 0 || v.images.length > 0, "A prompt or image is required");
export type SendPromptInput = z.infer<typeof promptSchema>;
export const approvalResponseSchema = z.object({ id, sessionId: id, outcome: z.enum(["allowed-once", "rejected"]) });
export const questionResponseSchema = z.object({ id, sessionId: id, answers: z.array(z.object({ id, selected: z.array(id).max(50), custom: z.string().trim().min(1).max(10_000).optional() })).max(20) });
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
export type QuestionResponse = z.infer<typeof questionResponseSchema>;
export const createSessionSchema = z.object({ workspaceId: id.optional() });
export const modelSelectionSchema = z.object({ provider: z.string().min(1).max(256), model: z.string().min(1).max(256) });
export const modelOptionSchema = z.object({ id, name: z.string().min(1).max(256) });
export const modelGroupSchema = z.object({ id, name: z.string().min(1).max(256), models: z.array(modelOptionSchema).min(1).max(200) });
export const modelsSchema = z.object({ sessionId: id, current: modelSelectionSchema.nullable(), routable: z.boolean(), groups: z.array(modelGroupSchema).max(50) });
export const selectModelSchema = z.object({ sessionId: id, provider: z.string().min(1).max(256), model: z.string().min(1).max(256) });
export type ModelSelectionDTO = z.infer<typeof modelSelectionSchema>;
export type ModelsDTO = z.infer<typeof modelsSchema>;
export type SelectModelInput = z.infer<typeof selectModelSchema>;
export const pairingSchema = z.object({ token: z.string().min(32).max(128), name: z.string().trim().min(1).max(80).default("Mobile browser") });
export const pushSubscriptionSchema = z.object({ endpoint: z.string().url().max(2048), keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]+$/).length(87), auth: z.string().regex(/^[A-Za-z0-9_-]+$/).length(22) }) });
export type PushSubscriptionDTO = z.infer<typeof pushSubscriptionSchema>;
// Unknown event kinds and additive fields never leak into the domain.
export function decodeEvent(value: unknown): MobileEvent | undefined {
  const result = eventSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
export function decodeHistory(value: unknown): HistoryPage {
  const page = historySchema.parse(value);
  return { ...page, events: page.events.flatMap(e => { const event = decodeEvent(e); return event ? [event] : []; }) };
}
export function decodeHello(value: unknown): Hello {
  const hello = helloSchema.parse(value);
  if (hello.minSupportedProtocol > PROTOCOL || hello.protocol < PROTOCOL) throw new Error("Protocol update required");
  return hello;
}
