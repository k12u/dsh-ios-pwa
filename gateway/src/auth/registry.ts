import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PushSubscriptionDTO } from "@dsh-mobile/protocol";
import { GatewayError } from "../normalization/adapter";
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
interface Device { id: string; name: string; digest: string; expiresAt: number; createdAt: number; push?: PushSubscriptionDTO }
export class Registry {
  private devices: Device[] = [];
  private tokens = new Map<string, number>();
  constructor(private file?: string, private now = Date.now) {
    if (file && existsSync(file)) this.devices = JSON.parse(readFileSync(file, "utf8"));
  }
  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + ".tmp";
    writeFileSync(temp, JSON.stringify(this.devices), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  createPairing() {
    for (const [key, expiry] of this.tokens) if (expiry <= this.now()) this.tokens.delete(key);
    if (this.tokens.size >= 20) throw new GatewayError(429, "rate-limit", "Too many pairing links");
    const token = randomBytes(32).toString("base64url"); const expiresAt = this.now() + 5 * 60_000;
    this.tokens.set(hash(token), expiresAt);
    return { token, expiresAt };
  }
  pair(token: string, name: string) {
    const digest = hash(token); const expiry = this.tokens.get(digest);
    this.tokens.delete(digest);
    if (!expiry || expiry <= this.now()) throw new GatewayError(401, "invalid-pairing", "The pairing link has expired or was already used.");
    this.devices = this.devices.filter(d => d.expiresAt > this.now());
    if (this.devices.length >= 100) throw new GatewayError(429, "device-limit", "Revoke an unused device before pairing.");
    const credential = randomBytes(32).toString("base64url");
    const device: Device = { id: randomUUID(), name, digest: hash(credential), createdAt: this.now(), expiresAt: this.now() + 30 * 86400_000 };
    this.devices.push(device); this.save();
    return { credential, device };
  }
  authenticate(credential?: string) { return credential ? this.devices.find(d => d.digest === hash(credential) && d.expiresAt > this.now()) : undefined; }
  active(id: string) { return this.devices.some(d => d.id === id && d.expiresAt > this.now()); }
  list() { return this.devices.filter(d => d.expiresAt > this.now()).map(({ id, name, createdAt, expiresAt }) => ({ id, name, createdAt, expiresAt })); }
  revoke(id: string) { this.devices = this.devices.filter(d => d.id !== id); this.save(); }
  subscribe(id: string, push?: PushSubscriptionDTO) { const d = this.devices.find(d => d.id === id); if (d) { d.push = push; this.save(); } }
  subscriptions() { return this.devices.filter(d => d.push && d.expiresAt > this.now()).map(d => ({ id: d.id, subscription: d.push! })); }
}
export class RateLimiter {
  private buckets = new Map<string, { count: number; until: number }>();
  constructor(private limit: number, private window = 60_000) {}
  check(key: string) {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.until <= now) this.buckets.delete(k);
    const bucket = this.buckets.get(key) ?? { count: 0, until: now + this.window };
    if (++bucket.count > this.limit || this.buckets.size > 10_000) throw new GatewayError(429, "rate-limit", "Too many requests. Try again shortly.");
    this.buckets.set(key, bucket);
  }
}
