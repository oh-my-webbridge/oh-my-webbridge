import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

// Check the files copied by install-skill or extracted from the agent kit.
const directory = process.argv[2];
assert.ok(directory, "Pass the installed oh-my-webbridge skill directory");
const root = resolve(directory);
const references = new Set(
  (await readdir(join(root, "references"), { recursive: true }))
    .filter((name) => extname(name) === ".mdx")
    .map((name) => join("references", name)),
);
assert.ok(references.size, "The skill has no installed references");
const pending = ["SKILL.md"];
const seen = new Set();
while (pending.length) {
  const name = pending.pop();
  if (seen.has(name)) continue;
  seen.add(name);
  const document = await readFile(join(root, name), "utf8");
  const tree = fromMarkdown(document, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const visit = (node) => {
    if (node.type === "link" || node.type === "definition") {
      const url = new URL(node.url, pathToFileURL(join(root, name)));
      if (url.protocol === "file:" && !node.url.startsWith("#")) {
        const target = relative(root, fileURLToPath(url));
        assert.ok(references.has(target), `${name}: missing installed reference ${node.url}`);
        pending.push(target);
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
}
for (const name of references) assert.ok(seen.has(name), `Unreachable: ${name}`);
console.log(`Verified ${references.size} reachable offline reference files`);
