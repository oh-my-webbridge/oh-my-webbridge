import { mkdir, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve, join, relative } from "node:path";
import { unzipSync } from "fflate";
import { withTarZst } from "./archive.mjs";
const exec = promisify(execFile);
const root = resolve(process.argv[2] ?? "dist/release");
// Archives are packed from "."; directory entries end with "/".
const archiveFiles = async (name) =>
  (await withTarZst(join(root, name), (archive) => exec("tar", ["-tf", archive]))).stdout
    .split("\n")
    .filter((path) => path && !path.endsWith("/"));
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const lines = (await readFile(join(root, "SHA256SUMS"), "utf8")).trim().split("\n");
const files = [];
for (const line of lines) {
  const match = line.match(/^([a-f0-9]{64})  ([a-zA-Z0-9._-]+)$/u);
  if (!match || files.includes(match[2])) throw Error("invalid checksum manifest");
  if (
    createHash("sha256")
      .update(await readFile(join(root, match[2])))
      .digest("hex") !== match[1]
  )
    throw Error(`checksum mismatch: ${match[2]}`);
  files.push(match[2]);
}
const actual = (await readdir(root))
  .filter((name) => name !== "SHA256SUMS")
  .sort((a, b) => a.localeCompare(b));
if (JSON.stringify(files.toSorted((a, b) => a.localeCompare(b))) !== JSON.stringify(actual))
  throw Error("unlisted release files");
for (const os of ["darwin", "linux"])
  for (const arch of ["arm64", "amd64"]) {
    await withTarZst(join(root, `omw-${version}-${os}-${arch}.tar.zst`), async (archive) => {
      const { stdout } = await exec("tar", ["-tf", archive]);
      if (stdout.split("\n").some((p) => p.startsWith("/") || p.split("/").includes("..")))
        throw Error("unsafe archive path");
      if (!stdout.includes("licenses/coder-websocket.txt") || !stdout.includes("licenses/go.txt"))
        throw Error("missing native license");
      const { stdout: binary } = await exec("tar", ["-xOf", archive, "bin/omw"], {
        encoding: "buffer",
        maxBuffer: 32 << 20,
      });
      if (os === "linux") {
        if (
          binary.subarray(0, 4).toString() !== "\x7fELF" ||
          binary.readUInt16LE(18) !== (arch === "amd64" ? 62 : 183)
        )
          throw Error("wrong ELF architecture");
      } else if (
        binary.readUInt32LE(0) !== 0xfeedfacf ||
        binary.readUInt32LE(4) !== (arch === "amd64" ? 0x1000007 : 0x100000c)
      )
        throw Error("wrong Mach-O architecture");
    });
  }
const manifest = async (browser) =>
  JSON.parse(
    (
      await withTarZst(join(root, `omw-${version}-${browser}-mv3.tar.zst`), (archive) =>
        exec("tar", ["-xOf", archive, "./manifest.json"]),
      )
    ).stdout,
  );
const chrome = await manifest("chrome");
if (chrome.version !== version || chrome.manifest_version !== 3 || chrome.side_panel)
  throw Error("invalid Chrome MV3 release");
const firefox = await manifest("firefox");
if (
  firefox.version !== version ||
  firefox.manifest_version !== 3 ||
  firefox.browser_specific_settings?.gecko?.id !== "oh-my-webbridge@oh-my-webbridge.github.io"
)
  throw Error("invalid Firefox MV3 release");
