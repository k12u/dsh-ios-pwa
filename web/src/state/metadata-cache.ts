import { snapshotSchema, PROTOCOL, type Snapshot } from "@dsh-mobile/protocol";
const DATABASE = "dsh-mobile-metadata";
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("metadata");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
// Only explicitly allowed summaries. No credentials, messages, attachments,
// pending decisions, tool arguments or results are written to IndexedDB.
export async function cacheMetadata(snapshot: Snapshot) {
  try {
    const value = { protocol: PROTOCOL, savedAt: Date.now(), snapshot: {
      kind: "snapshot", revision: 0, host: snapshot.host, workspaces: snapshot.workspaces.slice(0, 50),
      sessions: snapshot.sessions.slice(0, 50), tasks: snapshot.tasks.slice(0, 50), approvals: [], questions: [],
    } };
    const db = await database();
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("metadata", "readwrite"); tx.objectStore("metadata").put(value, "last"); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  } catch { /* Quota and private-browsing failures are non-fatal. */ }
}
export async function readMetadata(): Promise<Snapshot | undefined> {
  try {
    const db = await database();
    const value: any = await new Promise((resolve, reject) => { const request = db.transaction("metadata").objectStore("metadata").get("last"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close();
    if (value?.protocol !== PROTOCOL || value.savedAt < Date.now() - 7 * 86400_000) return;
    return snapshotSchema.parse(value.snapshot);
  } catch { return; }
}
export async function clearMetadata() {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => { const tx = db.transaction("metadata", "readwrite"); tx.objectStore("metadata").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  } catch {}
}
