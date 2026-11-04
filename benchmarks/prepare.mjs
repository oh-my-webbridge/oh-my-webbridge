import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
const exec = promisify(execFile);
const root = resolve("dist/benchmark-vendors");
await mkdir(root, { recursive: true });
const artifacts = [
  {
    id: "agent-browser",
    tool: "agent-browser",
    url: "https://github.com/vercel-labs/agent-browser/releases/download/v0.40.0/agent-browser-linux-x64",
    sha256: "da26cc8029c004325b960fa955951063380cb61e622cc580fd5adf3aa89e4676",
    env: "AGENT_BROWSER_BIN",
  },
  {
    id: "obu.tar.gz",
    tool: "open-browser-use",
    url: "https://github.com/open-browser-use/open-browser-use/releases/download/v0.1.12/open-browser-use-0.1.12-linux-x64-gnu.tar.gz",
    sha256: "01e4dc6f3a6d39174e087a9a28095ac441e844c7cc1c981be20e4a2f299e38a3",
  },
];
// Mutable vendor URLs can serve new bytes after a release tag exists. Changed
// bytes are unreviewed, so they are deleted and the comparator is recorded as
// unavailable; the other comparators are still prepared and measured.
const unavailable = [];
for (const a of artifacts) {
  const file = join(root, a.id);
  await exec("curl", ["-fsSL", "--retry", "3", "--max-time", "120", a.url, "-o", file]);
  const actual = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
  if (actual !== a.sha256) {
    await rm(file);
    unavailable.push({
      tool: a.tool,
      artifact: a.id,
      url: a.url,
      expectedSha256: a.sha256,
      actualSha256: actual,
      checkedAt: new Date().toISOString(),
    });
    continue;
  }
  if (a.env) await chmod(file, 0o755);
}
const ready = (tool) => !unavailable.some((u) => u.tool === tool);
if (ready("open-browser-use")) {
  await mkdir(join(root, "obu"), { recursive: true });
  await exec("tar", ["--no-same-owner", "-xzf", join(root, "obu.tar.gz"), "-C", join(root, "obu")]);
}
const pi = resolve("benchmarks/tools/node_modules/pi-chrome-use/src");
await build({
  stdin: {
    contents: `export {executeBrowserCode} from ${JSON.stringify(join(pi, "browser-execute.ts"))};export {SessionStore} from ${JSON.stringify(join(pi, "session-store.ts"))};`,
    resolveDir: process.cwd(),
  },
  outfile: join(root, "pi.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
});
await writeFile(
  join(root, "provenance.json"),
  JSON.stringify({ artifacts, unavailable }, null, 2) + "\n",
);
for (const u of unavailable)
  console.log(
    `${u.tool} unavailable: ${u.artifact} changed upstream (expected ${u.expectedSha256}, got ${u.actualSha256}); review and repin`,
  );
console.log("Pinned vendor payloads prepared. No installer or personal profile used.");
