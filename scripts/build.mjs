import { compileFilters } from "./compile-filters.mjs";
import { Resvg } from "@resvg/resvg-js";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const version = JSON.parse(await readFile("package.json", "utf8")).version;
const sourceManifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const firefoxManifest = JSON.parse(await readFile("extension/manifest.firefox.json", "utf8"));
const goVersion = (await readFile("internal/bridge/protocol.go", "utf8")).match(
  /const Version = "([^"]+)"/u,
)?.[1];
if (
  sourceManifest.version !== version ||
  firefoxManifest.version !== version ||
  goVersion !== version
)
  throw Error("package, Chrome and Firefox extension, and daemon versions must match");

// Full license texts required by the redistributed filter lists (THIRD_PARTY.md).
// They are kept in the repository, so the build stays offline.
const listLicenses = [];
for (const { file, sha256 } of JSON.parse(
  await readFile("third_party/licenses/sources.json", "utf8"),
)) {
  const text = await readFile(join("third_party/licenses", file));
  if (createHash("sha256").update(text).digest("hex") !== sha256)
    throw Error(`license text integrity failed: ${file}`);
  listLicenses.push({ file, text });
}
// Copies the license texts of the filter lists and the license files of every
// npm package bundled into a build.
async function bundledLicenses(inputs, outdir) {
  await mkdir(join(outdir, "licenses"), { recursive: true });
  await cp(
    "node_modules/@ghostery/adblocker/LICENSE",
    join(outdir, "licenses/ghostery-MPL-2.0.txt"),
  );
  for (const { file, text } of listLicenses) await writeFile(join(outdir, "licenses", file), text);
  // The extension pages compile in the coss UI component sources.
  await cp("extension/ui/src/components/ui/LICENSE", join(outdir, "licenses/coss-ui-MIT.txt"));
  const packages = new Set();
  for (const input of inputs) {
    if (!input.includes("node_modules/")) continue;
    let dir = dirname(resolve(input));
    while (dir !== dirname(dir)) {
      try {
        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
        if (pkg.name) {
          packages.add(dir);
          break;
        }
      } catch {
        /* find package root */
      }
      dir = dirname(dir);
    }
  }
  const bundled = [];
  for (const dir of packages) {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const target = join(outdir, "licenses", pkg.name.replaceAll("/", "-"));
    const files = (await readdir(dir)).filter((file) => /^(license|copying|notice)/iu.test(file));
    bundled.push({ name: pkg.name, version: pkg.version, files: files.sort() });
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "package.json"),
      JSON.stringify(
        { name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository },
        null,
        2,
      ) + "\n",
    );
    for (const file of files) await cp(join(dir, file), join(target, file), { recursive: true });
  }
  // The release audit checks the license files of every bundled package listed here.
  await writeFile(
    join(outdir, "licenses/packages.json"),
    JSON.stringify(
      bundled.sort((a, b) => a.name.localeCompare(b.name)),
      null,
      2,
    ) + "\n",
  );
}
async function hashes(outdir, files, output) {
  const result = {};
  for (const file of files)
    result[file] = createHash("sha256")
      .update(await readFile(join(outdir, file)))
      .digest("hex");
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
}
async function checkManifest(outdir) {
  const manifest = JSON.parse(await readFile(join(outdir, "manifest.json"), "utf8"));
  if (manifest.side_panel || manifest.content_scripts)
    throw new Error("extension must have no sidebar or resident content scripts");
}

// Toolbar and app icons rendered from the brand SVGs (packages/brand/icons).
async function icons(outdir) {
  await mkdir(join(outdir, "icons"), { recursive: true });
  const render = async (name, sizes) => {
    const svg = await readFile(`packages/brand/icons/${name}.svg`);
    for (const size of sizes) {
      const png = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
      await writeFile(join(outdir, "icons", `${name}-${size}.png`), png);
    }
  };
  await render("mark", [16, 32, 48, 128]);
  for (const state of ["connected", "live", "offline", "error", "paused"])
    await render(`toolbar-${state}`, [16, 32]);
}

// The popup and app pages (extension/ui). The Vite build lists the npm modules
// it bundled, so their licenses ship with the extension.
const ui = "dist/extension-ui";
await promisify(execFile)(
  process.execPath,
  [resolve("extension/ui/node_modules/vite/bin/vite.js"), "build", "--logLevel", "warn"],
  { cwd: "extension/ui" },
);
const uiModules = JSON.parse(await readFile(join(ui, "bundled-modules.json"), "utf8"));
await rm(join(ui, "bundled-modules.json"));
const uiFiles = (await readdir(ui, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name).slice(ui.length + 1))
  .sort();
async function pages(outdir) {
  await cp(ui, outdir, { recursive: true });
  await cp("extension/_locales", join(outdir, "_locales"), { recursive: true });
  await icons(outdir);
}

const firefox = "dist/extension-firefox";
for (const dir of ["dist/extension", firefox]) await rm(dir, { recursive: true, force: true });
await mkdir("dist/extension", { recursive: true });
await compileFilters();
const extensionBuild = await build({
  metafile: true,
  entryPoints: ["extension/src/worker.ts"],
  outdir: "dist/extension",
  bundle: true,
  format: "esm",
  target: "chrome156",
  minify: true,
  sourcemap: false,
});
await bundledLicenses(
  [...Object.keys(extensionBuild.metafile.inputs), ...uiModules],
  "dist/extension",
);
await cp("extension/manifest.json", "dist/extension/manifest.json");
await pages("dist/extension");

// Firefox: the same pages and filter lists, a webRequest/scripting background,
// and page.js, which the background injects into documents on demand.
await mkdir(firefox, { recursive: true });
const firefoxBuild = await build({
  metafile: true,
  entryPoints: { worker: "extension/src/firefox/worker.ts" },
  outdir: firefox,
  bundle: true,
  format: "esm",
  target: "firefox153",
  minify: true,
  sourcemap: false,
});
await build({
  entryPoints: { page: "extension/src/firefox/page.ts" },
  outdir: firefox,
  bundle: true,
  format: "iife",
  target: "firefox153",
  minify: true,
  sourcemap: false,
});
await bundledLicenses([...Object.keys(firefoxBuild.metafile.inputs), ...uiModules], firefox);
await cp("extension/manifest.firefox.json", join(firefox, "manifest.json"));
await pages(firefox);
for (const file of ["filters.bin", "filter-sources.json", "filter-report.json", "filter-sources"])
  await cp(join("dist/extension", file), join(firefox, file), { recursive: true });

await build({
  entryPoints: ["sdk/index.ts"],
  outfile: "dist/sdk.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
});
await checkManifest("dist/extension");
await checkManifest(firefox);
const shared = ["manifest.json", ...uiFiles, "filters.bin", "filter-sources.json"];
await hashes("dist/extension", ["worker.js", ...shared], "dist/extension.sha256.json");
await hashes(firefox, ["worker.js", "page.js", ...shared], "dist/extension-firefox.sha256.json");
