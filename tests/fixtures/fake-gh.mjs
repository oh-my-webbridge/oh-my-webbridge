#!/usr/bin/env node
// gh stand-in for the release script tests, following the documented REST
// behavior: GET releases/tags/{tag} returns only published releases, the
// release list and GET releases/{id} include drafts, and several drafts may
// share one tag. `gh release upload` resolves a release by tag like gh. Tag
// refs, workflow dispatches and pull requests are kept in the same state file.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args.join(" "));
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
const reply = (output) => {
  save();
  process.stdout.write(output);
  process.exit(0);
};
const fail = (message) => {
  save();
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const option = (name) => args[args.indexOf(name) + 1];
const byTag = (tag) => {
  const releases = state.releases.filter((r) => r.tag_name === tag);
  if (releases.length !== 1) fail(`gh: ${releases.length} releases match ${tag}`);
  return releases[0];
};

if (args[0] === "api") {
  let method = "GET";
  let jq;
  let path;
  const fields = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--method") method = args[++i];
    else if (arg === "--jq") jq = args[++i];
    else if (arg === "-H") i++;
    else if (arg === "-F" || arg === "-f") {
      const [key, value] = args[++i].split("=");
      fields[key] = arg === "-F" && /^(?:true|false)$/u.test(value) ? value === "true" : value;
    } else if (arg !== "--paginate") path = arg;
  }
  const route = path.replace(/^repos\/[^/]+\/[^/]+\//u, "");
  let match = route.match(/^git\/ref\/tags\/(.+)$/u);
  if (match) {
    const tag = state.tags.find((t) => t.name === match[1]);
    if (!tag) fail("gh: Not Found (HTTP 404)");
    reply(JSON.stringify({ ref: `refs/tags/${tag.name}`, object: { sha: tag.sha } }));
  }
  if (route === "git/refs" && method === "POST") {
    const name = fields.ref.replace(/^refs\/tags\//u, "");
    if (state.tags.some((t) => t.name === name)) fail("gh: Reference already exists (HTTP 422)");
    state.tags.push({ name, sha: fields.sha });
    reply(JSON.stringify({ ref: fields.ref, object: { sha: fields.sha } }));
  }
  if (route === "releases" && method === "GET") {
    if (jq !== ".[]") fail(`unexpected jq filter ${jq}`);
    reply(state.releases.map((r) => JSON.stringify(r) + "\n").join(""));
  }
  match = route.match(/^releases\/tags\/(.+)$/u);
  if (match) {
    const release = state.releases.find((r) => r.tag_name === match[1] && !r.draft);
    if (!release) fail("gh: Not Found (HTTP 404)");
    reply(JSON.stringify(release));
  }
  match = route.match(/^releases\/assets\/(\d+)$/u);
  if (match) {
    // Uploaded asset bytes stay in the local files they came from.
    const file = state.files[match[1]];
    if (!file) fail("gh: Not Found (HTTP 404)");
    reply(readFileSync(file));
  }
  match = route.match(/^releases\/(\d+)$/u);
  if (match) {
    const release = state.releases.find((r) => r.id === Number(match[1]));
    if (!release) fail("gh: Not Found (HTTP 404)");
    if (method === "PATCH") Object.assign(release, fields);
    reply(JSON.stringify(release));
  }
  fail(`unexpected gh api ${method} ${path}`);
}
if (args[0] === "release" && args[1] === "create") {
  const tag = args[2];
  state.releases.push({
    id: state.nextId++,
    tag_name: tag,
    draft: args.includes("--draft"),
    html_url: `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/tag/${tag}`,
    assets: [],
  });
  reply(`${state.releases.at(-1).html_url}\n`);
}
if (args[0] === "release" && args[1] === "upload") {
  const release = byTag(args[2]);
  for (const file of args.slice(3).filter((a) => !a.startsWith("--"))) {
    const name = basename(file);
    const id = state.nextId++;
    release.assets = release.assets.filter((a) => a.name !== name);
    release.assets.push({
      id,
      name,
      state: "uploaded",
      digest: `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`,
    });
    state.files[id] = file;
  }
  reply("");
}
if (args[0] === "workflow" && args[1] === "run") {
  state.dispatches.push({ workflow: args[2], ref: option("--ref") });
  reply("");
}
if (args[0] === "pr" && args[1] === "list") {
  const open = state.prs.filter((p) => p.head === option("--head") && p.state === "open");
  reply(JSON.stringify(open.map((p) => ({ number: p.number }))));
}
if (args[0] === "pr" && args[1] === "create") {
  const pr = {
    number: state.prs.length + 1,
    head: option("--head"),
    base: option("--base"),
    title: option("--title"),
    state: "open",
  };
  state.prs.push(pr);
  reply(`https://github.com/${process.env.GITHUB_REPOSITORY}/pull/${pr.number}\n`);
}
if (args[0] === "pr" && args[1] === "edit") {
  const pr = state.prs.find((p) => p.number === Number(args[2]));
  if (pr?.state !== "open") fail(`gh: pull request #${args[2]} is not open`);
  pr.title = option("--title");
  reply("");
}
fail(`unexpected gh ${args.join(" ")}`);