// The unsigned add-on must hold exactly the files of the Firefox archive.
const xpi = `omw-${version}-firefox-mv3-unsigned.xpi`;
const addon = unzipSync(await readFile(join(root, xpi)));
await withTarZst(join(root, `omw-${version}-firefox-mv3.tar.zst`), async (archive) => {
  const unpacked = join(dirname(archive), "extension");
  await mkdir(unpacked);
  await exec("tar", ["-xf", archive, "-C", unpacked]);
  const files = (await readdir(unpacked, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => relative(unpacked, join(e.parentPath, e.name)))
    .sort((a, b) => a.localeCompare(b));
  const entries = Object.keys(addon)
    .filter((name) => !name.endsWith("/"))
    .sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(entries) !== JSON.stringify(files))
    throw Error(`${xpi} entries differ from the Firefox MV3 archive`);
  for (const file of files)
    if (!Buffer.from(addon[file]).equals(await readFile(join(unpacked, file))))
      throw Error(`${xpi} ${file} differs from the Firefox MV3 archive`);
});
// Both extensions redistribute the filtering engine and the pinned list data
// with their licenses and original notices; see THIRD_PARTY.md. The AdGuard,
// uBlock Origin and EasyList data is distributed under GPL-3.0, and the URLhaus
// list under its MIT notice. The unsigned add-on holds the Firefox archive's files.
const lock = JSON.parse(await readFile("third_party/filters/sources.lock.json", "utf8"));
for (const [browser, label] of [
  ["chrome", "Chrome"],
  ["firefox", "Firefox"],
]) {
  const archive = `omw-${version}-${browser}-mv3.tar.zst`;
  const extensionFiles = new Set(await archiveFiles(archive));
  const notices = [
    "./licenses/ghostery-MPL-2.0.txt",
    "./licenses/GPL-3.0.txt",
    "./licenses/urlhaus-filter-MIT.txt",
    "./filter-sources.json",
    ...lock.sources.map((source) => `./filter-sources/${source.id}.txt`),
  ].filter((path) => !extensionFiles.has(path));
  // licenses/packages.json lists each bundled npm package and its license files,
  // copied to licenses/<name with "/" replaced by "-">/.
  if (!extensionFiles.has("./licenses/packages.json")) notices.push("./licenses/packages.json");
  else {
    const { stdout: list } = await withTarZst(join(root, archive), (file) =>
      exec("tar", ["-xOf", file, "./licenses/packages.json"]),
    );
    const bundled = JSON.parse(list);
    if (!bundled.some((pkg) => pkg.name === "@ghostery/adblocker"))
      notices.push("an @ghostery/adblocker entry in ./licenses/packages.json");
    for (const pkg of bundled) {
      const dir = `./licenses/${pkg.name.replaceAll("/", "-")}`;
      if (!pkg.files.length) notices.push(`a license file for ${pkg.name}`);
      for (const file of ["package.json", ...pkg.files])
        if (!extensionFiles.has(`${dir}/${file}`)) notices.push(`${dir}/${file}`);
    }
  }
  if (notices.length)
    throw Error(`${label} MV3 archive is missing license or source notices: ${notices.join(", ")}`);
}
const kit = await archiveFiles(`omw-${version}-agent-kit.tar.zst`);
const expectedKit = ["./sdk.mjs", "./skills/oh-my-webbridge/SKILL.md"];
const missingKit = expectedKit.filter((path) => !kit.includes(path));
const unexpectedKit = kit.filter((path) => !expectedKit.includes(path));
if (missingKit.length || unexpectedKit.length)
  throw Error(
    `agent kit differs from its file list: missing ${missingKit.join(", ") || "none"}; unexpected ${unexpectedKit.join(", ") || "none"}`,
  );
const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
const provenance = JSON.parse(await readFile(join(root, "provenance.json"), "utf8"));
if (provenance.version !== version || provenance.commit !== commit)
  throw Error(
    `provenance.json describes ${provenance.version} at ${provenance.commit}; expected ${version} at ${commit}`,
  );
const report = `omw-${version}-benchmark.md`;
const raw = `omw-${version}-benchmark-raw.tar.zst`;
for (const name of [report, raw])
  if (files.includes(name) !== provenance.benchmarkIncluded)
    throw Error(`${name} presence differs from benchmarkIncluded=${provenance.benchmarkIncluded}`);
if (provenance.benchmarkIncluded) {
  const [rawReport, results] = await withTarZst(join(root, raw), async (archive) => {
    const read = async (path) =>
      (await exec("tar", ["-xOf", archive, path], { encoding: "buffer", maxBuffer: 64 << 20 }))
        .stdout;
    return [await read("./report.md"), await read("./results.json")];
  });
  if (!rawReport.equals(await readFile(join(root, report))))
    throw Error(`${report} differs from report.md in ${raw}`);
  if (JSON.parse(results.toString()).metadata?.commit !== commit)
    throw Error(`${raw} results.json was not measured at ${commit}`);
}
console.log(
  `Verified ${files.length} artifacts, four native architectures, Chrome and Firefox MV3, the unsigned Firefox add-on, agent kit, provenance and ${provenance.benchmarkIncluded ? "benchmark data" : "no benchmark"} (${version})`,
);
