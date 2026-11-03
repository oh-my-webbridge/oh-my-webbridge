import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { FiltersEngine } from "@ghostery/adblocker";
export async function compileFilters() {
  const lock = JSON.parse(await readFile("third_party/filters/sources.lock.json", "utf8"));
  const installed = JSON.parse(
    await readFile("node_modules/@ghostery/adblocker/package.json", "utf8"),
  );
  if (lock.engine !== `${installed.name}@${installed.version}`)
    throw Error(
      "filter engine pin differs from installed dependency; refresh and review sources.lock.json",
    );
  const lists = [];
  const raw = new Map();
  let resources;
  for (const source of lock.sources) {
    const zipped = await readFile(`third_party/filters/${source.file}`);
    const bytes = gunzipSync(zipped);
    const sha = (b) => createHash("sha256").update(b).digest("hex");
    if (sha(bytes) !== source.sha256 || sha(zipped) !== source.gzipSha256)
      throw Error(`filter integrity failed: ${source.id}`);
    if (source.id === "resources") resources = { data: bytes.toString(), checksum: source.sha256 };
    else raw.set(source.url, bytes.toString());
  }
  function expand(url, parents = []) {
    if (parents.includes(url)) throw Error(`cyclic filter include ${url}`);
    const text = raw.get(url);
    if (text === undefined) throw Error(`unpinned include ${url}`);
    return text.replace(/^!#include\s+(\S+)\s*$/gmu, (_, path) =>
      expand(new URL(path, url).href, [...parents, url]),
    );
  }
  for (const source of lock.sources)
    if (source.id !== "resources" && !source.includedBy) lists.push(expand(source.url));
  const engine = FiltersEngine.parse(lists.join("\n"), {
    enableCompression: true,
    loadPreprocessors: true,
    loadExtendedSelectors: false,
    enableHtmlFiltering: false,
  });
  engine.updateEnv(
    new Map([
      ["env_chromium", true],
      ["env_mv3", true],
      ["ext_ghostery", true],
      ["ext_ublock", false],
      ["env_firefox", false],
      ["cap_html_filtering", false],
      ["cap_user_stylesheet", false],
    ]),
  );
  if (resources) engine.updateResources(resources.data, resources.checksum);
  const bytes = engine.serialize();
  await mkdir("dist/extension", { recursive: true });
  await writeFile("dist/extension/filters.bin", bytes);
  await writeFile("dist/extension/filter-sources.json", JSON.stringify(lock, null, 2) + "\n");
  // Preserve original list text and license notices for redistributed list data.
  await mkdir("dist/extension/filter-sources", { recursive: true });
  for (const source of lock.sources)
    await writeFile(
      `dist/extension/filter-sources/${source.id}.txt`,
      gunzipSync(await readFile(`third_party/filters/${source.file}`)),
    );
  const filters = engine.getFilters();
  const report = {
    engine: lock.engine,
    bytes: bytes.length,
    network: filters.networkFilters.length,
    cosmetic: filters.cosmeticFilters.length,
    sourceCount: lock.sources.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    limitations: [
      "No HTML/response/CSP modification",
      "No procedural or DOM-dependent cosmetic selectors",
      "Unsupported upstream dialect syntax may be ignored by the engine",
    ],
  };
  await writeFile("dist/extension/filter-report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(report);
  return report;
}
if (process.argv[1]?.endsWith("/compile-filters.mjs")) await compileFilters();
