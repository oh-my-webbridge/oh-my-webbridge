import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["extension/ui/src/lib/suggestions.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { suggest } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

const page = (url, signals = {}, extra = {}) => ({
  url,
  title: "",
  language: "en",
  signals: {
    lang: "en",
    tables: 0,
    fields: 0,
    code: 0,
    videos: 0,
    images: 0,
    articles: 0,
    text: 1000,
    selection: 0,
    search: false,
    citation: false,
    types: [],
    ...signals,
  },
  ...extra,
});
const everyPage = ["summarize", "research", "form", "extract", "screenshot", "pdf", "links"];
// The full order when rules pick these suggestions: them, then the rest of everyPage.
const order = (...picked) => [...picked, ...everyPage.filter((name) => !picked.includes(name))];

test("a page that cannot be read gets the suggestions for every page", () => {
  assert.deepEqual(suggest({ url: "chrome://newtab/", title: "New Tab", language: "en" }), order());
  assert.deepEqual(suggest(page("https://example.com/")), order());
});

test("the domain and path pick suggestions for known sites", () => {
  assert.equal(suggest(page("https://github.com/o/r/pull/12"))[0], "review");
  assert.equal(suggest(page("https://github.com/o/r/issues/3"))[0], "thread");
  assert.equal(suggest(page("https://github.com/o/r", { articles: 1 }))[0], "repo");
  assert.deepEqual(suggest(page("https://github.com/settings/profile")), order());
  assert.equal(suggest(page("https://arxiv.org/abs/2401.00001"))[0], "paper");
  assert.equal(suggest(page("https://www.youtube.com/watch?v=x"))[0], "video");
  assert.equal(suggest(page("https://www.amazon.co.jp/dp/B000"))[0], "product");
  assert.equal(suggest(page("https://mail.google.com/mail/u/0/"))[0], "inbox");
  assert.equal(suggest(page("https://www.google.co.jp/search?q=omw"))[0], "research");
});

test("page elements pick suggestions on any site", () => {
  const signals = { tables: 2, fields: 5, code: 3, images: 20 };
  assert.deepEqual(
    suggest(page("https://example.com/", signals)),
    order("code", "form", "extract", "images"),
  );
  assert.deepEqual(suggest(page("https://example.com/", { types: ["recipe"] })), order("recipe"));
  assert.deepEqual(suggest(page("https://example.com/", { citation: true })), order("paper"));
  assert.deepEqual(suggest(page("https://example.com/", { text: 9000 })), order("summarize"));
});

test("a selection comes first and at most five rules pick", () => {
  const busy = page("https://docs.example.com/api", {
    selection: 40,
    tables: 1,
    fields: 3,
    code: 4,
    videos: 1,
    images: 30,
    articles: 1,
  });
  const names = suggest(busy);
  assert.equal(names[0], "selection");
  // Eight rules match this page. Ties keep the list order, and images, extract
  // and summarize miss the first five; extract and summarize stay for every page.
  assert.deepEqual(names, order("selection", "video", "docs", "code", "form"));
  assert.ok(!names.includes("images"));
  assert.equal(new Set(names).size, names.length, "no suggestion repeats");
  for (const name of everyPage) assert.ok(names.includes(name), `${name} stays in the rotation`);
});

test("translation is offered when the page language differs from the interface", () => {
  const english = page("https://example.com/", { lang: "en-US" }, { language: "zh-TW" });
  assert.deepEqual(suggest(english), order("translate"));
  const chinese = page("https://example.com/", { lang: "zh-Hans" }, { language: "zh-TW" });
  assert.deepEqual(suggest(chinese), order());
  assert.deepEqual(suggest(page("https://example.com/", { lang: "" })), order());
});

test("an error title on a short page asks why the page fails", () => {
  const missing = page("https://example.com/x", {}, { title: "404 Not Found" });
  assert.equal(suggest(missing)[0], "debug");
  const article = page("https://example.com/x", { text: 8000 }, { title: "Handle 404 errors" });
  assert.ok(!suggest(article).slice(0, 2).includes("debug"));
});
