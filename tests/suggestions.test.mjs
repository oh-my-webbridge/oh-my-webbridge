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
const fits = (suggestions) => suggestions.filter((s) => s.fit).map((s) => s.name);
const everyPage = ["summarize", "research", "form", "extract", "screenshot", "pdf", "links"];

test("a page that cannot be read gets the suggestions for every page", () => {
  const suggestions = suggest({ url: "chrome://newtab/", title: "New Tab", language: "en" });
  assert.deepEqual(
    suggestions.map((s) => s.name),
    everyPage,
  );
  assert.deepEqual(fits(suggestions), []);
});

test("the domain and path pick suggestions for known sites", () => {
  assert.equal(suggest(page("https://github.com/o/r/pull/12"))[0].name, "review");
  assert.equal(suggest(page("https://github.com/o/r/issues/3"))[0].name, "thread");
  assert.equal(suggest(page("https://github.com/o/r", { articles: 1 }))[0].name, "repo");
  assert.deepEqual(fits(suggest(page("https://github.com/settings/profile"))), []);
  assert.equal(suggest(page("https://arxiv.org/abs/2401.00001"))[0].name, "paper");
  assert.equal(suggest(page("https://www.youtube.com/watch?v=x"))[0].name, "video");
  assert.equal(suggest(page("https://www.amazon.co.jp/dp/B000"))[0].name, "product");
  assert.equal(suggest(page("https://mail.google.com/mail/u/0/"))[0].name, "inbox");
  assert.equal(suggest(page("https://www.google.co.jp/search?q=omw"))[0].name, "research");
});

test("page elements pick suggestions on any site", () => {
  const signals = { tables: 2, fields: 5, code: 3, images: 20 };
  assert.deepEqual(fits(suggest(page("https://example.com/", signals))), [
    "code",
    "form",
    "extract",
    "images",
  ]);
  assert.deepEqual(fits(suggest(page("https://example.com/", { types: ["recipe"] }))), ["recipe"]);
  assert.deepEqual(fits(suggest(page("https://example.com/", { citation: true }))), ["paper"]);
  assert.deepEqual(fits(suggest(page("https://example.com/", { text: 9000 }))), ["summarize"]);
});

test("a selection comes first and at most five suggestions fit", () => {
  const busy = page("https://docs.example.com/api", {
    selection: 40,
    tables: 1,
    fields: 3,
    code: 4,
    videos: 1,
    images: 30,
    articles: 1,
  });
  const suggestions = suggest(busy);
  assert.equal(suggestions[0].name, "selection");
  assert.equal(fits(suggestions).length, 5);
  const names = suggestions.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, "no suggestion repeats");
  for (const name of everyPage) assert.ok(names.includes(name), `${name} stays available`);
});

test("translation is offered when the page language differs from the interface", () => {
  const english = page("https://example.com/", { lang: "en-US" }, { language: "zh-TW" });
  assert.deepEqual(fits(suggest(english)), ["translate"]);
  const chinese = page("https://example.com/", { lang: "zh-Hans" }, { language: "zh-TW" });
  assert.deepEqual(fits(suggest(chinese)), []);
  assert.deepEqual(fits(suggest(page("https://example.com/", { lang: "" }))), []);
});

test("an error title on a short page asks why the page fails", () => {
  const missing = page("https://example.com/x", {}, { title: "404 Not Found" });
  assert.equal(suggest(missing)[0].name, "debug");
  const article = page("https://example.com/x", { text: 8000 }, { title: "Handle 404 errors" });
  assert.ok(!fits(suggest(article)).includes("debug"));
});
