import { verifyReleaseAssets } from "./release-assets.mjs";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const exec = promisify(execFile);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const tag = `v${version}`;
const repo = process.env.GITHUB_REPOSITORY ?? "oh-my-webbridge/oh-my-webbridge";
const sha = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
if ((await exec("git", ["rev-list", "-n", "1", tag])).stdout.trim() !== sha)
  throw Error("release tag does not point at this checkout");
const files = (await readdir("dist/release")).sort();
const gh = async (...args) => (await exec("gh", args, { maxBuffer: 64 << 20 })).stdout;

// GET releases/tags/{tag} returns only published releases. The release list
// also includes drafts, so first runs and reruns resolve the same release.
async function findRelease() {
  const releases = (await gh("api", `repos/${repo}/releases`, "--paginate", "--jq", ".[]"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.tag_name === tag);
  if (releases.length > 1)
    throw Error(
      `${tag} has ${releases.length} releases (${releases.map((r) => `${r.id}${r.draft ? " draft" : ""}`).join(", ")}); keep one before publishing`,
    );
  return releases[0];
}

// The release list can leave out a draft for some seconds after it is
// created, and gh release upload finds a draft through the same list. Wait
// for the new draft before uploading to it.
async function createdDraft() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const found = await findRelease();
    if (found?.draft) return found;
    await delay(1000);
  }
  throw Error(`created draft for ${tag} is missing from the release list after 30 seconds`);
}

let release = await findRelease();
if (release && !release.draft) {
  // A published release is immutable. Verify its own manifest, not a fresh
  // rebuild containing new benchmark dates or archive timestamps.
  const asset = release.assets.find((a) => a.name === "SHA256SUMS");
  if (!asset) throw Error(`published release ${tag} (${release.id}) has no SHA256SUMS`);
  const sums = await gh(
    "api",
    `repos/${repo}/releases/assets/${asset.id}`,
    "-H",
    "Accept: application/octet-stream",
  );
  verifyReleaseAssets(release.assets, sums);
  console.log(`Verified existing immutable release ${tag}`);
  process.exit(0);
}
if (!release) {
  await gh(
    "release",
    "create",
    tag,
    "--verify-tag",
    "--target",
    sha,
    "--draft",
    "--title",
    version,
    "--notes-file",
    `docs/releases/${version}.md`,
  );
  release = await createdDraft();
}
const id = release.id;
await gh(
  "release",
  "upload",
  tag,
  ...files.map((name) => resolve("dist/release", name)),
  "--clobber",
);
const draft = JSON.parse(await gh("api", `repos/${repo}/releases/${id}`));
verifyReleaseAssets(draft.assets, await readFile("dist/release/SHA256SUMS", "utf8"), files);
const published = JSON.parse(
  await gh(
    "api",
    "--method",
    "PATCH",
    `repos/${repo}/releases/${id}`,
    "-F",
    "draft=false",
    "-f",
    "make_latest=true",
  ),
);
if (published.draft) throw Error(`release ${id} for ${tag} is still a draft after publishing`);
console.log(`Published and verified ${tag}: ${published.html_url}`);
