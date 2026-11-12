import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfm } from "micromark-extension-gfm";
import { parseFragment } from "parse5";
const exec = promisify(execFile);
const repository = "https://github.com/oh-my-webbridge/oh-my-webbridge";
// The documentation site, built from docs/content/docs. A page path is the
// file name without its extension; a heading's anchor is its slug.
export const documentation = "https://oh-my-webbridge.github.io/en";
const cli = resolve("node_modules/@changesets/cli/bin.js");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
// The Chrome and Firefox extension manifests carry the package version.
const manifestFiles = ["extension/manifest.json", "extension/manifest.firefox.json"];
// GitHub renders release notes and CHANGELOG.md as GitHub Flavored Markdown;
// in particular, it splits table cells at pipes before parsing their content.
const parseMarkdown = (markdown) =>
  fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
const publishedFiles = new Set([
  "Makefile",
  "README.md",
  "THIRD_PARTY.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "go.mod",
  "go.sum",
  ".github/workflows/benchmark.yml",
  ".github/workflows/package.yml",
  ".github/workflows/release.yml",
]);
const isFragment = (file) =>
  /^\.changeset\/[^/]+\.md$/u.test(file) && file !== ".changeset/README.md";

// Fragment headings sit below the version (H2) and change-type (H3) headings.
// Lower parsed H1-H3 headings by three levels so the version section and
// release notes keep their boundaries; code and other text stay unchanged.
function lowerHeadings(markdown) {
  const headings = [];
  const collect = (node) => {
    if (node.type === "heading" && node.depth <= 3) headings.push(node);
    else for (const child of node.children ?? []) collect(child);
  };
  collect(parseMarkdown(markdown));
  let text = markdown;
  for (const heading of headings.reverse()) {
    const { start, end } = heading.position;
    const depth = heading.depth + 3;
    // ATX headings occupy one line and start with their markers; setext
    // headings have no deeper form, so they are rewritten as ATX.
    const lowered =
      start.line === end.line
        ? "#".repeat(depth) + text.slice(start.offset + heading.depth, end.offset)
        : toMarkdown({ ...heading, depth }, { extensions: [gfmToMarkdown()] }).trimEnd();
    text = text.slice(0, start.offset) + lowered + text.slice(end.offset);
  }
  return text;
}

// parse5 follows the browser HTML parser, so a comment ends where a browser
// ends it, including at "--!>", and several comments may share a line. Stray
// end tags produce no node, so the nodes must also cover the whole value.
function onlyComments(html) {
  let end = 0;
  for (const node of parseFragment(html, { sourceCodeLocationInfo: true }).childNodes) {
    const { startOffset, endOffset } = node.sourceCodeLocation;
    const blank = node.nodeName === "#text" && !node.value.trim();
    if (startOffset !== end || (node.nodeName !== "#comment" && !blank)) return false;
    end = endOffset;
  }
  return end === html.length;
}

