import { resolve } from "node:path";
import { DemoAdapter } from "./adapters/demo";
import { Registry } from "./auth/registry";
import { createGateway } from "./server";
const port = Number(process.env.PORT ?? 8787);
const origin = "http://localhost:" + port;
const registry = new Registry();
const app = createGateway(new DemoAdapter(), { origin, registry, staticDir: resolve("web/dist") });
app.server.listen(port, "127.0.0.1", () => {
  console.log("DSH Mobile · local preview (no Harness runtime)");
  console.log(origin + "/pair?t=" + registry.createPairing().token);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void app.close(); });
