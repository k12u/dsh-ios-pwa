import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MobileEvent, PushSubscriptionDTO } from "@dsh-mobile/protocol";
import type { Registry } from "../auth/registry";

// RFC 8291 single-record aes128gcm, RFC 8292 VAPID. No notification content
// beyond an opaque session route and generic attention type is accepted here.
const hkdf = (secret: Buffer, salt: Buffer, info: Buffer, length: number) => Buffer.from(hkdfSync("sha256", secret, salt, info, length));
export function encryptPush(subscription: PushSubscriptionDTO, payload: string, fixture?: { privateKey: Buffer; salt: Buffer }): Buffer {
  const ua = Buffer.from(subscription.keys.p256dh, "base64url");
  if (ua.length !== 65 || ua[0] !== 4) throw new Error("Invalid subscription key");
  const server = createECDH("prime256v1");
  if (fixture) server.setPrivateKey(fixture.privateKey); else server.generateKeys();
  const publicKey = server.getPublicKey();
  const ikm = hkdf(server.computeSecret(ua), Buffer.from(subscription.keys.auth, "base64url"), Buffer.concat([Buffer.from("WebPush: info\0"), ua, publicKey]), 32);
  const salt = fixture?.salt ?? randomBytes(16);
  const key = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const data = Buffer.from(payload);
  if (data.length > 3000) throw new Error("Push payload too large");
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const recordSize = Buffer.alloc(4); recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([65]), publicKey, encrypted]);
}
export function validatePushEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  // Explicit public provider allowlist prevents user-supplied endpoints from
  // becoming an SSRF primitive, including redirects and private DNS names.
  if (url.protocol !== "https:" || url.port || url.username || url.password || !(
    url.hostname === "fcm.googleapis.com" || url.hostname === "updates.push.services.mozilla.com" ||
    url.hostname === "web.push.apple.com" || url.hostname.endsWith(".notify.windows.com")
  )) throw new Error("Unsupported push provider");
}
export class PushService {
  private taskStates = new Map<string, string>();
  private keys: { publicKey: string; privateKey: string };
  public readonly publicKey: string;
  constructor(private registry: Registry, file: string, private subject: string) {
    if (!/^(mailto:|https:)/.test(subject)) throw new Error("VAPID subject must be a mailto or HTTPS URL");
    if (existsSync(file)) this.keys = JSON.parse(readFileSync(file, "utf8"));
    else {
      const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = pair.publicKey.export({ format: "jwk" });
      this.keys = { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url"), privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(this.keys), { mode: 0o600 });
    }
    this.publicKey = this.keys.publicKey;
  }
  async notify(event: MobileEvent) {
    let title: string | undefined;
    if (event.kind === "attention.approval") title = "Approval required";
    if (event.kind === "attention.question") title = "An answer is needed";
    if (event.kind === "session.updated" && event.status === "failed") title = "Task failed";
    if (event.kind === "task.updated") {
      const previous = this.taskStates.get(event.task.id);
      this.taskStates.set(event.task.id, event.task.status);
      if (previous !== undefined && previous !== event.task.status) title = ({ completed: "Task completed", failed: "Task failed", waiting: "Agent waiting" } as Record<string, string>)[event.task.status];
    }
    if (event.kind === "task.removed") this.taskStates.delete(event.taskId);
    if (!title) return;
    const payload = JSON.stringify({ title, url: "/session/" + encodeURIComponent(event.sessionId), tag: event.id });
    for (const { id, subscription } of this.registry.subscriptions()) {
      if (!this.registry.active(id)) continue;
      try {
        validatePushEndpoint(subscription.endpoint);
        const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
        const token = encode({ typ: "JWT", alg: "ES256" }) + "." + encode({ aud: new URL(subscription.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 3600, sub: this.subject });
        const signature = sign("sha256", Buffer.from(token), { key: createPrivateKey(this.keys.privateKey), dsaEncoding: "ieee-p1363" }).toString("base64url");
        const body = encryptPush(subscription, payload);
        const response = await fetch(subscription.endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { Authorization: "vapid t=" + token + "." + signature + ", k=" + this.publicKey, TTL: "300", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream" }, body: new Uint8Array(body) });
        if (response.status === 404 || response.status === 410) this.registry.subscribe(id);
        await response.body?.cancel();
      } catch { /* A push provider outage must never interrupt the agent. */ }
    }
  }
}
