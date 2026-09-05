import assert from "node:assert/strict";
import { test } from "node:test";
import { createECDH, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry, RateLimiter } from "../gateway/src/auth/registry";
import { encryptPush, validatePushEndpoint } from "../gateway/src/push/web-push";
test("pairing is expiring, single-use; credentials are hashed, persisted and revocable", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-auth-"));
  try {
    let now = 0; const file = join(root, "devices.json"), registry = new Registry(file, () => now);
    const pair = registry.createPairing(), { credential, device } = registry.pair(pair.token, "Phone");
    assert.throws(() => registry.pair(pair.token, "Other")); assert.equal(registry.authenticate(credential)?.id, device.id);
    assert.ok(!readFileSync(file, "utf8").includes(credential)); assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(new Registry(file, () => now).authenticate(credential)?.id, device.id);
    const expired = registry.createPairing(); now = expired.expiresAt; assert.throws(() => registry.pair(expired.token, "Late"));
    registry.revoke(device.id); assert.equal(registry.authenticate(credential), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("rate limiter bounds pairing attempts", () => { const limiter = new RateLimiter(2); limiter.check("a"); limiter.check("a"); assert.throws(() => limiter.check("a")); limiter.check("b"); });
test("Web Push encryption decrypts with independent receiver keys, authenticates and rejects tampering", () => {
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const auth = randomBytes(16);
  const subscription = { endpoint: "https://web.push.apple.com/test", keys: { auth: auth.toString("base64url"), p256dh: receiver.getPublicKey().toString("base64url") } };
  const payload = JSON.stringify({ title: "Approval required", url: "/session/opaque" });
  const encoded = encryptPush(subscription, payload);
  assert.equal(encoded.readUInt32BE(16), 4096); assert.equal(encoded[20], 65);
  const derive = (secret: Buffer, salt: Buffer, info: string | Buffer, size: number) => Buffer.from(hkdfSync("sha256", secret, salt, typeof info === "string" ? Buffer.from(info) : info, size));
  const serverKey = encoded.subarray(21, 86);
  const ikm = derive(receiver.computeSecret(serverKey), auth, Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), serverKey]), 32);
  const cek = derive(ikm, encoded.subarray(0, 16), "Content-Encoding: aes128gcm\0", 16);
  const nonce = derive(ikm, encoded.subarray(0, 16), "Content-Encoding: nonce\0", 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce); decipher.setAuthTag(encoded.subarray(-16));
  const plain = Buffer.concat([decipher.update(encoded.subarray(86, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2); assert.equal(plain.subarray(0, -1).toString(), payload);
  const changed = Buffer.from(encoded); changed[90] ^= 1;
  const invalid = createDecipheriv("aes-128-gcm", cek, nonce); invalid.setAuthTag(changed.subarray(-16)); invalid.update(changed.subarray(86, -16)); assert.throws(() => invalid.final());
  assert.notDeepEqual(encoded, encryptPush(subscription, payload));
});
test("push endpoint validation blocks SSRF, user info, ports and non-provider hosts", () => {
  for (const value of ["http://fcm.googleapis.com/x", "https://127.0.0.1/", "https://fcm.googleapis.com.evil.test", "https://a@web.push.apple.com/x", "https://web.push.apple.com:8888/x"]) assert.throws(() => validatePushEndpoint(value));
  validatePushEndpoint("https://fcm.googleapis.com/x"); validatePushEndpoint("https://web.push.apple.com/x");
});
test("Web Push reproduces the published RFC 8291 section 5 vector exactly", () => {
  // Public, non-secret test vector: https://www.rfc-editor.org/rfc/rfc8291#section-5
  const subscription = { endpoint: "https://web.push.apple.com/test", keys: {
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  } };
  const expected = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
  assert.equal(encryptPush(subscription, "When I grow up, I want to be a watermelon", {
    privateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"),
    salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
  }).toString("base64url"), expected);
});
