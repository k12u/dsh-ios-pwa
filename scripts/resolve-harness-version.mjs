import { execFileSync } from "node:child_process";
const channel = process.argv[2];
const pattern = { stable: /^\d+\.\d+\.\d+$/, rc: /-rc\.\d+$/, alpha: /-alpha\.\d+$/ }[channel];
if (!pattern) throw new Error("Choose stable, rc or alpha");
const versions = JSON.parse(execFileSync("npm", ["view", "@deepseek-ai/dsh", "versions", "--json"], { encoding: "utf8" }));
const version = versions.filter(v => pattern.test(v)).at(-1);
if (!version) throw new Error("No published version for " + channel);
process.stdout.write(version);
