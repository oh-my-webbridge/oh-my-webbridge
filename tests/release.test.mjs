import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { fromMarkdown } from "mdast-util-from-markdown";
import { renderNotes, releaseSection } from "../scripts/release.mjs";
import { packTarZst, withTarZst } from "../scripts/archive.mjs";

const fixtureEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Release fixtures start at version 0.1.1 with an empty changelog, whatever
// version the checkout is at, so a version PR branch passes the same tests.
async function releaseBaseline(dir, files) {
  for (const file of files) {
    const path = join(dir, file);
    if (file === "CHANGELOG.md") await writeFile(path, "# Changelog\n");
    else if (file === "internal/bridge/protocol.go") {
      const source = await readFile(path, "utf8");
      await writeFile(path, source.replace(/const Version = "[^"]+"/u, 'const Version = "0.1.1"'));
    } else if (file === "package.json" || file.startsWith("extension/manifest")) {
      const value = JSON.parse(await readFile(path, "utf8"));
      value.version = "0.1.1";
      await writeFile(path, JSON.stringify(value, null, 2) + "\n");
    }
  }
}

async function scriptFixture(t, prefix, files) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of files) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await cp(file, join(dir, file));
  }
  await releaseBaseline(dir, files);
  const write = async (file, data) => {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), data);
  };
  // Resolve with the exit status so assertions can report the observed output.
  const run = (cmd, args, env = {}) =>
    promisify(execFile)(cmd, args, {
      cwd: dir,
      env: { ...fixtureEnv, ...env },
      maxBuffer: 16 << 20,
    }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
  return { dir, write, run };
}

