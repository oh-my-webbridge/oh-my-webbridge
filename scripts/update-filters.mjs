import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = [
  ["adguard-base", "https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt"],
  ["adguard-tracking", "https://filters.adtidy.org/extension/ublock/filters/3.txt"],
  ["easylist", "https://easylist.to/easylist/easylist.txt"],
  ["easyprivacy", "https://easylist.to/easylist/easyprivacy.txt"],
  ...["filters", "badware", "privacy", "unbreak", "quick-fixes"].map((id) => [
    `ublock-${id}`,
    `https://ublockorigin.github.io/uAssets/filters/${id}.txt`,
  ]),
  ["urlhaus", "https://malware-filter.gitlab.io/urlhaus-filter/urlhaus-filter-vivaldi-online.txt"],
  [
    "peter-lowe",
    "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=1&mimetype=plaintext",
  ],
  [
    "resources",
    "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json",
  ],
];
await mkdir("third_party/filters", { recursive: true });
const entries = await Promise.all(
  sources.map(async ([id, url]) => {
    const temp = `third_party/filters/${id}.download`;
    await exec("curl", [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--max-time",
      "90",
      url,
      "-o",
      temp,
    ]);
    const bytes = await readFile(temp);
    const text = bytes.toString("utf8");
    if (bytes.length < 100 || /<html[\s>]/i.test(text.slice(0, 500)))
      throw Error(`invalid list: ${id}`);
    if (id === "resources") JSON.parse(text);
    const zipped = gzipSync(bytes, { level: 9 });
    const file = `${id}.gz`;
    await writeFile(`third_party/filters/${file}`, zipped);
    const { unlink } = await import("node:fs/promises");
    await unlink(temp);
    return {
      id,
      url,
      file,
      sha256: sha(bytes),
      gzipSha256: sha(zipped),
      bytes: bytes.length,
      header: text.split("\n").slice(0, 16),
    };
  }),
);
const queue = [...entries];
const known = new Map(entries.map((s) => [s.url, s]));
for (const parent of queue) {
  if (entries.length > 64)
    throw Error("filter include closure exceeds 64 sources; review before expanding");
  const { gunzipSync } = await import("node:zlib");
  const text = gunzipSync(await readFile(`third_party/filters/${parent.file}`)).toString();
  for (const line of text.split("\n")) {
    const match = line.match(/^!#include\s+(\S+)\s*$/u);
    if (!match) continue;
    const url = new URL(match[1], parent.url);
    if (url.origin !== new URL(parent.url).origin || url.protocol !== "https:")
      throw Error(`untrusted filter include: ${url}`);
    if (known.has(url.href)) continue;
    const id = `include-${url.pathname
      .split("/")
      .at(-1)
      .replace(/[^a-zA-Z0-9.-]/gu, "-")}`;
    const { stdout } = await exec("curl", ["-fsSL", "--retry", "3", "--max-time", "90", url.href], {
      maxBuffer: 16 << 20,
      encoding: "buffer",
    });
    const bytes = stdout;
    const zipped = gzipSync(bytes, { level: 9 });
    if (bytes.length < 30 || /<html[\s>]/iu.test(bytes.toString().slice(0, 500)))
      throw Error(`invalid include ${url}`);
    const file = `${id}.gz`;
    await writeFile(`third_party/filters/${file}`, zipped);
    const source = {
      id,
      url: url.href,
      file,
      sha256: sha(bytes),
      gzipSha256: sha(zipped),
      bytes: bytes.length,
      includedBy: parent.id,
      header: bytes.toString().split("\n").slice(0, 16),
    };
    known.set(url.href, source);
    entries.push(source);
    queue.push(source);
  }
}
entries.sort((a, b) => a.id.localeCompare(b.id));
let previous;
try {
  previous = JSON.parse(await readFile("third_party/filters/sources.lock.json", "utf8"));
} catch {
  /* first snapshot */
}
const unchanged =
  JSON.stringify(previous?.sources?.map((s) => [s.id, s.url, s.sha256])) ===
  JSON.stringify(entries.map((s) => [s.id, s.url, s.sha256]));
await writeFile(
  "third_party/filters/sources.lock.json",
  JSON.stringify(
    {
      schema: 1,
      updated: unchanged ? previous.updated : new Date().toISOString(),
      engine: `@ghostery/adblocker@${JSON.parse(await readFile("node_modules/@ghostery/adblocker/package.json", "utf8")).version}`,
      registry: "https://github.com/gorhill/uBlock/blob/master/assets/assets.json",
      sources: entries,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Pinned ${entries.length} official sources; review source headers and diff before merging.`,
);
