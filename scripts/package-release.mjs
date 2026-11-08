import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, cp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { packTarZst } from "./archive.mjs";
const exec = promisify(execFile);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
if (!/^\d+\.\d+\.\d+$/u.test(version)) throw Error("expected stable semver");
const directory = resolve("dist/release");
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const staging = resolve("dist/release-staging");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const module = JSON.parse(
  (await exec("go", ["mod", "download", "-json", "github.com/coder/websocket"])).stdout,
);
const goRoot = (await exec("go", ["env", "GOROOT"])).stdout.trim();
await mkdir(join(staging, "licenses"), { recursive: true });
await cp(join(module.Dir, "LICENSE.txt"), join(staging, "licenses", "coder-websocket.txt"));
await cp(join(goRoot, "LICENSE"), join(staging, "licenses", "go.txt"));
for (const file of ["README.md", "LICENSE", "NOTICE", "THIRD_PARTY.md"])
  await cp(file, join(staging, file));
await mkdir(join(staging, "bin"), { recursive: true });
for (const GOOS of ["darwin", "linux"])
  for (const GOARCH of ["arm64", "amd64"]) {
    await exec(
      "go",
      [
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags=-s -w",
        "-o",
        join(staging, "bin", "omw"),
        "./cmd/omw",
      ],
      { env: { ...process.env, CGO_ENABLED: "0", GOOS, GOARCH } },
    );
    await packTarZst(join(directory, `omw-${version}-${GOOS}-${GOARCH}.tar.zst`), staging, [
      "bin",
      "licenses",
      "README.md",
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY.md",
    ]);
  }
// The store packages keep manifest.json at the archive root, the layout the
// Chrome Web Store, Firefox and AMO signing read. Entries are sorted for a
// stable listing.
async function zipExtension(source, target) {
  const files = {};
  for (const entry of (await readdir(source, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => relative(source, join(e.parentPath, e.name)))
    .sort((a, b) => a.localeCompare(b)))
    files[entry] = await readFile(join(source, entry));
  await writeFile(target, zipSync(files));
}
const chrome = "dist/extension";
await packTarZst(join(directory, `omw-${version}-chrome-mv3.tar.zst`), chrome, ["."]);
await zipExtension(chrome, join(directory, `omw-${version}-chrome-mv3.zip`));
const firefox = "dist/extension-firefox";
await packTarZst(join(directory, `omw-${version}-firefox-mv3.tar.zst`), firefox, ["."]);
await zipExtension(firefox, join(directory, `omw-${version}-firefox-mv3-unsigned.xpi`));
const kit = join(staging, "agent-kit");
await mkdir(kit, { recursive: true });
await cp("dist/sdk.mjs", join(kit, "sdk.mjs"));
await cp("skills/oh-my-webbridge", join(kit, "skills", "oh-my-webbridge"), { recursive: true });
await packTarZst(join(directory, `omw-${version}-agent-kit.tar.zst`), kit, ["."]);
const benchmark = process.env.OMW_RELEASE_BENCHMARK;
if (benchmark) {
  await cp(join(benchmark, "report.md"), join(directory, `omw-${version}-benchmark.md`));
  await packTarZst(join(directory, `omw-${version}-benchmark-raw.tar.zst`), benchmark, ["."]);
}
await writeFile(
  join(directory, "provenance.json"),
  JSON.stringify(
    {
      schema: 1,
      version,
      commit: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
      node: process.version,
      go: (await exec("go", ["version"])).stdout.trim(),
      archive: {
        format: "tar.zst",
        level: 3,
        threads: 1,
        zstd: (await exec("zstd", ["--version"])).stdout.trim(),
      },
      filterSources: JSON.parse(await readFile("third_party/filters/sources.lock.json", "utf8")),
      filterBuild: JSON.parse(await readFile("dist/extension/filter-report.json", "utf8")),
      benchmarkIncluded: Boolean(benchmark),
    },
    null,
    2,
  ) + "\n",
);
const sums = [];
for (const file of (await readdir(directory)).sort())
  sums.push(
    `${createHash("sha256")
      .update(await readFile(join(directory, file)))
      .digest("hex")}  ${file}`,
  );
await writeFile(join(directory, "SHA256SUMS"), sums.join("\n") + "\n");
await rm(staging, { recursive: true, force: true });
console.log(`Packaged ${version}: ${sums.length} checksummed files`);
