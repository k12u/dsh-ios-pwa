import { decodeEvent, decodeHello, snapshotSchema } from "@dsh-mobile/protocol";
import { api, ApiError, invalidateHistory, loadHistory } from "../api/gateway-client";
import { store } from "../state/store";
import { cacheMetadata, clearMetadata, readMetadata } from "../state/metadata-cache";
export class Connection {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private attempt = 0;
  private stopped = true;
  private selected?: string;
  private resumed = () => { if (document.visibilityState === "visible" && !this.stopped) this.connect(); else this.disconnect(); };
  start() {
    this.stopped = false;
    void readMetadata().then(value => { if (value && !store.get().host && store.get().connection !== "pairing") store.dispatch({ type: "snapshot", value }); });
    document.addEventListener("visibilitychange", this.resumed); window.addEventListener("pageshow", this.resumed); window.addEventListener("online", this.resumed);
    void this.connect();
  }
  stop() { this.stopped = true; this.disconnect(); document.removeEventListener("visibilitychange", this.resumed); window.removeEventListener("pageshow", this.resumed); window.removeEventListener("online", this.resumed); }
  async select(id: string) { this.selected = id; if (store.get().connection === "online") await loadHistory(id); }
  private disconnect() { clearTimeout(this.retry); this.generation++; this.socket?.close(); this.socket = undefined; }
  async connect() {
    this.disconnect();
    if (this.stopped || document.visibilityState === "hidden") return;
    const generation = this.generation;
    store.dispatch({ type: "connection", value: navigator.onLine ? "connecting" : "offline" });
    try {
      // Fetch makes 401/503 observable; browsers hide upgrade HTTP status.
      await api("/api/devices");
      if (generation !== this.generation) return;
      const socket = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws/mobile"); this.socket = socket;
      const timeout = setTimeout(() => socket.close(), 15_000);
      socket.onmessage = event => {
        if (generation !== this.generation) return;
        try {
          const frame: unknown = JSON.parse(event.data);
          if (typeof frame !== "object" || !frame) return;
          const kind = (frame as { kind?: string }).kind;
          if (kind === "hello") store.dispatch({ type: "hello", value: decodeHello(frame) });
          else if (kind === "snapshot") {
            clearTimeout(timeout); this.attempt = 0;
            const snapshot = snapshotSchema.parse(frame);
            invalidateHistory(); store.dispatch({ type: "snapshot", value: snapshot });
            void cacheMetadata(snapshot);
            // Keep writes disabled until the selected conversation is synced.
            const ready = this.selected ? loadHistory(this.selected) : Promise.resolve();
            void ready.then(() => { if (generation === this.generation) store.dispatch({ type: "connection", value: "online" }); }).catch(() => socket.close());
          } else { const e = decodeEvent(frame); if (e) store.dispatch({ type: "events", events: [e] }); }
        } catch (error) {
          store.dispatch({ type: "connection", value: "error", error: error instanceof Error ? error.message : "Invalid gateway response" }); this.stop();
        }
      };
      socket.onclose = event => {
        clearTimeout(timeout); if (generation !== this.generation || this.stopped) return;
        if (event.code === 4001 || event.code === 4003) { this.stop(); invalidateHistory(); void clearMetadata(); store.dispatch({ type: "reset" }); store.dispatch({ type: "connection", value: "pairing" }); return; }
        this.schedule(event.code === 1013);
      };
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof ApiError && error.status === 401) { this.stop(); store.dispatch({ type: "connection", value: "pairing" }); }
      else this.schedule(error instanceof ApiError && error.status === 503);
    }
  }
  private schedule(slow = false) {
    store.dispatch({ type: "connection", value: "offline" });
    const delay = slow ? 30_000 : Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5)) * (0.8 + Math.random() * 0.4);
    this.retry = setTimeout(() => { void this.connect(); }, delay);
  }
}
export const connection = new Connection();