// Release notes and CHANGELOG.md place fragments one after another. A comment
// or <pre> block left open ends only at its closing marker, and an element such
// as <details> stays open after its Markdown block ends; either would continue
// into the following fragments, the Downloads section and older releases. So a
// fragment must close every block it opens, and its raw HTML is limited to
// comments. Link reference definitions and footnote labels apply to the whole
// document, where the first definition of a label wins, so fragments define
// none. lineOffset maps body lines to lines of the fragment file.
function checkFragmentBody(file, markdown, lineOffset) {
  const tree = parseMarkdown(`${markdown}\n\n# boundary\n`);
  const at = (node) => `${file}:${node.position.start.line + lineOffset}`;
  const last = tree.children.at(-1);
  const closed =
    last.type === "heading" &&
    last.depth === 1 &&
    last.children.length === 1 &&
    last.children[0].type === "text" &&
    last.children[0].value === "boundary";
  if (!closed)
    throw Error(`${at(last)}: close the block opened here; the following notes would be inside it`);
  const visit = (node) => {
    if (node.type === "html" && !onlyComments(node.value))
      throw Error(
        `${at(node)}: raw HTML is limited to <!-- comments -->; write ${JSON.stringify(node.value.split("\n")[0])} as Markdown`,
      );
    if (node.type === "definition")
      throw Error(
        `${at(node)}: link reference definitions apply to all release notes; write [${node.label}] as an inline [text](url) link`,
      );
    if (node.type === "footnoteDefinition")
      throw Error(
        `${at(node)}: footnotes apply to all release notes; write the [^${node.label}] note in the text`,
      );
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

// Fragment files are checked as written, before Changesets consumes them.
async function checkFragments() {
  const names = (await readdir(".changeset")).filter((n) => n.endsWith(".md") && n !== "README.md");
  for (const name of names) {
    const text = await readFile(`.changeset/${name}`, "utf8");
    const header = text.match(
      /^---\n"oh-my-webbridge": (?:patch|minor|major)\n---\n(?=\n# [^\n]+\n)/u,
    );
    if (!header) throw Error(`${name}: use a package bump and a user-facing heading`);
    checkFragmentBody(
      `.changeset/${name}`,
      text.slice(header[0].length),
      header[0].split("\n").length - 1,
    );
  }
  return names;
}

export function renderNotes(plan, release) {
  const groups = {
    major: "Breaking changes",
    minor: "New capabilities",
    patch: "Improvements and fixes",
  };
  const lines = [];
  for (const type of Object.keys(groups)) {
    const entries = plan.changesets.filter((c) =>
      c.releases.some((r) => r.name === release.name && r.type === type),
    );
    if (!entries.length) continue;
    lines.push(`### ${groups[type]}`, "");
    for (const entry of entries.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(lowerHeadings(entry.summary.trim()), "");
    }
  }
  lines.push(
    "### Downloads",
    "",
    "Choose the native archive for macOS or Linux and your CPU. All release archives use `.tar.zst` with zstd level 3. Install zstd and verify `SHA256SUMS`, then extract with `zstd -dc archive.tar.zst | tar -xf - -C destination`. Load the extracted Chrome MV3 directory in Chrome. The agent kit includes the SDK and guide.",
    "",
    `The release workflow submits \`omw-${release.newVersion}-chrome-mv3.zip\` to the Chrome Web Store and the unsigned add-on to addons.mozilla.org; each store publishes the version after its review.`,
    "",
    `Firefox release builds install \`omw-${release.newVersion}-firefox-mv3-unsigned.xpi\` permanently only after it is signed. For development, load the extracted Firefox MV3 directory as a temporary add-on in \`about:debugging\`. See [Firefox installation](${documentation}/firefox/#install).`,
    "",
    "Browser benchmarks report interface costs on a deterministic fixture; they do not establish real-site reliability. Platform acceptance and remaining differences are recorded in the repository.",
  );
  return lines.join("\n") + "\n";
}

// Version sections are delimited by parsed top-level H2 headings, so lines
// starting with "## " inside code or HTML blocks stay part of the notes.
function versionHeading(changelog, version) {
  const title = new RegExp(`^## \\[?${version.replaceAll(".", "\\.")}(?:\\]|\\s|$)`, "u");
  const headings = parseMarkdown(changelog).children.filter(
    (node) => node.type === "heading" && node.depth === 2,
  );
  const index = headings.findIndex((h) =>
    title.test(changelog.slice(h.position.start.offset, h.position.end.offset)),
  );
  return { heading: headings[index], next: headings[index + 1] };
}

export const hasRelease = (changelog, version) =>
  versionHeading(changelog, version).heading !== undefined;

export function releaseSection(changelog, version) {
  const { heading, next } = versionHeading(changelog, version);
  if (!heading) throw Error(`CHANGELOG.md has no release ${version}`);
  const body = changelog.slice(heading.position.end.offset, next?.position.start.offset).trim();
  if (!body) throw Error("release notes are empty");
  return body + "\n";
}

// Bot branches are rebuilt from the checked-out main commit as one commit
// holding only the staged, generated changes. Its parent already exists on the
// remote, so the push adds no workflow-file changes and stays within
// GITHUB_TOKEN permissions. The lease is the remote head read just before the
// push, so a concurrent update makes the push fail instead of being replaced.
export async function pushBotBranch(branch, message) {
  const git = async (...args) => (await exec("git", args)).stdout.trim();
  const workflows = await git("diff", "--cached", "--name-only", "HEAD", "--", ".github/workflows");
  if (workflows)
    throw Error(`${branch} must not change workflow files: ${workflows.split("\n").join(", ")}`);
  const ref = `refs/heads/${branch}`;
  const { stdout: commit } = await exec(
    "git",
    ["commit-tree", await git("write-tree"), "-p", await git("rev-parse", "HEAD"), "-m", message],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "github-actions[bot]",
        GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
        GIT_COMMITTER_NAME: "github-actions[bot]",
        GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      },
    },
  );
  const remote = (await git("ls-remote", "origin", ref)).split("\t")[0];
  await git("push", `--force-with-lease=${ref}:${remote}`, "origin", `${commit.trim()}:${ref}`);
  return commit.trim();
}

async function plan() {
  await mkdir("dist", { recursive: true });
  const pending = (await readdir(".changeset")).filter(
    (name) => name.endsWith(".md") && name !== "README.md",
  );
  // Changesets status rejects a dirty version commit after fragments have been
  // consumed. The explicit PR gate below handles missing-fragment validation;
  // a consumed plan is valid and must be idempotent.
  if (!pending.length) {
    const empty = { changesets: [], releases: [] };
    await writeFile("dist/release-plan.json", JSON.stringify(empty, null, 2) + "\n");
    return empty;
  }
  await exec(process.execPath, [cli, "status", "--output", "dist/release-plan.json"]);
  return json("dist/release-plan.json");
}

async function check(base) {
  const p = await json("package.json");
  const manifests = await Promise.all(manifestFiles.map((path) => json(path)));
  const go = (await readFile("internal/bridge/protocol.go", "utf8")).match(
    /const Version = "([^"]+)"/u,
  )?.[1];
  if (
    !/^\d+\.\d+\.\d+$/u.test(p.version) ||
    manifests.some((manifest) => manifest.version !== p.version) ||
    p.version !== go
  )
    throw Error("daemon, extension and package versions must agree");
  if (!p.private) throw Error("the bridge must not be published to npm");
  const names = await checkFragments();
  if (base) {
    // -z keeps non-ASCII paths unquoted. Published inputs use --no-renames so a
    // move counts at both paths; new fragments use rename detection so renaming
    // a pending fragment is not a new one.
    const changed = async (...options) =>
      (await exec("git", ["diff", "--name-only", "-z", ...options, `${base}...HEAD`])).stdout
        .split("\0")
        .filter(Boolean);
    const files = await changed("--no-renames");
    const added = await changed("--no-renames", "--diff-filter=A");
    const deleted = await changed("--no-renames", "--diff-filter=D");
    const newFragments = (await changed("-M", "--diff-filter=A")).filter(isFragment);
    const published = files.filter(
      (f) =>
        publishedFiles.has(f) ||
        /^(?:cmd|internal|extension|sdk|skills|third_party|scripts)\//u.test(f) ||
        (f.startsWith("benchmarks/") && !f.endsWith(".md")),
    );
    const previous = JSON.parse(
      (await exec("git", ["show", `${base}:package.json`])).stdout,
    ).version;
    // Generated version PRs consume fragments and add their release notes.
    const versionPR =
      previous !== p.version &&
      files.includes("CHANGELOG.md") &&
      added.includes(`docs/releases/${p.version}.md`) &&
      deleted.some(isFragment);
    if (published.length && !newFragments.length && !versionPR)
      throw Error(
        `user-visible changes need a new .changeset/*.md fragment: ${published.join(", ")}`,
      );
  }
  await plan();
  console.log(`Release metadata and ${names.length} change fragments verified (${p.version})`);
}

