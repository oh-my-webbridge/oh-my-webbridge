import { appendFile, chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

// Installs the latest Firefox release from Mozilla's release archive for test
// runs. SHA512SUMS must carry a valid signature from the pinned Mozilla release
// key, and the download must match its SHA-512 entry.
const exec = promisify(execFile);
await exec("gpg", ["--version"]).catch((error) => {
  throw Error(`gpg is required to verify Firefox SHA512SUMS signatures: ${error.message}`);
});
const releaseKey = "14F26682D0916CDD81E37B6D61B7B526D98F0353";
const archive = "https://archive.mozilla.org/pub/firefox/releases/";
// Returns the percent-encoded URL; the macOS image name contains a space.
const official = (url) => {
  const { protocol, hostname, href } = new URL(url);
  if (protocol !== "https:" || !(hostname === "mozilla.org" || hostname.endsWith(".mozilla.org")))
    throw Error(`refusing a non-Mozilla download: ${url}`);
  return href;
};
const download = (url, file) =>
  exec("curl", [
    "-fsSL",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--retry",
    "3",
    "--max-time",
    "600",
    official(url),
    "-o",
    file,
  ]);

const details = "https://product-details.mozilla.org/1.0/firefox_versions.json";
const version = (await (await fetch(official(details))).json()).LATEST_FIREFOX_VERSION;
if (!/^\d+\.\d+(?:\.\d+)?$/u.test(version))
  throw Error(`unexpected Firefox release version from ${details}: ${version}`);
const asset =
  process.platform === "darwin"
    ? `mac/en-US/Firefox ${version}.dmg`
    : process.platform === "linux" && process.arch === "x64"
      ? `linux-x86_64/en-US/firefox-${version}.tar.xz`
      : process.platform === "linux" && process.arch === "arm64"
        ? `linux-aarch64/en-US/firefox-${version}.tar.xz`
        : undefined;
if (!asset) throw Error(`no Firefox test build for ${process.platform}/${process.arch}`);
const release = `${archive}${version}/`;
const root = join(process.env.RUNNER_TEMP, "omw-test-firefox");
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
for (const file of ["KEY", "SHA512SUMS", "SHA512SUMS.asc"])
  await download(`${release}${file}`, join(root, file));

// GnuPG reports the primary key fingerprint as the last VALIDSIG field.
const gnupg = await mkdtemp(join(root, "gnupg-"));
await chmod(gnupg, 0o700);
const gpg = (...args) => exec("gpg", ["--homedir", gnupg, "--batch", "--no-tty", ...args]);
await gpg("--import", join(root, "KEY"));
const { stdout: status } = await gpg(
  "--status-fd",
  "1",
  "--verify",
  join(root, "SHA512SUMS.asc"),
  join(root, "SHA512SUMS"),
);
const signer = status.match(/^\[GNUPG:\] VALIDSIG .* ([0-9A-F]{40})$/mu)?.[1];
if (signer !== releaseKey)
  throw Error(`SHA512SUMS for ${version} is not signed by ${releaseKey}: ${status.trim()}`);
await rm(gnupg, { recursive: true, force: true });

const sums = await readFile(join(root, "SHA512SUMS"), "utf8");
const expected = sums
  .split("\n")
  .find((line) => line.slice(130) === asset)
  ?.slice(0, 128);
if (!expected) throw Error(`SHA512SUMS for ${version} has no entry for ${asset}`);
const packaged = join(root, asset.split("/").at(-1));
await download(`${release}${asset}`, packaged);
const hash = createHash("sha512");
for await (const chunk of createReadStream(packaged)) hash.update(chunk);
const actual = hash.digest("hex");
if (actual !== expected)
  throw Error(`${asset} SHA-512 ${actual} does not match SHA512SUMS ${expected}`);

let binary;
if (process.platform === "darwin") {
  const mount = await mkdtemp(join(root, "mount-"));
  await exec("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, packaged]);
  try {
    await exec("ditto", [join(mount, "Firefox.app"), join(root, "Firefox.app")]);
  } finally {
    await exec("hdiutil", ["detach", mount]);
  }
  await rm(mount, { recursive: true, force: true });
  binary = join(root, "Firefox.app/Contents/MacOS/firefox");
} else {
  await exec("tar", ["-xJf", packaged, "-C", root]);
  binary = join(root, "firefox/firefox");
}
await rm(packaged);
const { stdout: reported } = await exec(binary, ["--version"], {
  env: { ...process.env, MOZ_NO_REMOTE: "1", MOZ_HEADLESS: "1" },
});
if (!reported.includes(version))
  throw Error(`${binary} reports ${reported.trim()}, expected ${version}`);
await appendFile(process.env.GITHUB_ENV, `FIREFOX_BIN=${resolve(binary)}\n`);
console.log(`Firefox ${version} (${asset}), SHA512SUMS signed by ${releaseKey}`);
