import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DshAdapter, type HarnessContext } from "./harness";
import { Registry, RateLimiter } from "../auth/registry";
import { PushService } from "../push/web-push";
import { createGateway } from "../server";
import qrcode from "../pairing/qrcode.cjs";
interface Config { publicOrigin: string; port?: number; dataDir?: string; pushSubject?: string }
export default {
  name: "mobile-pwa",
  inject: ["typertGateway", "webServer", "typert"],
  apply(ctx: HarnessContext, config: Config) {
    if (!config?.publicOrigin) throw new Error("Configure mobile-pwa.publicOrigin with the HTTPS PWA origin.");
    const origin = new URL(config.publicOrigin).origin;
    const dataDir = config.dataDir ?? process.env.DSH_MOBILE_DATA_DIR ?? resolve(os.homedir(), ".local/state/dsh-mobile");
    const registry = new Registry(resolve(dataDir, "devices.json"));
    const push = config.pushSubject ? new PushService(registry, resolve(dataDir, "vapid.json"), config.pushSubject) : undefined;
    // Fail open to the host's own handler until createGateway installs the
    // live-audience gate. A merely paired (offline) device must not hijack HITL.
    const adapter = new DshAdapter(ctx, () => false);
    const app = createGateway(adapter, { origin, registry, push, staticDir: fileURLToPath(new URL("../public", import.meta.url)) });
    const adminLimit = new RateLimiter(10);
    const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    const management = ctx.webServer?.register({
      kind: "prefix", path: "/mobile-pwa",
      handler(req, res) {
        const host = req.headers.host;
        const expected = ["localhost", "127.0.0.1", "[::1]"].map(h => h + ":" + ctx.webServer!.port);
        const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
        if (!loopback || !expected.includes(host) || (req.method !== "GET" && req.headers.origin !== "http://" + host)) { res.writeHead(403); res.end("Local Harness management only"); return; }
        if (req.url?.split("?")[0] !== "/mobile-pwa" || !["GET", "POST"].includes(req.method)) { res.writeHead(404); res.end(); return; }
        res.setHeader("Cache-Control", "no-store");
        // Native form POSTs under no-referrer send Origin: null. Preserve the
        // same-origin form's Origin so the strict CSRF check above can succeed.
        res.setHeader("Referrer-Policy", "same-origin");
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        let link = "";
        if (req.method === "POST") {
          try { adminLimit.check("local"); } catch { res.writeHead(429); res.end("Try again shortly"); return; }
          req.resume();
          link = origin + "/pair?t=" + registry.createPairing().token;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        let qr = "";
        if (link) { const code = qrcode(0, "M"); code.addData(link); code.make(); qr = code.createSvgTag(4, 16); }
        res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>DSH Mobile pairing</title><style>body{font:16px system-ui;max-width:620px;margin:60px auto;padding:24px;line-height:1.7}button{font:inherit;padding:12px}a{overflow-wrap:anywhere}svg{display:block;max-width:100%;height:auto;margin-top:24px}</style><h1>Pair DSH Mobile</h1><p>Create a one-time link and scan it with your phone camera. It expires after five minutes.</p><form method="post"><button>Create pairing link</button></form>' + qr + (link ? '<p><a href="' + escape(link) + '">' + escape(link) + '</a></p>' : ""));
      },
    });
    // A separate loopback listener is the only externally proxied surface.
    app.server.listen(config.port ?? 8787, "127.0.0.1", () => {
      const pairing = registry.createPairing();
      console.log("[mobile-pwa] Pair within 5 minutes: " + origin + "/pair?t=" + pairing.token);
    });
    ctx.effect(() => () => { management?.(); void app.close(); });
  },
};
