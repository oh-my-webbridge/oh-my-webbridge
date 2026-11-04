import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { pushBotBranch } from "./release.mjs";
const exec = promisify(execFile);
const run = async (cmd, args, options = {}) => (await exec(cmd, args, options)).stdout.trim();
const repo = process.env.GITHUB_REPOSITORY ?? "oh-my-webbridge/oh-my-webbridge";
const branch = "maintenance/filter-lists";
const existing = JSON.parse(
  await run("gh", ["pr", "list", "--repo", repo, "--head", branch, "--json", "number"]),
);
if (existing.length) {
  console.log("A filter refresh PR is already awaiting review; preserve it.");
  process.exit(0);
}
await run(process.execPath, ["scripts/update-filters.mjs"]);
if (!(await run("git", ["status", "--porcelain", "--", "third_party/filters"]))) {
  console.log("Filter sources unchanged");
  process.exit(0);
}
// Each refresh adds its own fragment, named after the snapshot date, so a
// pending refresh on main does not hide this one. A same-day snapshot takes the
// next free numeric suffix.
const date = JSON.parse(
  await readFile("third_party/filters/sources.lock.json", "utf8"),
).updated.slice(0, 10);
const pending = new Set(await readdir(".changeset"));
let fragment = `filter-refresh-${date}.md`;
for (let n = 2; pending.has(fragment); n++) fragment = `filter-refresh-${date}-${n}.md`;
await writeFile(
  `.changeset/${fragment}`,
  `---\n"oh-my-webbridge": patch\n---\n\n# Refresh bundled protection rules (${date} snapshot)\n\nUpdate pinned official filter sources and their include closure. Existing installations change only after installing the reviewed release; runtime rule downloads remain disabled. Inspect the source hashes and browser smoke results before merging.\n`,
);
await run("pnpm", ["run", "format"]);
await run("pnpm", ["run", "build"]);
await run("git", ["add", "third_party/filters", `.changeset/${fragment}`]);
const title = `chore(filters): refresh pinned protection lists (${date})`;
await pushBotBranch(branch, title);
await writeFile(
  "dist/filter-pr.md",
  "Refresh the pinned official filter source snapshot and include closure. Lists compile offline and existing installations update only with a release. Review changed hashes, compiled rule counts and browser compatibility before merging.\n\nBuild and integrity checks passed during preparation. Full CI is dispatched on this branch.\n",
);
await run("gh", [
  "pr",
  "create",
  "--repo",
  repo,
  "--head",
  branch,
  "--base",
  "main",
  "--title",
  title,
  "--body-file",
  "dist/filter-pr.md",
  "--draft",
]);
await run("gh", ["workflow", "run", "ci.yml", "--ref", branch]);
console.log(`Prepared ${title} on ${branch} as .changeset/${fragment}`);
