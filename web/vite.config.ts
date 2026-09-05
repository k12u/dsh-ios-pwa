import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({ root: resolve("web"), build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 600 } });
