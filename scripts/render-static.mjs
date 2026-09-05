import { build } from "esbuild";
import { execFileSync } from "node:child_process";
await build({ entryPoints: ["scripts/render-preview.tsx"], outfile: "test-results/render-preview.mjs", bundle: true, platform: "node", format: "esm", packages: "external", loader: { ".css": "empty" } });
execFileSync(process.execPath, ["test-results/render-preview.mjs"], { stdio: "inherit" });
console.log("Static layout preview: test-results/preview.html");
