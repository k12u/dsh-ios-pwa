import { decodeHistory } from "@dsh-mobile/protocol";
import { store } from "../state/store";
import { clearMetadata } from "../state/metadata-cache";
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function api<T = any>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000), headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) { invalidateHistory(); void clearMetadata(); store.dispatch({ type: "reset" }); store.dispatch({ type: "connection", value: "pairing" }); }
    throw new ApiError(response.status, data.message ?? "Request failed");
  }
  return data;
}
const generations = new Map<string, number>();
export async function loadHistory(sessionId: string, cursor?: string) {
  const generation = generations.get(sessionId) ?? 0;
  const page = decodeHistory(await api("/api/sessions/" + encodeURIComponent(sessionId) + "/history" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "")));
  if (generation !== (generations.get(sessionId) ?? 0)) return;
  store.dispatch({ type: "events", events: page.events });
  store.dispatch({ type: "cursor", sessionId, cursor: page.cursor });
}
export function invalidateHistory() { for (const key of Object.keys(store.get().sessions)) generations.set(key, (generations.get(key) ?? 0) + 1); }
