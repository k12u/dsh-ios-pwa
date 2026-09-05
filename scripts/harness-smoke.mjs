import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
const binary = process.env.DSH_BIN;
if (!binary) throw new Error("Set DSH_BIN to the installed official @deepseek-ai/dsh/lib/bin.js");
const stateDir = await mkdtemp(join(tmpdir(), "dsh-mobile-smoke-"));
const env = { ...process.env, DSH_HOME: stateDir, DSH_MOBILE_DATA_DIR: join(stateDir, "mobile"), CI: "true" };
let child;
let socket;
try {
  execFileSync(process.execPath, ["--expose-internals", binary, "plugin", "--profile", "web", "add", "link:" + resolve("gateway")], { env, stdio: "inherit", timeout: 180_000 });
  child = spawn(process.execPath, ["--expose-internals", binary, "web", "--host", "127.0.0.1", "--port", "8790", "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 90_000;
  let token;
  while (!(token = output.match(/http:\/\/localhost:8787\/pair\?t=([A-Za-z0-9_-]+)/)?.[1])) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error("Harness/Gateway boot failed:\n" + output.replace(/([?&]t=)[A-Za-z0-9_-]+/g, "$1[redacted]"));
    await new Promise(r => setTimeout(r, 200));
  }
  const root = "http://127.0.0.1:8787";
  if (!(await fetch(root + "/")).ok) throw new Error("PWA static serve failed");
  const managementUrl = "http://localhost:8790/mobile-pwa";
  const management = await fetch(managementUrl);
  if (!management.ok || management.headers.get("referrer-policy") !== "same-origin") throw new Error("Local management must preserve native form POST Origin");
  await management.body?.cancel();
  for (const rejectedOrigin of [undefined, "null", "https://example.invalid"]) {
    const rejected = await fetch(managementUrl, { method: "POST", headers: rejectedOrigin === undefined ? {} : { Origin: rejectedOrigin } });
    await rejected.body?.cancel();
    if (rejected.status !== 403) throw new Error("Local management accepted an invalid POST Origin");
  }
  const issued = await fetch(managementUrl, { method: "POST", headers: { Origin: "http://localhost:8790" } });
  if (!issued.ok) throw new Error("Local management rejected a same-origin POST");
  token = (await issued.text()).match(/\/pair\?t=([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error("Local management did not issue a pairing link");
  const paired = await fetch(root + "/api/pair", { method: "POST", headers: { Origin: "http://localhost:8787", "Content-Type": "application/json" }, body: JSON.stringify({ token, name: "Compatibility CI" }) });
  if (!paired.ok) throw new Error("Pairing failed");
  const cookie = paired.headers.get("set-cookie")?.split(";")[0];
  const response = await fetch(root + "/api/snapshot", { headers: { Cookie: cookie } });
  if (!response.ok) throw new Error("Authoritative host/workspace/session snapshot failed");
  const state = await response.json();
  if (!Array.isArray(state.sessions) || !Array.isArray(state.workspaces)) throw new Error("Invalid normalized snapshot");
  socket = new WebSocket("ws://127.0.0.1:8787/ws/mobile", { headers: { Origin: "http://localhost:8787", Cookie: cookie } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket snapshot timed out")), 20_000);
    let hello = false;
    const fail = error => { clearTimeout(timer); reject(error); };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("WebSocket closed before snapshot")));
    socket.on("message", data => {
      try {
        const frame = JSON.parse(data.toString());
        if (frame.kind === "hello") {
          if (!Array.isArray(frame.capabilities) || !frame.capabilities.includes("sessions")) throw new Error("Missing session capability");
          hello = true;
        }
        if (frame.kind === "snapshot") {
          if (!hello || !Array.isArray(frame.sessions) || !Array.isArray(frame.workspaces)) throw new Error("Invalid WebSocket initial sync");
          clearTimeout(timer); resolve();
        }
      } catch (error) { fail(error); }
    });
  });
  console.log("Official Harness + plugin boot, PWA static serve, local management/CSRF, pairing, auth, normalized snapshot and WebSocket initial sync passed.");
  console.log("Model-dependent prompt/HITL/image/notification delivery remains a separate live acceptance check.");
} finally {
  socket?.terminate();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    await once(child, "exit").catch(() => {}); clearTimeout(timeout);
  }
  await rm(stateDir, { recursive: true, force: true });
}