async function version() {
  const p = await json("package.json");
  const releasePlan = await plan();
  const release = releasePlan.releases.find((r) => r.name === p.name);
  if (!release) {
    console.log("No pending release");
    return;
  }
  // Version PRs are generated without running check first.
  await checkFragments();
  const previous = await readFile("CHANGELOG.md", "utf8");
  const notes = renderNotes(releasePlan, release);
  await exec(process.execPath, [cli, "version"]);
  const next = await json("package.json");
  if (next.version !== release.newVersion)
    throw Error("Changesets version differs from release plan");
  for (const path of manifestFiles) {
    const manifest = await json(path);
    manifest.version = next.version;
    await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
  }
  const go = await readFile("internal/bridge/protocol.go", "utf8");
  await writeFile(
    "internal/bridge/protocol.go",
    go.replace(/const Version = "[^"]+"/u, `const Version = "${next.version}"`),
  );
  // The first release has no earlier tag to compare with.
  const link = hasRelease(previous, p.version)
    ? `${repository}/compare/v${p.version}...v${next.version}`
    : `${repository}/releases/tag/v${next.version}`;
  const heading = `## [${next.version}](${link})`;
  await writeFile(
    "CHANGELOG.md",
    previous.replace(/^# Changelog\n*/u, `# Changelog\n\n${heading}\n\n${notes}\n`),
  );
  await mkdir("docs/releases", { recursive: true });
  await writeFile(`docs/releases/${next.version}.md`, `# ${next.version}\n\n${notes}`);
  await check();
  console.log(`Prepared ${next.version}; review CHANGELOG.md before tagging`);
}

async function main() {
  const [command = "check", argument] = process.argv.slice(2);
  if (command === "plan") console.log(JSON.stringify(await plan(), null, 2));
  else if (command === "version") await version();
  else if (command === "check") await check(argument);
  else if (command === "notes") {
    const p = await json("package.json");
    process.stdout.write(
      releaseSection(await readFile("CHANGELOG.md", "utf8"), argument ?? p.version),
    );
  } else throw Error("use plan, version, check [base], or notes [version]");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