test("zstd release archives preserve installed files and reject failed or corrupt archives", async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, readdir, stat, chmod, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const work = await mkdtemp(join(tmpdir(), "omw-zstd-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const source = join(work, "source files");
  const output = join(work, "installed files");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(output);
  const bytes = Buffer.from([0, 255, 10, 128, 13]);
  await writeFile(join(source, "bin/omw"), bytes);
  await chmod(join(source, "bin/omw"), 0o755);
  await writeFile(join(source, "说明.txt"), "Archive fixture\n");
  const archive = join(work, "release bundle.tar.zst");
  await packTarZst(archive, source, ["bin", "说明.txt"]);
  assert.deepEqual((await readFile(archive)).subarray(0, 4), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  await exec("zstd", ["--test", "--quiet", archive]);
  await withTarZst(archive, (tar) => exec("tar", ["-xf", tar, "-C", output]));
  assert.deepEqual(await readFile(join(output, "bin/omw")), bytes);
  assert.equal((await stat(join(output, "bin/omw"))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(output, "说明.txt"), "utf8"), "Archive fixture\n");

  const previous = await readFile(archive);
  await assert.rejects(packTarZst(archive, source, ["missing-file"]));
  assert.deepEqual(await readFile(archive), previous);
  assert.equal(
    (await readdir(work)).some((name) => name.startsWith(".omw-archive-")),
    false,
  );
  await writeFile(archive, "corrupt archive");
  await assert.rejects(
    withTarZst(archive, () => assert.fail("corrupt input must not be inspected")),
  );
});

test("release notes retain user headings, links and migration text without hashes", () => {
  const release = { name: "oh-my-webbridge", newVersion: "0.2.0" };
  const plan = {
    changesets: [
      {
        id: "first",
        releases: [{ name: release.name, type: "minor" }],
        summary:
          "# Load fewer resources\n\nOpt in per task. ([#3](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/3))",
      },
      {
        id: "second",
        releases: [{ name: release.name, type: "patch" }],
        summary: "# Recover connections\n\nExisting sessions keep their tabs.",
      },
    ],
  };
  const notes = renderNotes(plan, release);
  assert.match(notes, /### New capabilities\n\n#### Load fewer resources/u);
  assert.match(notes, /### Improvements and fixes/u);
  assert.match(notes, /\[#3\]/u);
  assert.doesNotMatch(notes, /first|second/u);
  assert.match(notes, /Load the extracted Chrome MV3 directory in Chrome\./u);
  assert.match(
    notes,
    /install `omw-0\.2\.0-firefox-mv3-unsigned\.xpi` permanently only after it is signed\. For development, load the extracted Firefox MV3 directory as a temporary add-on in `about:debugging`\. See \[Firefox installation\]\(https:\/\/github\.com\/oh-my-webbridge\/oh-my-webbridge\/blob\/v0\.2\.0\/docs\/firefox\.md#installation\)\./u,
  );
  const changelog = `# Changelog\n\n## [0.2.0](https://example.test)\n\n${notes}\n## [0.1.1]\n\nOld notes\n`;
  assert.equal(releaseSection(changelog, "0.2.0"), notes);
  assert.throws(() => releaseSection(changelog, "0.3.0"), /no release/u);
});

test("fragment headings stay inside their version section and code blocks stay intact", () => {
  const release = { name: "oh-my-webbridge", newVersion: "0.2.0" };
  const render = (summary) => {
    const notes = renderNotes(
      {
        changesets: [{ id: "pairing", releases: [{ name: release.name, type: "minor" }], summary }],
      },
      release,
    );
    const changelog = `# Changelog\n\n## [0.2.0](https://example.test)\n\n${notes}\n## [0.1.1]\n\nOld notes\n`;
    assert.equal(releaseSection(changelog, "0.2.0"), notes);
    assert.match(notes, /^#### Pair once per profile$/mu);
    assert.match(notes, /^##### Migration$/mu);
    assert.match(notes, /Re-pair existing profiles\./u);
    assert.match(notes, /### Downloads/u);
    return notes;
  };
  const fenced = render(
    "# Pair once per profile\n\nTokens survive restarts.\n\n## Migration\n\nRe-pair existing profiles.\n\n### Shell\n\n```sh\n# keep this comment\n```",
  );
  assert.match(fenced, /^###### Shell$/mu);
  assert.match(fenced, /^# keep this comment$/mu);
  // A backtick fence cannot carry backticks in its info string: inline code.
  assert.match(
    render(
      "# Pair once per profile\n\n```omw start``` now waits for the daemon.\n\n## Migration\n\nRe-pair existing profiles.",
    ),
    /^```omw start``` now waits for the daemon\.$/mu,
  );
  // A closing fence cannot carry an info string, so ```sh stays code.
  const nested = render(
    "# Pair once per profile\n\n```text\n```sh\n# not a heading\n```\n\n## Migration\n\nRe-pair existing profiles.",
  );
  assert.match(nested, /^```text\n```sh\n# not a heading\n```$/mu);
  // "## " lines inside code and HTML blocks do not end the version section.
  assert.match(
    render(
      "# Pair once per profile\n\nAdd a section:\n\n```yaml\n## Profiles\nprofile: work\n```\n\n## Migration\n\nRe-pair existing profiles.",
    ),
    /^```yaml\n## Profiles\nprofile: work\n```$/mu,
  );
  assert.match(
    render(
      "# Pair once per profile\n\n<div>\n## Not a heading inside HTML\n</div>\n\n## Migration\n\nRe-pair existing profiles.",
    ),
    /^<div>\n## Not a heading inside HTML\n<\/div>$/mu,
  );
  const setext = render(
    "# Pair once per profile\n\nMigration\n---------\n\nRe-pair existing profiles.\n\nShell\nusage\n=====",
  );
  assert.doesNotMatch(setext, /^(?:-+|=+)$/mu);
  assert.match(setext, /^#### Shell&#xA;usage$/mu);
});

test("version preparation consumes fragments and synchronizes all installed components", async (t) => {
  const { mkdtemp, cp, mkdir, symlink, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve, dirname } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "omw-version-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifests = ["extension/manifest.json", "extension/manifest.firefox.json"];
  for (const file of [
    "package.json",
    ...manifests,
    "internal/bridge/protocol.go",
    "CHANGELOG.md",
    "README.md",
    "scripts/release.mjs",
  ]) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await cp(file, join(dir, file));
  }
  await mkdir(join(dir, ".changeset"));
  await cp(".changeset/config.json", join(dir, ".changeset/config.json"));
  await cp(".changeset/README.md", join(dir, ".changeset/README.md"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dir, ".changeset/fixture.md"),
    '---\n"oh-my-webbridge": minor\n---\n\n# Fixture capability\n\nA self-contained release fixture.\n',
  );
  const setVersion = async (file, version) => {
    const value = JSON.parse(await readFile(join(dir, file), "utf8"));
    value.version = version;
    await writeFile(join(dir, file), JSON.stringify(value, null, 2) + "\n");
  };
  for (const file of ["package.json", ...manifests]) await setVersion(file, "0.1.1");
  const protocol = await readFile(join(dir, "internal/bridge/protocol.go"), "utf8");
  await writeFile(
    join(dir, "internal/bridge/protocol.go"),
    protocol.replace(/const Version = "[^"]+"/u, 'const Version = "0.1.1"'),
  );
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
  const run = (cmd, args) =>
    exec(cmd, args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
  await run("git", ["init", "-b", "main"]);
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "fixture"]);
  await run(process.execPath, ["scripts/release.mjs", "check"]);
  // check compares the version of each extension manifest.
  for (const manifest of manifests) {
    await setVersion(manifest, "0.1.0");
    await assert.rejects(
      run(process.execPath, ["scripts/release.mjs", "check"]),
      (error) => /daemon, extension and package versions must agree/u.test(error.stderr),
      `check accepted ${manifest} at 0.1.0`,
    );
    await setVersion(manifest, "0.1.1");
  }
  await run(process.execPath, ["scripts/release.mjs", "version"]);
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.2.0");
  for (const manifest of manifests)
    assert.equal(
      JSON.parse(await readFile(join(dir, manifest), "utf8")).version,
      pkg.version,
      `${manifest} version`,
    );
  assert.ok(
    (await readFile(join(dir, "internal/bridge/protocol.go"), "utf8")).includes(
      `const Version = "${pkg.version}"`,
    ),
  );
  assert.ok(
    (await readFile(join(dir, "docs/releases/0.2.0.md"), "utf8")).includes("Fixture capability"),
  );
  const before = await readFile(join(dir, "CHANGELOG.md"), "utf8");
  await run(process.execPath, ["scripts/release.mjs", "version"]);
  assert.equal(await readFile(join(dir, "CHANGELOG.md"), "utf8"), before);
});

test("release asset verification rejects partial, extra, duplicate and corrupted uploads", async () => {
  const { verifyReleaseAssets } = await import("../scripts/release-assets.mjs");
  const { createHash } = await import("node:crypto");
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const sums = `${sha("fixture")}  fixture.tar.zst\n`;
  const assets = [
    { id: 1, name: "fixture.tar.zst", state: "uploaded", digest: `sha256:${sha("fixture")}` },
    { id: 2, name: "SHA256SUMS", state: "uploaded", digest: `sha256:${sha(sums)}` },
  ];
  assert.equal(verifyReleaseAssets(assets, sums, ["SHA256SUMS", "fixture.tar.zst"]), 1);
  assert.throws(() => verifyReleaseAssets(assets.slice(1), sums));
  assert.throws(() => verifyReleaseAssets([...assets, { ...assets[0], name: "extra" }], sums));
  assert.throws(() => verifyReleaseAssets([...assets, assets[0]], sums));
  assert.throws(() => verifyReleaseAssets(assets, sums.replace(sha("fixture"), sha("corrupt"))));
  assert.throws(() => verifyReleaseAssets(assets, sums + "\n"));
  assert.throws(() => verifyReleaseAssets([{ ...assets[0], state: "new" }, assets[1]], sums));
});

test("published build inputs require fragments while internal docs do not", async (t) => {
  const { mkdtemp, cp, mkdir, symlink, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname, resolve } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "omw-fragment-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of [
    "package.json",
    "extension/manifest.json",
    "extension/manifest.firefox.json",
    "internal/bridge/protocol.go",
    "scripts/release.mjs",
    ".changeset/config.json",
    ".changeset/README.md",
    "CHANGELOG.md",
    "README.md",
    "skills/oh-my-webbridge/SKILL.md",
  ]) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await cp(file, join(dir, file));
  }
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
  const run = (cmd, args) =>
    exec(cmd, args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
  await run("git", ["init", "-b", "main"]);
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "baseline"]);
  const base = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const check = (from = base) => run(process.execPath, ["scripts/release.mjs", "check", from]);
  const commit = async (message) => {
    await run("git", ["add", "."]);
    await run("git", ["commit", "-m", message]);
    return (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  };
  const needsFragment = (from, label) =>
    assert.rejects(
      check(from),
      (error) => error.stderr.includes("user-visible changes need a new .changeset"),
      label,
    );
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "docs/internal.md"), "Internal notes\n");
  await mkdir(join(dir, "benchmarks"));
  await writeFile(join(dir, "benchmarks/README.md"), "Internal benchmark methodology\n");
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "internal docs"]);
  await check();
  for (const file of [
    "scripts/archive.mjs",
    "scripts/compile-filters.mjs",
    "scripts/release-assets.mjs",
    "go.mod",
    "go.sum",
    ".github/workflows/benchmark.yml",
    ".github/workflows/package.yml",
    ".github/workflows/release.yml",
    "benchmarks/run.mjs",
    "THIRD_PARTY.md",
  ]) {
    await run("git", ["reset", "--hard", base]);
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), "Changed published input\n");
    await commit("published input");
    await needsFragment(base, file);
  }
  await writeFile(
    join(dir, ".changeset/fix.md"),
    '---\n"oh-my-webbridge": patch\n---\n\n# Correct installed artifacts\n\nKeep the published contents consistent.\n',
  );
  await run("git", ["add", "."]);
  await run("git", ["commit", "-m", "add fragment"]);
  await check();

  // Moves out of a published directory and non-ASCII names use their real paths.
  await run("git", ["reset", "--hard", base]);
  await mkdir(join(dir, "docs"), { recursive: true });
  await run("git", ["mv", "skills/oh-my-webbridge/SKILL.md", "docs/skill.md"]);
  await commit("move a skill file out of the agent kit");
  await needsFragment(base, "renamed skill file");
  await run("git", ["reset", "--hard", base]);
  await writeFile(join(dir, "skills/oh-my-webbridge/示例.md"), "Shipped in the agent kit\n");
  await commit("add a non-ASCII skill file");
  await needsFragment(base, "non-ASCII skill path");

  // Editing an older pending fragment does not describe a new change.
  await run("git", ["reset", "--hard", base]);
  const earlier = '---\n"oh-my-webbridge": patch\n---\n\n# Earlier change\n\nEarlier behavior.\n';
  await writeFile(join(dir, ".changeset/earlier.md"), earlier);
  const pending = await commit("pending fragment");
  await writeFile(join(dir, "internal/bridge/extra.go"), "package bridge\n");
  await writeFile(
    join(dir, ".changeset/earlier.md"),
    `${earlier}\n[PR #9](https://example.invalid/9)\n`,
  );
  await commit("runtime change with an edited fragment");
  await needsFragment(pending, "edited older fragment");
  // Renaming it, with or without the same edit, is not a new fragment either.
  for (const edit of [false, true]) {
    await run("git", ["reset", "--hard", pending]);
    await writeFile(join(dir, "internal/bridge/extra.go"), "package bridge\n");
    await run("git", ["mv", ".changeset/earlier.md", ".changeset/earlier-pr9.md"]);
    if (edit)
      await writeFile(
        join(dir, ".changeset/earlier-pr9.md"),
        `${earlier}\n[PR #9](https://example.invalid/9)\n`,
      );
    await commit("runtime change with a renamed fragment");
    await needsFragment(pending, edit ? "renamed and edited older fragment" : "renamed fragment");
  }

  // A hand-made version bump is not a generated version PR.
  await run("git", ["reset", "--hard", base]);
  for (const file of [
    "package.json",
    "extension/manifest.json",
    "extension/manifest.firefox.json",
  ]) {
    const value = JSON.parse(await readFile(join(dir, file), "utf8"));
    value.version = "0.1.2";
    await writeFile(join(dir, file), JSON.stringify(value, null, 2) + "\n");
  }
  const protocol = await readFile(join(dir, "internal/bridge/protocol.go"), "utf8");
  await writeFile(
    join(dir, "internal/bridge/protocol.go"),
    protocol.replace(/const Version = "[^"]+"/u, 'const Version = "0.1.2"'),
  );
  await writeFile(
    join(dir, "CHANGELOG.md"),
    `${await readFile(join(dir, "CHANGELOG.md"), "utf8")}\nManual notes\n`,
  );
  await writeFile(join(dir, "internal/bridge/extra.go"), "package bridge\n");
  await commit("manual version bump with a runtime change");
  await needsFragment(base, "manual version bump");

  // The generated version PR consumes fragments and passes without a new one.
  await run("git", ["reset", "--hard", base]);
  await writeFile(
    join(dir, ".changeset/fixture.md"),
    '---\n"oh-my-webbridge": minor\n---\n\n# Fixture capability\n\nA release fixture.\n',
  );
  const fragments = await commit("fixture fragment");
  await run(process.execPath, ["scripts/release.mjs", "version"]);
  await commit("chore(release): prepare 0.2.0");
  await check(fragments);
});

// Release notes and CHANGELOG.md place fragments one after another. An open
// comment or <pre> block ends only at its closing marker, and an HTML element
// such as <details> stays open after its Markdown block ends, so either would
// continue into the following fragments, Downloads and older releases. Link
// reference definitions and footnote labels apply to the whole document, so a
// fragment's [PR] or [^1] would also resolve the same label in other notes.
test("fragments close their blocks, limit raw HTML to comments and define no labels", async (t) => {
  const { dir, write, run } = await scriptFixture(t, "omw-open-block-", [
    "package.json",
    "extension/manifest.json",
    "extension/manifest.firefox.json",
    "internal/bridge/protocol.go",
    "scripts/release.mjs",
    ".changeset/config.json",
    ".changeset/README.md",
    "CHANGELOG.md",
    "README.md",
  ]);
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
  await run("git", ["init", "-q", "-b", "main"]);
  await run("git", ["add", "."]);
  await run("git", ["commit", "-q", "-m", "baseline"]);
  const release = (...args) => run(process.execPath, ["scripts/release.mjs", ...args]);
  const pairing = (body) =>
    `---\n"oh-my-webbridge": patch\n---\n\n# Pair once per profile\n\n${body}`;
  await write(
    ".changeset/b-presets.md",
    '---\n"oh-my-webbridge": patch\n---\n\n# Quieter task pages\n\nPresets are available.\n',
  );
  const changelog = await readFile(join(dir, "CHANGELOG.md"), "utf8");
  // The body starts on line 7 of each fragment file.
  for (const [name, body, error] of [
    [
      "open-comment",
      "<!-- reviewer: confirm the profile flag\n\nRe-pair existing profiles.\n",
      ":7: close the",
    ],
    ["open-pre", "<pre>\nomw pair --profile work\n\nRe-pair existing profiles.\n", ":7: close the"],
    [
      "details",
      "<details>\n<summary>Migration</summary>\n\nRe-pair existing profiles.\n\n</details>\n",
      ":7: raw HTML",
    ],
    ["div", "Steps:\n\n<div>\nRe-pair existing profiles.\n</div>\n", ":9: raw HTML"],
    ["kbd", "Press <kbd>Enter</kbd> to re-pair.\n", ":7: raw HTML"],
    ["end-tag", "Re-pair </div> existing profiles.\n", ":7: raw HTML"],
    // HTML ends a comment at "--!>", so <details> is an element.
    ["bang-close", "<!-- reviewer note --!>\n<details>\n-->\n", ":7: raw HTML"],
    [
      "table-cell",
      "| Mode | Effect |\n| --- | --- |\n| zen | <kbd>Enter</kbd> |\n",
      ":9: raw HTML",
    ],
    // GitHub splits table cells at the pipe inside the code span.
    [
      "table-pipe",
      "| Mode | Example | Note |\n| --- | --- | --- |\n| zen | `x | </td></tr></table><details>` |\n",
      ":9: raw HTML",
    ],
    [
      "footnote",
      "Profiles pair once.[^1]\n\n[^1]: Existing profiles need one re-pair.\n",
      ":9: footnotes",
    ],
  ]) {
    await write(`.changeset/a-${name}.md`, pairing(body));
    // check gates PRs; version generates the notes without running check first.
    for (const command of ["check", "version"]) {
      const result = await release(command);
      assert.notEqual(result.code, 0, `${command} accepted .changeset/a-${name}.md`);
      assert.ok(result.stderr.includes(`.changeset/a-${name}.md${error}`), result.stderr);
    }
    assert.equal(await readFile(join(dir, "CHANGELOG.md"), "utf8"), changelog);
    await rm(join(dir, `.changeset/a-${name}.md`));
  }

  // Each fragment defines [PR] for its own pull request; in the notes the first
  // definition would serve both.
  for (const [name, pr] of [
    ["a-pr", 10],
    ["c-pr", 20],
  ])
    await write(
      `.changeset/${name}.md`,
      pairing(
        `Profiles pair once ([PR]).\n\n[PR]: https://github.com/oh-my-webbridge/oh-my-webbridge/pull/${pr}\n`,
      ),
    );
  for (const command of ["check", "version"]) {
    const result = await release(command);
    assert.notEqual(result.code, 0, `${command} accepted [PR] definitions`);
    assert.match(result.stderr, /\.changeset\/[ac]-pr\.md:9: link reference definitions/u);
  }
  assert.equal(await readFile(join(dir, "CHANGELOG.md"), "utf8"), changelog);
  await rm(join(dir, ".changeset/a-pr.md"));
  await rm(join(dir, ".changeset/c-pr.md"));

  // Comments, inline links, and HTML or definitions written as code keep their
  // boundaries and stay unchanged.
  await write(
    ".changeset/a-closed.md",
    pairing(
      "<!-- reviewer: confirm the profile flag -->\n\n<!-- markdownlint-disable MD013 --> <!-- second comment -->\n\n<!--\nreviewer note\n\nsecond paragraph\n-->\n\nPress `<kbd>Enter</kbd>` to re-pair. <!-- inline note -->\n\n| Mode | Example |\n| --- | --- |\n| zen | `a \\| b` and a\\|b |\n\nSee the [pull request](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/3); `[x]: https://example.invalid` is text.\n\n```md\n[docs]: https://example.invalid/docs\n[^1]: A note.\n```\n\n```html\n<details>\n<summary>Migration</summary>\n</details>\n```\n",
    ),
  );
  const checked = await release("check");
  assert.equal(checked.code, 0, checked.stderr);
  const versioned = await release("version");
  assert.equal(versioned.code, 0, versioned.stderr);
  const headings = (markdown) => {
    const found = [];
    const visit = (node) => {
      if (node.type === "heading")
        found.push(markdown.slice(node.position.start.offset, node.position.end.offset));
      for (const child of node.children ?? []) visit(child);
    };
    visit(fromMarkdown(markdown));
    return found;
  };
  assert.deepEqual(headings(await readFile(join(dir, "docs/releases/0.1.2.md"), "utf8")), [
    "# 0.1.2",
    "### Improvements and fixes",
    "#### Pair once per profile",
    "#### Quieter task pages",
    "### Downloads",
  ]);
  const notes = await release("notes", "0.1.2");
  assert.equal(notes.code, 0, notes.stderr);
  assert.ok(
    notes.stdout.includes("```html\n<details>\n<summary>Migration</summary>\n</details>\n```"),
    notes.stdout,
  );
  assert.ok(notes.stdout.includes("Press `<kbd>Enter</kbd>` to re-pair. <!-- inline note -->"));
  assert.ok(notes.stdout.includes("<!-- markdownlint-disable MD013 --> <!-- second comment -->"));
  assert.ok(notes.stdout.includes("| zen | `a \\| b` and a\\|b |"), notes.stdout);
  assert.ok(
    notes.stdout.includes(
      "See the [pull request](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/3); `[x]: https://example.invalid` is text.",
    ),
  );
  assert.ok(
    notes.stdout.includes("```md\n[docs]: https://example.invalid/docs\n[^1]: A note.\n```"),
  );
  assert.doesNotMatch(notes.stdout, /## \[0\.1\.1\]/u);
});

async function publishFixture(t, prefix, releases) {
  const { dir, write, run } = await scriptFixture(t, prefix, [
    "scripts/publish-release.mjs",
    "scripts/release-assets.mjs",
  ]);
  await write(
    "package.json",
    JSON.stringify({ name: "oh-my-webbridge", version: "0.2.0", private: true, type: "module" }),
  );
  await write("docs/releases/0.2.0.md", "# 0.2.0\n\nFixture notes.\n");
  for (const args of [
    ["init", "-b", "main"],
    ["add", "."],
    ["commit", "-m", "fixture"],
    ["tag", "v0.2.0"],
  ])
    assert.equal((await run("git", args)).code, 0, `git ${args.join(" ")}`);
  const archive = "fixture archive\n";
  await write("dist/release/omw-0.2.0-agent-kit.tar.zst", archive);
  await write("dist/release/SHA256SUMS", `${sha256(archive)}  omw-0.2.0-agent-kit.tar.zst\n`);
  await mkdir(join(dir, "bin"));
  await cp("tests/fixtures/fake-gh.mjs", join(dir, "bin/gh"));
  await chmod(join(dir, "bin/gh"), 0o755);
  const state = join(dir, "gh-state.json");
  await writeFile(state, JSON.stringify({ nextId: 100, releases, files: {}, calls: [] }));
  return async () => {
    const result = await run(process.execPath, ["scripts/publish-release.mjs"], {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      FAKE_GH_STATE: state,
      GITHUB_REPOSITORY: "fixture/omw",
    });
    return { ...result, ...JSON.parse(await readFile(state, "utf8")) };
  };
}
const draftRelease = (id) => ({
  id,
  tag_name: "v0.2.0",
  draft: true,
  html_url: "https://github.com/fixture/omw/releases/tag/v0.2.0",
  assets: [],
});

test("publication creates one draft, verifies it by id and publishes last", async (t) => {
  const publish = await publishFixture(t, "omw-publish-", []);
  const first = await publish();
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.releases.length, 1);
  assert.equal(first.releases[0].draft, false);
  assert.deepEqual(first.releases[0].assets.map((a) => a.name).sort(), [
    "SHA256SUMS",
    "omw-0.2.0-agent-kit.tar.zst",
  ]);
  const upload = first.calls.findIndex((c) => c.startsWith("release upload v0.2.0"));
  const verify = first.calls.indexOf("api repos/fixture/omw/releases/100");
  const release = first.calls.findIndex((c) =>
    c.startsWith("api --method PATCH repos/fixture/omw/releases/100 -F draft=false"),
  );
  assert.ok(upload >= 0 && upload < verify && verify < release, first.calls.join("\n"));
  const rerun = await publish();
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.match(rerun.stdout, /Verified existing immutable release v0\.2\.0/u);
  assert.equal(rerun.releases.length, 1);
});

test("publication reuses a draft left by a failed run", async (t) => {
  const result = await (await publishFixture(t, "omw-publish-draft-", [draftRelease(7)]))();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.releases.map((r) => [r.id, r.draft, r.assets.length]),
    [[7, false, 2]],
  );
  assert.ok(!result.calls.some((c) => c.startsWith("release create")), result.calls.join("\n"));
});

test("publication refuses several releases for one tag", async (t) => {
  const publish = await publishFixture(t, "omw-publish-duplicate-", [
    draftRelease(7),
    draftRelease(8),
  ]);
  const result = await publish();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /v0\.2\.0 has 2 releases \(7 draft, 8 draft\)/u);
  assert.ok(!result.calls.some((c) => c.startsWith("release ")), result.calls.join("\n"));
});

// A release directory that passes the audit: four native archives, the Chrome
// and Firefox MV3 extensions with their license and filter-source notices, the
// Chrome Web Store package, the unsigned Firefox add-on and the agent kit.
// Callers add provenance and, optionally, benchmark data.
async function auditFixture(t, prefix) {
  const { dir, write, run } = await scriptFixture(t, prefix, [
    "scripts/audit-release.mjs",
    "scripts/archive.mjs",
  ]);
  await write(
    "package.json",
    JSON.stringify({ name: "oh-my-webbridge", version: "0.2.0", private: true, type: "module" }),
  );
  await write(
    "third_party/filters/sources.lock.json",
    JSON.stringify({ sources: [{ id: "easylist" }, { id: "include-filters-2025.txt" }] }),
  );
  for (const args of [
    ["init", "-b", "main"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ])
    assert.equal((await run("git", args)).code, 0, `git ${args.join(" ")}`);
  const commit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
  const release = join(dir, "dist/release");
  await mkdir(release, { recursive: true });
  const stage = async (name, files) => {
    await rm(join(dir, "staging", name), { recursive: true, force: true });
    for (const [file, data] of Object.entries(files))
      await write(join("staging", name, file), data);
    return join(dir, "staging", name);
  };
  for (const os of ["darwin", "linux"])
    for (const arch of ["arm64", "amd64"]) {
      const binary = Buffer.alloc(64);
      if (os === "linux") {
        binary.write("\x7fELF", 0, "latin1");
        binary.writeUInt16LE(arch === "amd64" ? 62 : 183, 18);
      } else {
        binary.writeUInt32LE(0xfeedfacf, 0);
        binary.writeUInt32LE(arch === "amd64" ? 0x1000007 : 0x100000c, 4);
      }
      const native = await stage(`${os}-${arch}`, {
        "bin/omw": binary,
        "licenses/coder-websocket.txt": "license\n",
        "licenses/go.txt": "license\n",
      });
      await packTarZst(join(release, `omw-0.2.0-${os}-${arch}.tar.zst`), native, [
        "bin",
        "licenses",
      ]);
    }
  // The license texts and filter-source notices both extension archives carry.
  const notices = {
    "licenses/ghostery-MPL-2.0.txt": "license\n",
    "licenses/GPL-3.0.txt": "license\n",
    "licenses/urlhaus-filter-MIT.txt": "license\n",
    "licenses/packages.json": JSON.stringify([
      { name: "@ghostery/adblocker", version: "2.20.3", files: ["LICENSE"] },
      { name: "tldts-core", version: "7.4.20", files: ["LICENSE"] },
    ]),
    "licenses/@ghostery-adblocker/package.json": "{}\n",
    "licenses/@ghostery-adblocker/LICENSE": "license\n",
    "licenses/tldts-core/package.json": "{}\n",
    "licenses/tldts-core/LICENSE": "license\n",
    "filter-sources.json": "{}\n",
    "filter-sources/easylist.txt": "! notice\n",
    "filter-sources/include-filters-2025.txt.txt": "! notice\n",
  };
  const extension = {
    "manifest.json": JSON.stringify({ manifest_version: 3, version: "0.2.0" }),
    "worker.js": "",
    ...notices,
  };
  const firefoxManifest = {
    manifest_version: 3,
    version: "0.2.0",
    browser_specific_settings: { gecko: { id: "oh-my-webbridge@oh-my-webbridge.github.io" } },
  };
  const firefoxFiles = (manifest = firefoxManifest) => ({
    "manifest.json": JSON.stringify(manifest),
    "background.js": "export {};\n",
    "icons/icon.svg": "<svg/>",
    ...notices,
  });
  const kit = {
    "sdk.mjs": "",
    "skills/oh-my-webbridge/SKILL.md": "",
  };
  const pack = async (name, files) =>
    packTarZst(join(release, `omw-0.2.0-${name}.tar.zst`), await stage(name, files), ["."]);
  const zip = (name, files) =>
    writeFile(
      join(release, name),
      zipSync(
        Object.fromEntries(Object.entries(files).map(([path, data]) => [path, Buffer.from(data)])),
      ),
    );
  // Each extension archive and its store package, which may hold other files.
  const chromeRelease = async (files, store = files) => {
    await pack("chrome-mv3", files);
    await zip("omw-0.2.0-chrome-mv3.zip", store);
  };
  const firefoxRelease = async (files, addon = files) => {
    await pack("firefox-mv3", files);
    await zip("omw-0.2.0-firefox-mv3-unsigned.xpi", addon);
  };
  await chromeRelease(extension);
  await firefoxRelease(firefoxFiles());
  await pack("agent-kit", kit);
  const audit = async () => {
    const sums = [];
    for (const file of (await readdir(release)).filter((f) => f !== "SHA256SUMS").sort())
      sums.push(`${sha256(await readFile(join(release, file)))}  ${file}`);
    await writeFile(join(release, "SHA256SUMS"), sums.join("\n") + "\n");
    return run(process.execPath, ["scripts/audit-release.mjs"]);
  };
  return {
    release,
    commit,
    stage,
    pack,
    audit,
    extension,
    chromeRelease,
    firefoxManifest,
    firefoxFiles,
    firefoxRelease,
    kit,
  };
}

test("release audit opens published benchmark data and checks provenance", async (t) => {
  const { release, commit, stage, audit } = await auditFixture(t, "omw-audit-");
  const report = "# Browser tooling benchmark\n";
  const benchmark = async (measured) =>
    packTarZst(
      join(release, "omw-0.2.0-benchmark-raw.tar.zst"),
      await stage("benchmark", {
        "report.md": report,
        "results.json": JSON.stringify({ metadata: { commit: measured } }),
      }),
      ["."],
    );
  await benchmark(commit);
  await writeFile(join(release, "omw-0.2.0-benchmark.md"), report);
  await writeFile(
    join(release, "provenance.json"),
    JSON.stringify({ schema: 1, version: "0.2.0", commit, benchmarkIncluded: true }),
  );
  const passed = await audit();
  assert.equal(passed.code, 0, passed.stderr);
  assert.match(
    passed.stdout,
    /Chrome and Firefox MV3, the Chrome Web Store package, the unsigned Firefox add-on/u,
  );
  assert.match(passed.stdout, /provenance and benchmark data/u);
  await writeFile(join(release, "omw-0.2.0-benchmark-raw.tar.zst"), "not a zstd stream");
  assert.notEqual((await audit()).code, 0, "corrupt benchmark raw archive");
  await benchmark("0".repeat(40));
  assert.match((await audit()).stderr, /results\.json was not measured at/u);
  await benchmark(commit);
  await writeFile(join(release, "omw-0.2.0-benchmark.md"), "# Another report\n");
  assert.match((await audit()).stderr, /differs from report\.md/u);
  await writeFile(join(release, "omw-0.2.0-benchmark.md"), report);
  await writeFile(
    join(release, "provenance.json"),
    JSON.stringify({
      schema: 1,
      version: "0.2.0",
      commit: "0".repeat(40),
      benchmarkIncluded: true,
    }),
  );
  assert.match((await audit()).stderr, /provenance\.json describes 0\.2\.0 at 0{40}/u);
  await rm(join(release, "provenance.json"));
  assert.match((await audit()).stderr, /provenance\.json/u);
});

test("release audit requires the unsigned add-on to match the Firefox archive", async (t) => {
  const { release, commit, audit, firefoxManifest, firefoxFiles, firefoxRelease } =
    await auditFixture(t, "omw-audit-xpi-");
  await writeFile(
    join(release, "provenance.json"),
    JSON.stringify({ schema: 1, version: "0.2.0", commit, benchmarkIncluded: false }),
  );
  const passed = await audit();
  assert.equal(passed.code, 0, passed.stderr);
  const files = firefoxFiles();
  await firefoxRelease(files, { ...files, "background.js": "export const changed = true;\n" });
  assert.match(
    (await audit()).stderr,
    /omw-0\.2\.0-firefox-mv3-unsigned\.xpi background\.js differs from the Firefox MV3 archive/u,
  );
  await firefoxRelease(files, { ...files, "extra.js": "" });
  assert.match(
    (await audit()).stderr,
    /unsigned\.xpi entries differ from the Firefox MV3 archive/u,
  );
  await firefoxRelease(
    firefoxFiles({
      ...firefoxManifest,
      browser_specific_settings: { gecko: { id: "other@example.invalid" } },
    }),
  );
  assert.match((await audit()).stderr, /invalid Firefox MV3 release/u);
  await firefoxRelease(files);
  assert.equal((await audit()).code, 0);
});

test("release audit requires the Chrome Web Store package to match the Chrome archive", async (t) => {
  const { release, commit, audit, extension, chromeRelease } = await auditFixture(
    t,
    "omw-audit-zip-",
  );
  await writeFile(
    join(release, "provenance.json"),
    JSON.stringify({ schema: 1, version: "0.2.0", commit, benchmarkIncluded: false }),
  );
  assert.equal((await audit()).code, 0);
  await chromeRelease(extension, { ...extension, "worker.js": "export const changed = true;\n" });
  assert.match(
    (await audit()).stderr,
    /omw-0\.2\.0-chrome-mv3\.zip worker\.js differs from the Chrome MV3 archive/u,
  );
  const { "worker.js": _, ...withoutWorker } = extension;
  await chromeRelease(extension, withoutWorker);
  assert.match(
    (await audit()).stderr,
    /chrome-mv3\.zip entries differ from the Chrome MV3 archive/u,
  );
  await rm(join(release, "omw-0.2.0-chrome-mv3.zip"));
  assert.notEqual((await audit()).code, 0, "audit accepted a release without the store package");
  await chromeRelease(extension);
  assert.equal((await audit()).code, 0);
});

test("release audit requires extension notices and the exact agent kit file list", async (t) => {
  const {
    release,
    commit,
    pack,
    audit,
    extension,
    chromeRelease,
    firefoxFiles,
    firefoxRelease,
    kit,
  } = await auditFixture(t, "omw-audit-kit-");
  await writeFile(
    join(release, "provenance.json"),
    JSON.stringify({ schema: 1, version: "0.2.0", commit, benchmarkIncluded: false }),
  );
  const passed = await audit();
  assert.equal(passed.code, 0, passed.stderr);
  // In both extension archives, each bundled package keeps its license files,
  // the filter lists keep the full license texts they require, and each source
  // in sources.lock.json keeps its original text and notice.
  for (const { label, publish, complete } of [
    { label: "Chrome", publish: (files) => chromeRelease(files), complete: extension },
    { label: "Firefox", publish: (files) => firefoxRelease(files), complete: firefoxFiles() },
  ]) {
    for (const path of [
      "licenses/ghostery-MPL-2.0.txt",
      "licenses/GPL-3.0.txt",
      "licenses/urlhaus-filter-MIT.txt",
      "licenses/packages.json",
      "licenses/tldts-core/LICENSE",
      "licenses/tldts-core/package.json",
      "filter-sources.json",
      "filter-sources/easylist.txt",
      "filter-sources/include-filters-2025.txt.txt",
    ]) {
      const { [path]: _, ...without } = complete;
      await publish(without);
      const result = await audit();
      assert.notEqual(result.code, 0, `audit accepted a ${label} extension without ${path}`);
      assert.match(
        result.stderr,
        new RegExp(
          `${label} MV3 archive is missing license or source notices: \\./${RegExp.escape(path)}`,
          "u",
        ),
      );
    }
    const bundled = JSON.parse(complete["licenses/packages.json"]);
    for (const [packages, error] of [
      [bundled.slice(1), /an @ghostery\/adblocker entry in \.\/licenses\/packages\.json/u],
      [
        [...bundled, { name: "tldts-experimental", version: "7.4.19", files: [] }],
        /a license file for tldts-experimental/u,
      ],
    ]) {
      await publish({ ...complete, "licenses/packages.json": JSON.stringify(packages) });
      const result = await audit();
      assert.notEqual(
        result.code,
        0,
        `audit accepted ${label} licenses/packages.json ${JSON.stringify(packages)}`,
      );
      assert.match(result.stderr, error);
    }
    await publish(complete);
  }
  assert.equal((await audit()).code, 0);
  for (const [files, error] of [
    [{ ...kit, "notes.txt": "" }, /missing none; unexpected \.\/notes\.txt/u],
    [
      { ...kit, "skills/oh-my-webbridge/draft.md": "" },
      /unexpected \.\/skills\/oh-my-webbridge\/draft\.md/u,
    ],
    [
      Object.fromEntries(Object.entries(kit).filter(([path]) => path !== "sdk.mjs")),
      /missing \.\/sdk\.mjs; unexpected none/u,
    ],
  ]) {
    await pack("agent-kit", files);
    const result = await audit();
    assert.notEqual(result.code, 0, `audit accepted agent kit ${Object.keys(files).join(", ")}`);
    assert.match(result.stderr, error);
  }
  await pack("agent-kit", kit);
  assert.equal((await audit()).code, 0);
});

// A bare origin with the GITHUB_TOKEN push rule, a maintainer checkout, and
// bot runs that each use a fresh clone of one main commit, like the version and
// filter workflows. The fake gh keeps tags, PRs and dispatches.
async function botRepository(t, prefix, files) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  const git = async (cwd, ...args) =>
    (await exec("git", args, { cwd, env: fixtureEnv })).stdout.trim();
  const origin = join(root, "origin.git");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await cp("tests/fixtures/pre-receive-workflows.sh", join(origin, "hooks/pre-receive"));
  await chmod(join(origin, "hooks/pre-receive"), 0o755);
  await mkdir(join(root, "bin"));
  await cp("tests/fixtures/fake-gh.mjs", join(root, "bin/gh"));
  await chmod(join(root, "bin/gh"), 0o755);
  const state = join(root, "gh-state.json");
  await writeFile(
    state,
    JSON.stringify({
      tags: [{ name: "v0.1.1", sha: "published" }],
      prs: [],
      dispatches: [],
      releases: [],
      files: {},
      nextId: 1,
      calls: [],
    }),
  );
  const gh = async () => JSON.parse(await readFile(state, "utf8"));
  const dev = join(root, "maintainer");
  for (const file of files) {
    await mkdir(dirname(join(dev, file)), { recursive: true });
    await cp(file, join(dev, file));
  }
  await releaseBaseline(dev, files);
  // Formatting and the extension build do not affect branch contents here.
  const pkg = JSON.parse(await readFile(join(dev, "package.json"), "utf8"));
  pkg.scripts = {
    format: "node -e 0",
    build: "node -e \"require('node:fs').mkdirSync('dist', { recursive: true })\"",
    "release:check": "node scripts/release.mjs check",
  };
  await writeFile(join(dev, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  await writeFile(join(dev, ".gitignore"), "node_modules\ndist/\n");
  await symlink(resolve("node_modules"), join(dev, "node_modules"), "dir");
  await git(dev, "init", "-q", "-b", "main");
  await git(dev, "remote", "add", "origin", origin);
  const write = async (file, data) => {
    await mkdir(dirname(join(dev, file)), { recursive: true });
    await writeFile(join(dev, file), data);
  };
  const land = async (message) => {
    await git(dev, "add", "-A");
    await git(dev, "commit", "-q", "-m", message);
    await git(dev, "push", "-q", "origin", "main");
    return git(dev, "rev-parse", "HEAD");
  };
  // GitHub's merge commit, squash and rebase buttons for a PR head branch.
  const merge = async (number, method = "merge") => {
    const s = await gh();
    const pr = s.prs.find((p) => p.number === number);
    await git(dev, "fetch", "-q", "origin");
    if (method === "squash") {
      await git(dev, "merge", "-q", "--squash", `origin/${pr.head}`);
      await git(dev, "commit", "-q", "-m", `${pr.title} (#${number})`);
    } else if (method === "rebase") await git(dev, "cherry-pick", `origin/${pr.head}`);
    else
      await git(
        dev,
        "merge",
        "-q",
        "--no-ff",
        `origin/${pr.head}`,
        "-m",
        `Merge pull request #${number}`,
      );
    await git(dev, "push", "-q", "origin", "main");
    pr.state = "merged";
    await writeFile(state, JSON.stringify(s, null, 2) + "\n");
    return git(dev, "rev-parse", "HEAD");
  };
  let runs = 0;
  const bot = async (script, sha, env = {}) => {
    const work = join(root, `run-${++runs}`);
    await git(root, "clone", "-q", origin, work);
    await git(work, "checkout", "-q", "--detach", sha);
    await symlink(resolve("node_modules"), join(work, "node_modules"), "dir");
    return exec(process.execPath, [script], {
      cwd: work,
      env: {
        ...fixtureEnv,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        FAKE_GH_STATE: state,
        FAKE_GITHUB_TOKEN: "1",
        GITHUB_REPOSITORY: "fixture/omw",
        ...env,
      },
      maxBuffer: 16 << 20,
    }).then(
      ({ stdout }) => ({ code: 0, stdout: stdout.trim() }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
  };
  const remote = async (branch) =>
    (await git(dev, "ls-remote", "origin", `refs/heads/${branch}`)).split("\t")[0];
  // The pushed bot commit: its parents and the files it changes relative to main.
  const branchChange = async (branch, main) => {
    await git(dev, "fetch", "-q", "origin");
    const head = await remote(branch);
    return {
      parents: (await git(dev, "log", "-1", "--format=%P", head)).split(" "),
      files: (await git(dev, "diff", "--name-only", "--no-renames", main, head)).split("\n"),
      head,
    };
  };
  return { dev, git, gh, write, land, merge, bot, remote, branchChange };
}

const releaseFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  "extension/manifest.json",
  "extension/manifest.firefox.json",
  "internal/bridge/protocol.go",
  "scripts/release.mjs",
  "scripts/release-pr.mjs",
  ".changeset/config.json",
  ".changeset/README.md",
  "CHANGELOG.md",
  "README.md",
  ".github/workflows/ci.yml",
];
const fragment = (type, title) =>
  `---\n"oh-my-webbridge": ${type}\n---\n\n# ${title}\n\n${title} for the fixture.\n`;
// Paths in git diff order; callers list fragment names alphabetically.
const versionFiles = (version, fragments) => [
  ...fragments.map((name) => `.changeset/${name}.md`),
  "CHANGELOG.md",
  `docs/releases/${version}.md`,
  "extension/manifest.firefox.json",
  "extension/manifest.json",
  "internal/bridge/protocol.go",
  "package.json",
];

test("version PRs are rebuilt on main and pushed after main changes workflow files", async (t) => {
  const repo = await botRepository(t, "omw-version-branch-", releaseFiles);
  const prepare = (sha) => repo.bot("scripts/release-pr.mjs", sha, { OMW_CREATE_TAG: "true" });
  await repo.write(".changeset/presets.md", fragment("minor", "Quieter task pages"));
  const m1 = await repo.land("feat: presets");
  const first = await prepare(m1);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(await repo.branchChange("release/next", m1), {
    parents: [m1],
    files: versionFiles("0.2.0", ["presets"]),
    head: await repo.remote("release/next"),
  });

  // An Actions update on main changes workflow files and adds a fragment.
  const ci = await readFile(join(repo.dev, ".github/workflows/ci.yml"), "utf8");
  await repo.write(".github/workflows/ci.yml", `${ci}# pinned action update\n`);
  await repo.write(".changeset/actions.md", fragment("patch", "Update pinned actions"));
  const m2 = await repo.land("chore(deps): update actions");
  const second = await prepare(m2);
  assert.equal(second.code, 0, second.stderr);
  const change = await repo.branchChange("release/next", m2);
  assert.deepEqual(change.parents, [m2], "release/next is one commit on main");
  assert.deepEqual(change.files, versionFiles("0.2.0", ["actions", "presets"]));
  const notes = await repo.git(repo.dev, "show", `${change.head}:docs/releases/0.2.0.md`);
  assert.match(notes, /Quieter task pages[\s\S]*Update pinned actions/u);
  const gh = await repo.gh();
  assert.deepEqual(
    gh.prs.map((p) => [p.number, p.title, p.state]),
    [[1, "chore(release): prepare 0.2.0", "open"]],
  );
  assert.deepEqual(
    gh.tags.map((tag) => tag.name),
    ["v0.1.1"],
  );
});

test("a version PR merged behind newer fragments is tagged before the next one", async (t) => {
  const repo = await botRepository(t, "omw-version-race-", releaseFiles);
  const prepare = (sha) => repo.bot("scripts/release-pr.mjs", sha, { OMW_CREATE_TAG: "true" });
  const ok = (result) => {
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.split("\n").at(-1);
  };
  await repo.write("internal/bridge/presets.go", "package bridge\n");
  await repo.write(".changeset/presets.md", fragment("minor", "Quieter task pages"));
  const m1 = await repo.land("feat: presets (PR A)");
  assert.match(ok(await prepare(m1)), /^Prepared 0\.2\.0 on release\/next/u);
  const v020 = await repo.remote("release/next");

  // PR B lands; its run finishes only after the maintainer merged version PR #1.
  await repo.write("internal/bridge/reconnect.go", "package bridge\n");
  await repo.write(".changeset/reconnect.md", fragment("patch", "Reconnect faster"));
  const m2 = await repo.land("fix: reconnect (PR B)");
  const m3 = await repo.merge(1);
  assert.match(ok(await prepare(m2)), /^Prepared 0\.2\.0 on release\/next/u);
  assert.match(ok(await prepare(m3)), /^Prepared 0\.2\.1 on release\/next/u);
  let gh = await repo.gh();
  assert.deepEqual(gh.tags.at(-1), { name: "v0.2.0", sha: v020 });
  assert.deepEqual(
    gh.prs.map((p) => [p.number, p.title, p.state]),
    [
      [1, "chore(release): prepare 0.2.0", "merged"],
      [2, "chore(release): prepare 0.2.1", "open"],
    ],
  );

  // A squash merge appends the PR number to the generated title.
  const m4 = await repo.merge(2, "squash");
  assert.equal(ok(await prepare(m4)), "No pending change fragments");
  gh = await repo.gh();
  assert.deepEqual(gh.tags, [
    { name: "v0.1.1", sha: "published" },
    { name: "v0.2.0", sha: v020 },
    { name: "v0.2.1", sha: m4 },
  ]);
  assert.deepEqual(
    gh.dispatches.filter((d) => d.workflow === "release.yml").map((d) => d.ref),
    ["v0.2.0", "v0.2.1"],
  );
  const notes = await repo.git(repo.dev, "show", `${m4}:docs/releases/0.2.1.md`);
  assert.match(notes, /Reconnect faster/u);
  assert.doesNotMatch(notes, /Quieter task pages/u);
  assert.match(
    await repo.git(repo.dev, "show", `${v020}:docs/releases/0.2.0.md`),
    /Quieter task pages/u,
  );
});

test("filter refreshes add a dated fragment on a branch rebuilt from main", async (t) => {
  const repo = await botRepository(t, "omw-filter-branch-", [
    ...releaseFiles.filter((f) => f !== "scripts/release-pr.mjs"),
    "scripts/filter-pr.mjs",
    "third_party/filters/sources.lock.json",
  ]);
  await cp("tests/fixtures/update-filters.mjs", join(repo.dev, "scripts/update-filters.mjs"));
  const m0 = await repo.land("baseline");
  const refresh = async (sha, snapshot) => {
    const result = await repo.bot("scripts/filter-pr.mjs", sha, { FAKE_FILTER_SNAPSHOT: snapshot });
    assert.equal(result.code, 0, result.stderr);
    return repo.branchChange("maintenance/filter-lists", sha);
  };
  const check = async (main, change) => {
    await repo.git(repo.dev, "checkout", "-q", "--detach", change.head);
    const result = await promisify(execFile)(
      process.execPath,
      ["scripts/release.mjs", "check", main],
      { cwd: repo.dev, env: fixtureEnv },
    );
    await repo.git(repo.dev, "checkout", "-q", "main");
    return result.stdout;
  };
  const lock = "third_party/filters/sources.lock.json";
  const first = await refresh(m0, "2026-11-10T05:41:00.000Z");
  assert.deepEqual(first.parents, [m0]);
  assert.deepEqual(first.files, [".changeset/filter-refresh-2026-11-10.md", lock]);
  assert.match(
    await repo.git(repo.dev, "show", `${first.head}:.changeset/filter-refresh-2026-11-10.md`),
    /^# Refresh bundled protection rules \(2026-11-10 snapshot\)$/mu,
  );
  await repo.merge(1);

  // A workflow change lands while the first refresh fragment is still pending.
  const ci = await readFile(join(repo.dev, ".github/workflows/ci.yml"), "utf8");
  await repo.write(".github/workflows/ci.yml", `${ci}# pinned action update\n`);
  const m2 = await repo.land("chore(deps): update actions");
  const second = await refresh(m2, "2026-11-17T05:41:00.000Z");
  assert.deepEqual(second.parents, [m2]);
  assert.deepEqual(second.files, [".changeset/filter-refresh-2026-11-17.md", lock]);
  assert.match(await check(m2, second), /change fragments verified/u);

  // Another snapshot on the same date takes the next suffix.
  const m3 = await repo.merge(2);
  const third = await refresh(m3, "2026-11-17T09:00:00.000Z");
  assert.deepEqual(third.files, [".changeset/filter-refresh-2026-11-17-2.md", lock]);
  assert.match(await check(m3, third), /change fragments verified/u);
  assert.deepEqual(
    (await repo.gh()).prs.map((p) => p.title),
    [
      "chore(filters): refresh pinned protection lists (2026-11-10)",
      "chore(filters): refresh pinned protection lists (2026-11-17)",
      "chore(filters): refresh pinned protection lists (2026-11-17)",
    ],
  );
});

for (const [method, merged] of [
  ["merge", "merged with a merge commit"],
  ["squash", "squash-merged"],
  ["rebase", "rebase-merged"],
])
  test(`a version PR ${merged} behind main is tagged only without pending fragments`, async (t) => {
    const repo = await botRepository(t, `omw-version-${method}-`, releaseFiles);
    const prepare = (sha) => repo.bot("scripts/release-pr.mjs", sha, { OMW_CREATE_TAG: "true" });
    await repo.write("internal/bridge/presets.go", "package bridge\n");
    await repo.write(".changeset/presets.md", fragment("minor", "Quieter task pages"));
    const m1 = await repo.land("feat: presets (PR A)");
    assert.equal((await prepare(m1)).code, 0);
    const v020 = await repo.remote("release/next");
    // PR B lands with a major fragment before version PR #1 is merged.
    await repo.write("internal/bridge/legacy.go", "package bridge\n");
    await repo.write(".changeset/legacy.md", fragment("major", "Remove legacy pairing"));
    const m2 = await repo.land("feat!: remove legacy pairing (PR B)");
    const m3 = await repo.merge(1, method);
    assert.equal((await prepare(m2)).code, 0);
    const result = await prepare(m3);
    const gh = await repo.gh();
    const releases = gh.dispatches.filter((d) => d.workflow === "release.yml");
    if (method === "merge") {
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(gh.tags.at(-1), { name: "v0.2.0", sha: v020 });
      assert.deepEqual(releases, [{ workflow: "release.yml", ref: "v0.2.0" }]);
      return;
    }
    assert.notEqual(result.code, 0);
    assert.ok(
      result.stderr.includes(
        `v0.2.0 is not tagged: ${m3} "chore(release): prepare 0.2.0" still contains pending fragments .changeset/legacy.md`,
      ),
      result.stderr,
    );
    assert.match(result.stderr, /merged with a merge commit, or updated by the version workflow/u);
    assert.deepEqual(gh.tags, [{ name: "v0.1.1", sha: "published" }]);
    assert.deepEqual(releases, []);
  });

test("a version run on release/next does not tag the unmerged version PR", async (t) => {
  const repo = await botRepository(t, "omw-version-dispatch-", releaseFiles);
  const prepare = (sha) => repo.bot("scripts/release-pr.mjs", sha, { OMW_CREATE_TAG: "true" });
  await repo.write("internal/bridge/presets.go", "package bridge\n");
  await repo.write(".changeset/presets.md", fragment("minor", "Quieter task pages"));
  const m1 = await repo.land("feat: presets (PR A)");
  assert.equal((await prepare(m1)).code, 0);
  const head = await repo.remote("release/next");
  const result = await prepare(head);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`v0\\.2\\.0 is not tagged: ${head} is not on origin/main`, "u"),
  );
  const gh = await repo.gh();
  assert.deepEqual(gh.tags, [{ name: "v0.1.1", sha: "published" }]);
  assert.deepEqual(
    gh.dispatches.filter((d) => d.workflow === "release.yml"),
    [],
  );
  assert.deepEqual(
    gh.prs.map((p) => [p.number, p.title, p.state]),
    [[1, "chore(release): prepare 0.2.0", "open"]],
  );
});
