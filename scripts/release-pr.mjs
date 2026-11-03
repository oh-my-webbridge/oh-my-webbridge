import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { hasRelease, pushBotBranch } from "./release.mjs";
const exec = promisify(execFile);
const run = async (command, args, options = {}) =>
  (await exec(command, args, options)).stdout.trim();
const repo = process.env.GITHUB_REPOSITORY ?? "oh-my-webbridge/oh-my-webbridge";
const branch = "release/next";
const head = await run("git", ["rev-parse", "HEAD"]);
const version = JSON.parse(await readFile("package.json", "utf8")).version;

async function tagExists(tag) {
  try {
    await run("gh", ["api", `repos/${repo}/git/ref/tags/${tag}`]);
    return true;
  } catch (error) {
    if (!String(error.stderr).includes("404")) throw error;
    return false;
  }
}

async function onMain(commit) {
  await run("git", ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  try {
    await run("git", ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"]);
    return true;
  } catch (error) {
    if (error.code !== 1) throw error;
    return false;
  }
}

// The current version is tagged before the next one is prepared, so a version
// PR merged while newer fragments were already on main still gets its tag.
// The tag points at the merged version commit; squash merges append "(#N)".
async function tagMergedVersion() {
  const tag = `v${version}`;
  if (await tagExists(tag)) {
    console.log(`${tag} already exists; release tags are immutable`);
    return;
  }
  if (!hasRelease(await readFile("CHANGELOG.md", "utf8"), version)) {
    console.log(`CHANGELOG.md has no ${version} release; nothing to tag`);
    return;
  }
  const title = `chore(release): prepare ${version}`;
  const merged = new RegExp(`^${title.replace(/[().]/gu, "\\$&")}(?: \\(#\\d+\\))?$`, "u");
  const commits = (await run("git", ["log", "--format=%H %s", "HEAD"]))
    .split("\n")
    .filter((line) => merged.test(line.slice(line.indexOf(" ") + 1)))
    .map((line) => line.slice(0, line.indexOf(" ")));
  if (commits.length !== 1)
    throw Error(
      `${tag} needs one merged "${title}" commit on ${head}, found ${commits.length}${commits.length ? `: ${commits.join(", ")}` : ""}; create and dispatch the tag manually`,
    );
  const [commit] = commits;
  const prepared = JSON.parse(await run("git", ["show", `${commit}:package.json`])).version;
  if (prepared !== version) throw Error(`${commit} "${title}" sets version ${prepared}`);
  // A run on another branch, such as a dispatch on release/next, must not tag
  // a version PR that has not been merged.
  if (!(await onMain(commit))) {
    console.log(`${tag} is not tagged: ${commit} is not on origin/main`);
    return;
  }
  // The version commit consumed every fragment. A squash or rebase merge made
  // while main already had newer fragments creates a commit that also contains
  // those changes, which the version's notes do not describe.
  const pending = (await run("git", ["ls-tree", "--name-only", `${commit}:.changeset`]))
    .split("\n")
    .filter((name) => name.endsWith(".md") && name !== "README.md");
  if (pending.length)
    throw Error(
      `${tag} is not tagged: ${commit} "${title}" still contains pending fragments ${pending.map((name) => `.changeset/${name}`).join(", ")}, so it includes changes its notes omit. A version PR behind main must be merged with a merge commit, or updated by the version workflow before merging. Tag the reviewed version PR head commit manually and dispatch release.yml to publish ${version}.`,
    );
  await run(process.execPath, ["scripts/release.mjs", "notes", version]);
  await run("gh", [
    "api",
    `repos/${repo}/git/refs`,
    "--method",
    "POST",
    "-f",
    `ref=refs/tags/${tag}`,
    "-f",
    `sha=${commit}`,
  ]);
  await run("gh", ["workflow", "run", "release.yml", "--ref", tag]);
  console.log(`Dispatched verified release pipeline for ${tag} at ${commit}`);
}

if (process.env.OMW_CREATE_TAG === "true") await tagMergedVersion();
await run(process.execPath, ["scripts/release.mjs", "plan"]);
const plan = JSON.parse(await readFile("dist/release-plan.json", "utf8"));
const release = plan.releases.find((r) => r.name === "oh-my-webbridge");
if (!release) {
  console.log("No pending change fragments");
  process.exit(0);
}
await run(process.execPath, ["scripts/release.mjs", "version"]);
await run("pnpm", ["run", "format"]);
await run("pnpm", ["run", "build"]);
await run("pnpm", ["run", "release:check"]);
await run("git", ["add", "."]);
const title = `chore(release): prepare ${release.newVersion}`;
await pushBotBranch(branch, title);
const body = `## Summary\n\nPrepare ${release.newVersion} from reviewed change fragments. Package, daemon and MV3 versions are synchronized; grouped release notes retain user-facing headings and PR links.\n\n## Verification\n\nVersion preparation, formatting, build and release metadata checks passed in the preparation job. Full checks are dispatched on this branch. Merge this PR to create the version tag and start the gated release pipeline.\n`;
await mkdir("dist", { recursive: true });
await writeFile("dist/version-pr.md", body);
const prs = JSON.parse(
  await run("gh", ["pr", "list", "--repo", repo, "--head", branch, "--json", "number"]),
);
if (prs[0])
  await run("gh", [
    "pr",
    "edit",
    String(prs[0].number),
    "--repo",
    repo,
    "--title",
    title,
    "--body-file",
    "dist/version-pr.md",
  ]);
else
  await run("gh", [
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    title,
    "--body-file",
    "dist/version-pr.md",
    "--draft",
  ]);
// GITHUB_TOKEN-created PRs do not emit another pull_request workflow run.
await run("gh", ["workflow", "run", "ci.yml", "--ref", branch]);
console.log(`Prepared ${release.newVersion} on ${branch} from ${head}`);
