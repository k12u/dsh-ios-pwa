import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
function files(root: string): string[] { return readdirSync(root).flatMap(name => { const path = root + "/" + name; return statSync(path).isDirectory() ? files(path) : [path]; }); }
test("runtime-specific APIs stay within gateway adapters", () => {
  const source = [...files("packages"), ...files("web/src"), ...files("gateway/src")].filter(p => /\.(ts|tsx|js|mjs)$/.test(p) && !p.includes("/adapters/") && !p.includes("/types/"));
  for (const file of source) assert.doesNotMatch(readFileSync(file, "utf8"), /@deepseek-ai\/|typertGateway|assistant\/chunk|session\/follow/, file);
});
test("resolved imports cannot cross from the client or shared packages into the Gateway", () => {
  const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const source = [...files("packages"), ...files("web/src")].filter(p => /\.(ts|tsx|js|mjs)$/.test(p));
  for (const file of source) {
    const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") ? node.arguments[0]
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        assert.doesNotMatch(specifier.text, /@deepseek-ai\/|dsh-plugin-|typert/, file);
        const module = ts.resolveModuleName(specifier.text, resolve(file), options, ts.sys).resolvedModule;
        if (module) {
          const target = relative(process.cwd(), module.resolvedFileName).replaceAll("\\", "/");
          assert.ok(!target.startsWith("gateway/") && !target.startsWith("vendor/mobile-gateway/"), `${file} imports ${target}`);
          if (file.startsWith("packages/")) assert.ok(!target.startsWith("web/"), `${file} imports ${target}`);
          if (file.startsWith("packages/protocol/")) assert.ok(!target.startsWith("packages/domain/"), `${file} reverses protocol dependency`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
});
test("service worker caches only the public shell; build includes valid icons and hashed assets", () => {
  const worker = readFileSync("web/dist/sw.js", "utf8");
  assert.doesNotMatch(worker, /__ASSETS__|__BUILD_ID__|new WebSocket/);
  for (const route of ["/api/", "/push/", "/pair", "/version.json"]) assert.ok(worker.includes(route));
  const manifest = JSON.parse(readFileSync("web/dist/manifest.webmanifest", "utf8"));
  assert.equal(manifest.display, "standalone");
  for (const size of [192, 512]) {
    const png = readFileSync("web/dist/icon-" + size + ".png");
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
  }
  assert.match(readFileSync("web/dist/index.html", "utf8"), /\/assets\/index-[A-Za-z0-9_-]+\.js/);
});
