import type { ApprovalResponse, Capability, HistoryPage, ImageDTO, ModelsDTO, MobileEvent, PresetsDTO, QuestionResponse, SelectModelInput, SendPromptInput, SetPresetInput, Snapshot } from "@dsh-mobile/protocol";
export interface HarnessAdapter {
  capabilities(): Capability[];
  snapshot(): Promise<Omit<Snapshot, "kind" | "revision">>;
  history(sessionId: string, cursor?: string): Promise<HistoryPage>;
  createSession(workspaceId?: string): Promise<{ sessionId: string }>;
  sendPrompt(input: SendPromptInput): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  respondApproval(input: ApprovalResponse): Promise<void>;
  respondQuestion(input: QuestionResponse): Promise<void>;
  attachment(sessionId: string, id: string): Promise<{ metadata: ImageDTO; data: Uint8Array }>;
  models(sessionId: string): Promise<ModelsDTO>;
  selectModel(input: SelectModelInput): Promise<void>;
  presets(): Promise<PresetsDTO>;
  selectPreset(input: SetPresetInput): Promise<void>;
  subscribe(callback: (event: MobileEvent) => void): () => void;
  refreshAccess?(): void;
  dispose(): void;
}
export class GatewayError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
