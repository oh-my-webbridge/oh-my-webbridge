import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withTarZst } from "./archive.mjs";
import { firefoxAddonId, startFirefox } from "./firefox-bidi.mjs";
const exec = promisify(execFile);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "amd64";
const dir = await mkdtemp(join(tmpdir(), "omw-install-"));
let installed;
let firefox;
try {
  await withTarZst(resolve(`dist/release/omw-${version}-${os}-${arch}.tar.zst`), (tar) =>
    exec("tar", ["-xf", tar, "-C", dir]),
  );
  const bin = join(dir, "bin/omw");
  installed = bin;
  const options = { env: { ...process.env, OMW_HOME: join(dir, "home") }, timeout: 15000 };
  const result = await exec(bin, ["version"], options);
  if (!result.stdout.includes(version)) throw Error(`wrong native version: ${result.stdout}`);
  await exec(bin, ["start"], options);
  const status = await exec(bin, ["status"], options);
  if (!status.stdout.includes(version)) throw Error("installed daemon status failed");
  await exec(bin, ["stop"], options);
  console.log(`Native install/start/status/stop passed: ${os}/${arch} ${version}`);
  // Release Firefox installs unsigned add-ons only temporarily, which is what
  // this checks: the packaged .xpi installs and its pages load this version.
  firefox = await startFirefox({ dir: join(dir, "firefox") });
  const addon = await firefox.installExtension({
    type: "archivePath",
    path: resolve(`dist/release/omw-${version}-firefox-mv3-unsigned.xpi`),
  });
  if (addon !== firefoxAddonId)
    throw Error(`installed add-on ${addon}, expected ${firefoxAddonId}`);
  const page = await firefox.openExtensionPage("popup.html");
  const loaded = await firefox.evaluate(page, "chrome.runtime.getManifest().version");
  if (loaded !== version)
    throw Error(`Firefox loaded add-on version ${loaded}, expected ${version}`);
  console.log(`Firefox ${firefox.version} installed the unsigned add-on ${version}`);
} finally {
  if (firefox) console.log(`Firefox: ${await firefox.close()}`);
  if (installed)
    await exec(installed, ["stop"], {
      env: { ...process.env, OMW_HOME: join(dir, "home") },
      timeout: 5000,
    }).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
