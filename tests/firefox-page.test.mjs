// Runs extension/src/firefox/page.ts in Firefox (FIREFOX_BIN) against local
// fixture pages. Page scripts record the events they receive, including
// whether the browser marked them trusted.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { startFirefox } from "../scripts/firefox-bidi.mjs";
import { until } from "./fixtures/e2e-bridge.mjs";

const pixel = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
const recorded = [
  "pointerover",
  "pointerenter",
  "pointermove",
  "pointerdown",
  "pointerup",
  "pointerout",
  "pointerleave",
  "mouseover",
  "mouseenter",
  "mousemove",
  "mousedown",
  "mouseup",
  "mouseout",
  "mouseleave",
  "click",
  "dblclick",
  "contextmenu",
  "auxclick",
  "keydown",
  "keypress",
  "keyup",
  "beforeinput",
  "input",
  "change",
  "submit",
];
// Records every event above in capture phase with its innermost target.
const recorder =
  "<script>globalThis.events = []; for (const type of " +
  JSON.stringify(recorded) +
  ") document.addEventListener(type, (e) => { const target = e.composedPath()[0]; globalThis.events.push({ type, target: target.id || target.localName, trusted: e.isTrusted, detail: e.detail, button: e.button, inputType: e.inputType, key: e.key }); }, true);</script>";
const pages = new Map([
  [
    "/snapshot",
    [
      '<!doctype html><html lang="en"><title>Snapshot fixture</title>',
      '<header><nav aria-label="Primary"><a href="/home">Home</a> <a>No link</a></nav></header>',
      "<main>",
      "<h1>Main heading</h1>",
      '<section aria-labelledby="sub"><h2 id="sub">Sub heading</h2><p>Plain <strong>bold</strong> text.</p></section>',
      '<form aria-label="Login">',
      '<label for="user">User name</label><input id="user" value="avery" required>',
      '<label>Password <input type="password" value="secret"></label>',
      '<input type="email" placeholder="Email address">',
      '<input type="number" aria-label="Count" value="3">',
      '<input type="checkbox" id="remember" checked><label for="remember">Remember</label>',
      '<input type="radio" name="r" aria-label="Radio A"><input type="radio" name="r" aria-label="Radio B" checked>',
      '<select aria-label="Choice"><option value="a">Alpha</option><option value="b" selected>Beta</option></select>',
      '<textarea aria-label="Notes">note text</textarea>',
      '<input type="submit" value="Sign in"><input type="hidden" value="x">',
      '<button type="button" aria-expanded="false" onclick="globalThis.menuClicks = (globalThis.menuClicks ?? 0) + 1">Menu</button>',
      '<button type="button" disabled>Disabled</button>',
      '<button type="button" aria-labelledby="sub user">Labelled</button>',
      "</form>",
      '<img alt="Logo image" src="' + pixel + '"><img alt="" src="' + pixel + '">',
      "<ul><li>First item</li></ul>",
      '<div role="tablist"><div role="tab" aria-selected="true">Tab one</div></div>',
      '<div role="checkbox" aria-checked="mixed" aria-label="Tri"></div>',
      '<div aria-hidden="true"><button>Hidden by aria</button></div>',
      '<div style="display:none"><button>Hidden by display</button></div>',
      '<div style="visibility:hidden">Ghost <span style="visibility:visible">Shown child</span></div>',
      '<div contenteditable="true">Editable</div>',
      "<details><summary>More</summary><p>Body</p></details>",
      '<div id="host"></div>',
      '<iframe title="Inner frame" srcdoc="<p>Frame</p>"></iframe>',
      "</main>",
      "<footer>Footer text</footer>",
      '<script>document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = "<button>Shadow button</button>";</script>',
    ].join("\n"),
  ],
  ["/next", "<!doctype html><title>Next</title><p>Next page</p>"],
  ["/child", "<!doctype html><title>Child</title><button>Child button</button>"],
  ["/many", "<!doctype html><title>Many</title>" + "<mark></mark>".repeat(4100)],
  ["/long", "<!doctype html><title>Long</title>" + ("<p>" + "x".repeat(1200) + "</p>").repeat(200)],
  [
    "/locators",
    [
      "<!doctype html><title>Locator fixture</title>",
      '<button id="save" data-testid="save-button" title="Save title">Save</button>',
      '<button id="draft" onclick="globalThis.drafts = (globalThis.drafts ?? 0) + 1">Save draft</button>',
      '<label for="email">Email</label><input id="email" placeholder="you@example.com">',
      '<input id="search" aria-label="Search">',
      '<img id="logo" alt="Company logo" src="' + pixel + '">',
      '<p id="exact">Exact text</p><p id="longer">Exact text and more</p>',
      '<div id="host"></div>',
      // The script source contains the shadow content's text.
      '<script>document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = \'<button id="inner" data-testid="inner">Inner button</button><input id="shadow-field" placeholder="Shadow field"><span id="shadow-text">Shadow text</span>\';</script>',
    ].join("\n"),
  ],
  [
    "/unrendered",
    [
      "<!doctype html><title>Unrendered title</title>",
      "<style>/* Style text */ p { margin: 4px }</style>",
      '<script>globalThis.note = "Script text";</script>',
      '<p id="visible">Visible text</p>',
      "<noscript><p>Fallback content</p></noscript>",
      "<template><p>Template text</p></template>",
      '<label for="field">Field label<script>/* Label script */</script><style>/* Label style */</style></label><input id="field">',
      '<div id="wrapper"><span id="wrapped">Wrapped text</span><script>/* Wrapped text */</script></div>',
      '<script>document.body.insertAdjacentHTML("beforeend", \'<p id="late">Inserted text</p>\');</script>',
    ].join("\n"),
  ],
  [
    "/form",
    [
      "<!doctype html><title>Form fixture</title>",
      '<form id="login" onsubmit="event.preventDefault(); globalThis.submitted = (globalThis.submitted ?? 0) + 1">',
      '<input id="name" aria-label="Name"><input id="second" aria-label="Second">',
      '<textarea id="notes" aria-label="Notes"></textarea><button id="go">Go</button></form>',
      '<form id="solo" onsubmit="event.preventDefault(); globalThis.soloSubmitted = true"><input id="lonely" aria-label="Lonely"></form>',
      '<div id="editor" contenteditable="true" aria-label="Editor">old</div>',
      '<input id="check" type="checkbox" aria-label="Accept"><input id="radio" type="radio" aria-label="Pick">',
      '<select id="choice" aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select>',
      '<input id="disabled" aria-label="Disabled" disabled><input id="readonly" aria-label="Readonly" readonly value="fixed">',
      '<p id="para" title="Para title" data-x="1">Paragraph <b>text</b></p>',
      '<button id="hidden" style="display:none">Hidden</button><span id="invisible" style="visibility:hidden">Invisible</span>',
      '<div role="checkbox" id="aria-check" aria-checked="true">Aria check</div>',
      '<script>document.addEventListener("keydown", (e) => { if (globalThis.blockKeys) e.preventDefault(); });</script>',
      recorder,
    ].join("\n"),
  ],
  [
    "/pointer",
    [
      "<!doctype html><title>Pointer fixture</title>",
      "<style>body { margin: 0; height: 4000px } button { position: absolute; width: 120px; height: 30px }</style>",
      '<button id="target" style="left: 10px; top: 10px" onclick="globalThis.clicks = (globalThis.clicks ?? 0) + 1">Target</button>',
      '<button id="covered" style="left: 10px; top: 60px">Covered</button>',
      '<div id="cover" style="position: absolute; left: 0; top: 50px; width: 300px; height: 60px; background: white"></div>',
      '<button id="far" style="left: 10px; top: 3000px">Far</button>',
      '<div style="display: none"><button id="gone">Gone</button></div>',
      '<div id="menu" style="position: absolute; left: 400px; top: 10px; width: 200px; height: 50px"><button id="item" style="left: 10px; top: 10px">Item</button></div>',
      '<button id="other" style="left: 700px; top: 10px">Other</button>',
      '<input id="field" aria-label="Field" style="position: absolute; left: 400px; top: 100px">',
      '<div id="host" style="position: absolute; left: 400px; top: 200px; width: 150px; height: 40px"></div>',
      '<div id="scroller" style="position: absolute; left: 10px; top: 300px; width: 200px; height: 100px; overflow: auto"><div style="height: 1000px">Inner</div></div>',
      '<svg id="icon" style="position: absolute; left: 700px; top: 100px" width="40" height="40"><rect id="shape" width="40" height="40"></rect></svg>',
      '<script>document.querySelector("#host").attachShadow({ mode: "open" }).innerHTML = \'<button id="inner" style="position: static; width: 150px; height: 40px">Inner</button>\';</script>',
      recorder,
    ].join("\n"),
  ],
  [
    "/upload",
    [
      "<!doctype html><title>Upload fixture</title>",
      '<input id="one" type="file"><input id="many" type="file" multiple><input id="text">',
      '<script>globalThis.uploads = []; for (const input of document.querySelectorAll("input[type=file]")) input.addEventListener("change", async (e) => { const trusted = e.isTrusted; const files = await Promise.all(Array.from(input.files, async (f) => ({ name: f.name, type: f.type, size: f.size, text: await f.text() }))); globalThis.uploads.push({ id: input.id, trusted, files }); });</script>',
    ].join("\n"),
  ],
]);

// page.js runs where the extension runs it: a minimal test extension page
// calls scripting.executeScript, which uses the ISOLATED world of the tab.
const addonId = "omw-page-test@oh-my-webbridge.github.io";
let firefox;
let server;
let origin;
let crossOrigin;
let runner;
let dir;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "omw-page-"));
  const extension = join(dir, "extension");
  await mkdir(extension);
  await build({
    entryPoints: { page: "extension/src/firefox/page.ts" },
    outdir: extension,
    bundle: true,
    format: "iife",
    target: "firefox153",
  });
  await writeFile(
    join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "omw page test",
      version: "1.0",
      browser_specific_settings: { gecko: { id: addonId } },
      permissions: ["scripting", "tabs"],
      host_permissions: ["<all_urls>"],
    }),
  );
  await writeFile(join(extension, "runner.html"), "<!doctype html><title>runner</title>");
  server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    const body =
      path === "/frames"
        ? '<!doctype html><title>Frames</title><iframe id="same" src="/child"></iframe><iframe id="cross" src="' +
          crossOrigin +
          '/child"></iframe>'
        : pages.get(path);
    res.statusCode = body === undefined ? 404 : 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(body ?? "missing");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = "http://127.0.0.1:" + server.address().port;
  crossOrigin = "http://localhost:" + server.address().port;
  firefox = await startFirefox({ dir, addonId });
  await firefox.installExtension({ type: "path", path: extension });
  runner = await firefox.openExtensionPage("runner.html");
});
after(async () => {
  if (firefox) await firefox.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

// Runs code in the extension page and returns its JSON value.
const extensionPage = (expression) => firefox.evaluate(runner, expression);
// Runs fn(...args) through scripting.executeScript in one frame of the tab.
async function execute(tab, fn, args = [], frameId = 0) {
  const [entry] = await extensionPage(
    "browser.scripting.executeScript({ target: { tabId: " +
      tab.tabId +
      ", frameIds: [" +
      frameId +
      "] }, func: " +
      fn +
      ", args: " +
      JSON.stringify(args) +
      " }).then((results) => results.map((r) => ({ result: r.result, error: r.error && String(r.error) })))",
  );
  if (entry.error) throw Error("executeScript: " + entry.error);
  return entry.result;
}
const inject = (tab) =>
  extensionPage(
    "browser.scripting.executeScript({ target: { tabId: " +
      tab.tabId +
      " }, files: ['page.js'] }).then(() => true)",
  );
let opened = 0;
async function open(t, path) {
  const url = origin + path + "?tab=" + ++opened;
  const context = await firefox.open(url);
  t.after(() => firefox.send("browsingContext.close", { context }));
  const [tabId] = await extensionPage(
    "browser.tabs.query({}).then((tabs) => tabs.filter((tab) => tab.url === " +
      JSON.stringify(url) +
      ").map((tab) => tab.id))",
  );
  const tab = { context, tabId, url };
  await inject(tab);
  return tab;
}
const call = (tab, op, args = {}) =>
  execute(tab, "(op, args) => globalThis.__omwPage(op, args)", [op, args]);
async function ok(tab, op, args) {
  const reply = await call(tab, op, args);
  assert.equal(reply.ok, true, op + " " + JSON.stringify(args) + ": " + JSON.stringify(reply));
  return reply.value;
}
async function failure(tab, op, args, code, message) {
  const reply = await call(tab, op, args);
  assert.equal(reply.ok, false, op + " " + JSON.stringify(args) + " succeeded");
  assert.equal(reply.code, code, reply.message);
  if (message) assert.match(reply.message, message);
}
// Evaluates in the page's own realm.
const inPage = (tab, expression) => firefox.evaluate(tab.context, expression);
const takeEvents = (tab) => inPage(tab, "globalThis.events.splice(0)");
const idOf = async (tab, selector) =>
  (await ok(tab, "get", { selector, property: "attr", attribute: "id" })).value;
const valueOf = async (tab, selector) =>
  (await ok(tab, "get", { selector, property: "value" })).value;
const generic = (tree) => tree.replace(/@e[0-9a-z]{1,13}\./gu, "@eG.");
const refFor = (tree, text) =>
  tree
    .split("\n")
    .find((line) => line.includes(text))
    .trim()
    .split(" ")[0];

test("snapshot derives roles, names, values and states in Chrome's line format", async (t) => {
  const tab = await open(t, "/snapshot");
  const snap = await ok(tab, "snapshot");
  assert.equal(snap.truncated, false);
  assert.equal(new Set(snap.tree.match(/@e[0-9a-z]{1,13}(?=\.)/gu)).size, 1);
  const password = JSON.stringify("\u2022".repeat(6));
  assert.equal(
    generic(snap.tree),
    [
      '@eG.0 RootWebArea "Snapshot fixture"',
      "  @eG.1 banner",
      '    @eG.2 navigation "Primary"',
      '      @eG.3 link "Home"',
      '        @eG.4 StaticText "Home"',
      '      @eG.5 StaticText "No link"',
      "  @eG.6 main",
      '    @eG.7 heading "Main heading"',
      '      @eG.8 StaticText "Main heading"',
      '    @eG.9 region "Sub heading"',
      '      @eG.10 heading "Sub heading"',
      '        @eG.11 StaticText "Sub heading"',
      "      @eG.12 paragraph",
      '        @eG.13 StaticText "Plain"',
      "        @eG.14 strong",
      '          @eG.15 StaticText "bold"',
      '        @eG.16 StaticText "text."',
      '    @eG.17 form "Login"',
      '      @eG.18 StaticText "User name"',
      '      @eG.19 textbox "User name" value="avery" [required=true]',
      '      @eG.20 StaticText "Password"',
      '      @eG.21 textbox "Password" value=' + password + " [required=false]",
      '      @eG.22 textbox "Email address" [required=false]',
      '      @eG.23 spinbutton "Count" value=3 [required=false]',
      '      @eG.24 checkbox "Remember" [checked=true]',
      '      @eG.25 StaticText "Remember"',
      '      @eG.26 radio "Radio A" [checked=false]',
      '      @eG.27 radio "Radio B" [checked=true]',
      '      @eG.28 combobox "Choice" value="Beta" [required=false expanded=false]',
      '        @eG.29 option "Alpha" [selected=false]',
      '        @eG.30 option "Beta" [selected=true]',
      '      @eG.31 textbox "Notes" value="note text" [required=false]',
      '      @eG.32 button "Sign in"',
      '      @eG.33 button "Menu" [expanded=false]',
      '        @eG.34 StaticText "Menu"',
      '      @eG.35 button "Disabled" [disabled=true]',
      '        @eG.36 StaticText "Disabled"',
      '      @eG.37 button "Sub heading avery"',
      '        @eG.38 StaticText "Labelled"',
      '    @eG.39 image "Logo image"',
      "    @eG.40 list",
      "      @eG.41 listitem",
      '        @eG.42 StaticText "First item"',
      "    @eG.43 tablist",
      '      @eG.44 tab "Tab one" [selected=true]',
      '        @eG.45 StaticText "Tab one"',
      '    @eG.46 checkbox "Tri" [checked=mixed]',
      '    @eG.47 StaticText "Shown child"',
      '    @eG.48 generic value="Editable"',
      '      @eG.49 StaticText "Editable"',
      "    @eG.50 group",
      '      @eG.51 DisclosureTriangle "More" [expanded=false]',
      '        @eG.52 StaticText "More"',
      "    @eG.53 generic",
      '      @eG.54 button "Shadow button"',
      '        @eG.55 StaticText "Shadow button"',
      '    @eG.56 Iframe "Inner frame"',
      "  @eG.57 contentinfo",
      '    @eG.58 StaticText "Footer text"',
    ].join("\n"),
  );
  // interactive keeps the tree depth of each control.
  assert.equal(
    generic((await ok(tab, "snapshot", { interactive: true })).tree),
    [
      '      @eG.0 link "Home"',
      '      @eG.1 textbox "User name" value="avery" [required=true]',
      '      @eG.2 textbox "Password" value=' + password + " [required=false]",
      '      @eG.3 textbox "Email address" [required=false]',
      '      @eG.4 spinbutton "Count" value=3 [required=false]',
      '      @eG.5 checkbox "Remember" [checked=true]',
      '      @eG.6 radio "Radio A" [checked=false]',
      '      @eG.7 radio "Radio B" [checked=true]',
      '      @eG.8 combobox "Choice" value="Beta" [required=false expanded=false]',
      '      @eG.9 textbox "Notes" value="note text" [required=false]',
      '      @eG.10 button "Sign in"',
      '      @eG.11 button "Menu" [expanded=false]',
      '      @eG.12 button "Disabled" [disabled=true]',
      '      @eG.13 button "Sub heading avery"',
      '      @eG.14 tab "Tab one" [selected=true]',
      '    @eG.15 checkbox "Tri" [checked=mixed]',
      '      @eG.16 button "Shadow button"',
    ].join("\n"),
  );
  assert.equal(
    generic((await ok(tab, "snapshot", { maxDepth: 1 })).tree),
    [
      '@eG.0 RootWebArea "Snapshot fixture"',
      "  @eG.1 banner",
      "  @eG.2 main",
      "  @eG.3 contentinfo",
    ].join("\n"),
  );
  const page = await ok(tab, "read_page");
  assert.equal(page.url, tab.url);
  assert.equal(page.title, "Snapshot fixture");
  assert.match(page.text, /Main heading/u);
  const found = await ok(tab, "find", { query: "BUTTON" });
  assert.equal(found.truncated, false);
  assert.deepEqual(
    found.matches.map((line) => generic(line).trim()),
    [
      '@eG.23 spinbutton "Count" value=3 [required=false]',
      '@eG.32 button "Sign in"',
      '@eG.33 button "Menu" [expanded=false]',
      '@eG.35 button "Disabled" [disabled=true]',
      '@eG.37 button "Sub heading avery"',
      '@eG.54 button "Shadow button"',
      '@eG.55 StaticText "Shadow button"',
    ],
  );
  await failure(tab, "find", {}, "invalid_args", /query is required/u);
});

test("snapshot stops at 4000 lines or 192000 bytes", async (t) => {
  const many = await open(t, "/many");
  const lines = await ok(many, "snapshot");
  assert.equal(lines.truncated, true);
  assert.equal(lines.tree.split("\n").length, 4000);
  const found = await ok(many, "find", { query: "mark" });
  assert.equal(found.matches.length, 100);
  assert.equal(found.truncated, true);
  const long = await open(t, "/long");
  const bytes = await ok(long, "snapshot");
  assert.equal(bytes.truncated, true);
  const rows = bytes.tree.split("\n");
  const size = rows.reduce((total, row) => total + row.length, 0);
  assert.ok(size >= 192000 && size < 192000 + 1100, String(size));
  assert.ok(rows.every((row) => row.length < 1100));
  assert.match(rows[2], /StaticText "x{1000}"$/u);
});

test("element references belong to one snapshot of one document", async (t) => {
  const tab = await open(t, "/snapshot");
  let tree = (await ok(tab, "snapshot")).tree;
  const menu = refFor(tree, 'button "Menu"');
  await ok(tab, "click", { selector: menu });
  assert.equal(await inPage(tab, "globalThis.menuClicks"), 1);
  const footer = refFor(tree, 'StaticText "Footer text"');
  assert.equal((await ok(tab, "get", { selector: footer })).value, "Footer text");
  // A second injection keeps the installed page.js and its references.
  await inject(tab);
  assert.equal((await ok(tab, "get", { selector: menu })).value, "Menu");
  tree = (await ok(tab, "snapshot")).tree;
  await failure(tab, "click", { selector: menu }, "stale_ref", /take a fresh snapshot/u);
  await failure(tab, "get", { selector: "@enope" }, "stale_ref");
  await inPage(tab, "document.querySelector('nav a').remove()");
  await failure(
    tab,
    "get",
    { selector: refFor(tree, 'link "Home"') },
    "stale_ref",
    /no longer exists/u,
  );
  const shadow = refFor(tree, 'button "Shadow button"');
  assert.deepEqual(await ok(tab, "clear_refs"), { cleared: true });
  await failure(tab, "get", { selector: shadow }, "stale_ref");

  tree = (await ok(tab, "snapshot")).tree;
  const heading = refFor(tree, 'heading "Main heading"');
  // A newly loaded document has no lastPageshow property.
  await inPage(
    tab,
    "addEventListener('pageshow', (event) => { globalThis.lastPageshow = event.persisted ? 'persisted' : 'loaded' }), globalThis.lastPageshow = null",
  );
  // The page navigates itself, so the content process opens the load with its
  // channel id. A browsingContext.navigate load starts in the parent process;
  // when its response arrives before the content process claims it, Firefox
  // counts the claiming channel as a pending request and does not cache the page.
  const { subscription } = await firefox.send("session.subscribe", {
    events: ["browsingContext.load"],
    contexts: [tab.context],
  });
  const loaded = new Promise((done) => {
    const stop = firefox.onEvent(({ method, params }) => {
      if (method === "browsingContext.load" && params.context === tab.context) {
        stop();
        done(params.url);
      }
    });
  });
  await inPage(tab, "location.assign('/next')");
  assert.equal(await loaded, origin + "/next");
  await firefox.send("session.unsubscribe", { subscriptions: [subscription] });
  await firefox.send("browsingContext.traverseHistory", { context: tab.context, delta: -1 });
  const shown = await until(
    () =>
      inPage(
        tab,
        "location.pathname === '/snapshot' && document.readyState === 'complete' && ('lastPageshow' in globalThis ? globalThis.lastPageshow : 'new document')",
      ),
    "history back",
  );
  // The back-forward cache restored the document together with its ISOLATED
  // world and the installed page.js; pageshow has dropped the references.
  assert.equal(shown, "persisted");
  assert.equal(await execute(tab, "() => typeof globalThis.__omwPage"), "function");
  await failure(tab, "get", { selector: heading }, "stale_ref");
});

test("locators cover CSS, text, attributes, XPath, roles, nth and open shadow roots", async (t) => {
  const tab = await open(t, "/locators");
  const count = async (selector) => (await ok(tab, "get", { selector, property: "count" })).value;
  assert.equal(await idOf(tab, "#save"), "save");
  assert.equal(await idOf(tab, "css=#draft"), "draft");
  assert.equal(await count("button"), 3);
  assert.equal(await idOf(tab, "button >>nth=1"), "draft");
  assert.equal(await idOf(tab, "button >>nth=-1"), "inner");
  assert.equal(await count("text=save"), 2);
  assert.equal(await idOf(tab, 'text="Save"'), "save");
  assert.equal(await count("text=Exact text"), 2);
  assert.equal(await idOf(tab, 'text="Exact text"'), "exact");
  assert.equal(await idOf(tab, "text=Shadow text"), "shadow-text");
  assert.equal(await idOf(tab, "label=Email"), "email");
  assert.equal(await idOf(tab, 'label="Search"'), "search");
  assert.equal(await idOf(tab, "placeholder=you@"), "email");
  assert.equal(await idOf(tab, 'placeholder="Shadow field"'), "shadow-field");
  assert.equal(await idOf(tab, "alt=logo"), "logo");
  assert.equal(await idOf(tab, 'title="Save title"'), "save");
  assert.equal(await idOf(tab, "testid=save-button"), "save");
  assert.equal(await idOf(tab, "testid=inner"), "inner");
  assert.equal(await count("xpath=//p"), 2);
  assert.equal(await count("xpath=//button"), 2);
  assert.equal(await idOf(tab, "xpath=//p >>nth=1"), "longer");
  assert.equal(await idOf(tab, 'role=button[name="Save"]'), "save");
  assert.equal(await count("role=button"), 3);
  assert.equal(await idOf(tab, "role=button >>nth=1"), "draft");
  assert.equal(await idOf(tab, 'role=textbox[name="Email"]'), "email");
  assert.equal(await idOf(tab, 'role=textbox[name="Shadow field"]'), "shadow-field");
  assert.equal(await count("#nope"), 0);
  await failure(tab, "get", { selector: "role=button[name=Save]" }, "invalid_args", /JSON/u);
  await failure(tab, "get", { selector: "role=" }, "invalid_args", /role syntax/u);
  await failure(tab, "get", { selector: "button[" }, "invalid_args");
  await failure(tab, "get", { selector: 'text="a"b"' }, "invalid_args", /JSON/u);
  await failure(tab, "click", { selector: "#nope" }, "element_missing", /#nope/u);

  assert.deepEqual(await ok(tab, "locate", { by: "testid", value: "inner" }), {
    value: "Inner button",
  });
  await ok(tab, "locate", { by: "role", value: "button", name: "Save draft", cmd: "click" });
  assert.equal(await inPage(tab, "globalThis.drafts"), 1);
  assert.deepEqual(
    await ok(tab, "locate", {
      by: "css",
      value: "button",
      nth: -1,
      property: "attr",
      attribute: "id",
    }),
    { value: "inner" },
  );
  await ok(tab, "locate", { by: "label", value: "Email", cmd: "fill", text: "a@b.c" });
  assert.equal(await valueOf(tab, "#email"), "a@b.c");
  await failure(tab, "locate", { value: "button", nth: 1.5 }, "invalid_args");
  await failure(tab, "locate", { value: "button", cmd: "locate" }, "invalid_args");
  await failure(tab, "locate", { by: "css" }, "invalid_args", /value is required/u);
  await failure(tab, "frame", { selector: "#save" }, "frame_missing");
  await failure(tab, "teleport", {}, "invalid_args", /unknown page operation/u);
});

test("text and label locators ignore script, style, title, noscript and template text", async (t) => {
  const tab = await open(t, "/unrendered");
  const count = async (selector) => (await ok(tab, "get", { selector, property: "count" })).value;
  for (const text of [
    "Unrendered title",
    "Style text",
    "Script text",
    "Fallback content",
    "Template text",
    "Label script",
  ])
    assert.equal(await count("text=" + text), 0, text);
  assert.equal(await idOf(tab, "text=Visible text"), "visible");
  assert.equal(await count("text=Wrapped text"), 1);
  assert.equal(await idOf(tab, "text=Wrapped text"), "wrapped");
  assert.equal(await idOf(tab, "text=Inserted text"), "late");
  assert.equal(await idOf(tab, 'label="Field label"'), "field");
  assert.equal(await count("label=Label script"), 0);
  assert.equal(await count("label=Label style"), 0);
});

test("get, is, focus, check, select_option, wait and storage read and change the DOM", async (t) => {
  const tab = await open(t, "/form");
  const get = async (selector, property, extra = {}) =>
    (await ok(tab, "get", { selector, property, ...extra })).value;
  const is = async (selector, property) => (await ok(tab, "is", { selector, property })).value;
  assert.equal(await get("#para", "text"), "Paragraph text");
  assert.equal(await get("#para", "html"), "Paragraph <b>text</b>");
  assert.equal(await get("#para", "attr", { attribute: "data-x" }), "1");
  assert.equal(await get("#readonly", "value"), "fixed");
  assert.equal(await get("#para", "value"), null);
  assert.ok((await get("#para", "box")).width > 0);
  assert.equal((await get("#para", "styles")).display, "block");
  assert.equal(await get("input", "count"), 7);
  assert.equal(await get(undefined, "title"), "Form fixture");
  assert.equal(await get(undefined, "url"), tab.url);
  await failure(tab, "get", { selector: "#para", property: "bogus" }, "invalid_args");
  await failure(tab, "get", { selector: "#nope", property: "bogus" }, "invalid_args");
  await failure(tab, "get", {}, "invalid_args", /selector is required/u);
  assert.equal(await is("#para", "visible"), true);
  assert.equal(await is("#hidden", "visible"), false);
  assert.equal(await is("#invisible", "visible"), false);
  assert.equal(await is("#disabled", "enabled"), false);
  assert.equal(await is("#name", "enabled"), true);
  assert.equal(await is("#aria-check", "checked"), true);
  assert.equal(await is("#check", "checked"), false);
  assert.equal(await is("#readonly", "editable"), false);
  assert.equal(await is("#name", "editable"), true);
  assert.equal(await is("#editor", "editable"), true);
  assert.equal(await is("#para", "editable"), false);
  await failure(tab, "is", { selector: "#para", property: "pretty" }, "invalid_args");

  assert.deepEqual(await ok(tab, "focus", { selector: "#second" }), { success: true });
  assert.equal(await inPage(tab, "document.activeElement.id"), "second");
  await failure(tab, "focus", { selector: "#para" }, "element_action_failed");

  assert.deepEqual(await ok(tab, "check", { selector: "#check" }), {
    success: true,
    checked: true,
  });
  await ok(tab, "check", { selector: "#check" });
  assert.equal(await inPage(tab, "document.querySelector('#check').checked"), true);
  await ok(tab, "uncheck", { selector: "#check" });
  assert.equal(await inPage(tab, "document.querySelector('#check').checked"), false);
  await ok(tab, "check", { selector: "#radio" });
  await failure(tab, "uncheck", { selector: "#radio" }, "invalid_args");
  await failure(tab, "check", { selector: "#name" }, "invalid_args");

  await takeEvents(tab);
  assert.deepEqual(await ok(tab, "select_option", { selector: "#choice", value: "Beta" }), {
    success: true,
    value: "b",
  });
  assert.deepEqual(
    (await takeEvents(tab)).map((e) => e.type),
    ["input", "change"],
  );
  await ok(tab, "select_option", { selector: "#choice", value: "a" });
  assert.equal(await inPage(tab, "document.querySelector('#choice').value"), "a");
  await failure(
    tab,
    "select_option",
    { selector: "#choice", value: "Gamma" },
    "element_action_failed",
    /option not found/u,
  );
  await failure(
    tab,
    "select_option",
    { selector: "#name", value: "a" },
    "element_action_failed",
    /expected select/u,
  );

  const wait = async (args) => (await ok(tab, "wait", args)).matched;
  assert.equal(await wait({ selector: "#name" }), true);
  assert.equal(await wait({ selector: "#hidden" }), false);
  assert.equal(await wait({ selector: "#invisible" }), false);
  assert.equal(await wait({ selector: "#nope" }), false);
  assert.equal(await wait({ text: "Paragraph" }), true);
  assert.equal(await wait({ text: "Absent" }), false);
  assert.equal(await wait({ url: origin + "/fo*" }), true);
  assert.equal(await wait({ url: "http://other.test/*" }), false);
  assert.equal(await wait({ load: "load" }), true);
  assert.equal(await wait({ load: "domcontentloaded" }), true);
  await failure(tab, "wait", {}, "invalid_args");

  const store = (args) => ok(tab, "storage", args);
  assert.deepEqual(await store({ cmd: "set", name: "fixture", value: "stored" }), {
    origin,
    kind: "local",
    value: { fixture: "stored" },
  });
  assert.equal((await store({ cmd: "get", name: "fixture" })).value, "stored");
  assert.deepEqual((await store({})).value, { fixture: "stored" });
  assert.deepEqual((await store({ cmd: "remove", name: "fixture" })).value, {});
  await store({ cmd: "set", kind: "session", name: "tab", value: "one" });
  assert.equal(await inPage(tab, "sessionStorage.getItem('tab')"), "one");
  assert.deepEqual((await store({ cmd: "clear", kind: "session" })).value, {});
  await failure(tab, "storage", { cmd: "drop" }, "invalid_args");
  // The origin's storage quota is full: the page refuses the write.
  await inPage(tab, "localStorage.setItem('fill', 'x'.repeat(5_200_000))");
  await failure(
    tab,
    "storage",
    { cmd: "set", name: "more", value: "y".repeat(100_000) },
    "evaluation_failed",
    /^storage: QuotaExceededError: /u,
  );
  await inPage(tab, "localStorage.clear()");
});

test("fill and key_type insert text through trusted editing commands", async (t) => {
  const tab = await open(t, "/form");
  await ok(tab, "fill", { selector: "#name", value: "Avery \u00b7 \u6d4b\u8bd5" });
  assert.equal(await valueOf(tab, "#name"), "Avery \u00b7 \u6d4b\u8bd5");
  const typed = (await takeEvents(tab)).filter((e) => e.target === "name");
  assert.deepEqual(
    typed.map((e) => [e.type, e.trusted, e.inputType]),
    [
      ["beforeinput", true, "insertText"],
      ["input", true, "insertText"],
    ],
  );
  await ok(tab, "fill", { selector: "#name", value: "replaced" });
  assert.equal(await valueOf(tab, "#name"), "replaced");
  await ok(tab, "key_type", { selector: "#name", text: " more" });
  assert.equal(await valueOf(tab, "#name"), "replaced more");
  await ok(tab, "fill", { selector: "#notes", value: "line one\nline two" });
  assert.equal(await valueOf(tab, "#notes"), "line one\nline two");
  await ok(tab, "fill", { selector: "#editor", value: "rich text \u2713" });
  assert.equal(
    await inPage(tab, "document.querySelector('#editor').innerText"),
    "rich text \u2713",
  );
  await takeEvents(tab);
  await ok(tab, "fill", { selector: "#name", value: "" });
  assert.equal(await valueOf(tab, "#name"), "");
  assert.deepEqual(
    (await takeEvents(tab)).map((e) => [e.type, e.trusted, e.inputType]),
    [
      ["beforeinput", true, "deleteContentBackward"],
      ["input", true, "deleteContentBackward"],
    ],
  );
  // An empty field stays empty without an editing command.
  await ok(tab, "fill", { selector: "#name", value: "" });
  assert.deepEqual(await takeEvents(tab), []);
  await failure(
    tab,
    "fill",
    { selector: "#para", value: "x" },
    "element_action_failed",
    /not editable/u,
  );
  await failure(tab, "fill", { selector: "#name" }, "invalid_args", /value must be a string/u);
  await failure(tab, "key_type", { selector: "#name" }, "invalid_args", /text is required/u);
  await inPage(tab, "document.activeElement.blur()");
  await failure(tab, "key_type", { text: "nowhere" }, "element_action_failed", /focused editable/u);
  await failure(tab, "key_type", { selector: "#readonly", text: "x" }, "element_action_failed");
});

test("send_keys performs the default action of editing, selection, Enter and Tab", async (t) => {
  const tab = await open(t, "/form");
  const keys = (value) => ok(tab, "send_keys", { keys: value });
  await ok(tab, "fill", { selector: "#name", value: "abcd" });
  await takeEvents(tab);
  await keys("Backspace");
  assert.equal(await valueOf(tab, "#name"), "abc");
  assert.deepEqual(
    (await takeEvents(tab)).map((e) => [e.type, e.trusted, e.key ?? e.inputType]),
    [
      ["keydown", false, "Backspace"],
      ["beforeinput", true, "deleteContentBackward"],
      ["input", true, "deleteContentBackward"],
      ["keyup", false, "Backspace"],
    ],
  );
  await keys("Control+A");
  await keys("Delete");
  assert.equal(await valueOf(tab, "#name"), "");
  await ok(tab, "fill", { selector: "#name", value: "xyz" });
  await keys("Meta+a");
  await keys("Backspace");
  assert.equal(await valueOf(tab, "#name"), "");

  await inPage(tab, "globalThis.blockKeys = true");
  await ok(tab, "fill", { selector: "#name", value: "keep" });
  await keys("Backspace");
  assert.equal(await valueOf(tab, "#name"), "keep");
  await inPage(tab, "globalThis.blockKeys = false");

  await keys("Tab");
  assert.equal(await inPage(tab, "document.activeElement.id"), "second");
  await keys("Tab");
  assert.equal(await inPage(tab, "document.activeElement.id"), "notes");
  await keys("Shift+Tab");
  assert.equal(await inPage(tab, "document.activeElement.id"), "second");

  await keys("Enter");
  assert.equal(await inPage(tab, "globalThis.submitted"), 1);
  await ok(tab, "focus", { selector: "#lonely" });
  await keys("Enter");
  assert.equal(await inPage(tab, "globalThis.soloSubmitted"), true);
  await ok(tab, "fill", { selector: "#notes", value: "a" });
  await keys("Enter");
  assert.equal(await valueOf(tab, "#notes"), "a\n");
  await ok(tab, "fill", { selector: "#editor", value: "first" });
  await keys("Enter");
  assert.ok(
    await inPage(tab, "document.querySelector('#editor').childNodes.length > 1"),
    await inPage(tab, "document.querySelector('#editor').innerHTML"),
  );

  for (const key of ["ArrowLeft", "Escape", "Control+c", "Shift+a", "x"])
    await failure(
      tab,
      "send_keys",
      { keys: key },
      "unsupported",
      new RegExp("^send_keys " + key.replace("+", "\\+") + " is not available in Firefox$", "u"),
    );
});

test("pointer actions check what is under the element and dispatch the mouse sequence", async (t) => {
  const tab = await open(t, "/pointer");
  await takeEvents(tab);
  await ok(tab, "click", { selector: "#target" });
  assert.equal(await inPage(tab, "globalThis.clicks"), 1);
  const clicked = (await takeEvents(tab)).filter((e) => e.target === "target");
  assert.deepEqual(
    clicked.map((e) => e.type),
    [
      "pointerover",
      "mouseover",
      "pointerenter",
      "mouseenter",
      "pointermove",
      "mousemove",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ],
  );
  assert.ok(clicked.every((e) => e.trusted === false));
  assert.equal(await inPage(tab, "document.activeElement.id"), "target");

  await ok(tab, "dblclick", { selector: "#target" });
  const double = (await takeEvents(tab)).filter((e) => e.target === "target");
  assert.deepEqual(
    double.filter((e) => e.type === "mousedown").map((e) => e.detail),
    [1, 2],
  );
  assert.equal(double.filter((e) => e.type === "click").length, 2);
  assert.deepEqual(
    double.filter((e) => e.type === "dblclick").map((e) => e.detail),
    [2],
  );
  await ok(tab, "click", { selector: "#target", button: "right" });
  const right = await takeEvents(tab);
  assert.deepEqual(
    right.filter((e) => e.type === "contextmenu").map((e) => e.button),
    [2],
  );
  assert.equal(right.filter((e) => e.type === "click").length, 0);
  await ok(tab, "click", { selector: "#target", button: "middle" });
  assert.deepEqual(
    (await takeEvents(tab)).filter((e) => e.type === "auxclick").map((e) => e.button),
    [1],
  );
  await failure(tab, "click", { selector: "#target", button: "side" }, "invalid_args");

  await failure(tab, "click", { selector: "#covered" }, "element_action_failed", /covered/u);
  await failure(tab, "click", { selector: "#gone" }, "element_hidden", /has no box/u);
  await failure(tab, "hover", { selector: "#covered" }, "element_action_failed");
  await failure(tab, "hover", { selector: "#gone" }, "element_hidden");

  await ok(tab, "click", { selector: "#inner" });
  assert.ok((await takeEvents(tab)).some((e) => e.type === "click" && e.target === "inner"));
  await ok(tab, "click", { selector: "#shape" });
  assert.ok((await takeEvents(tab)).some((e) => e.type === "click" && e.target === "shape"));

  const box = (await ok(tab, "get", { selector: "#target", property: "box" })).value;
  await ok(tab, "mouse_click", { x: box.x + 5, y: box.y + 5 });
  assert.equal(await inPage(tab, "globalThis.clicks"), 4);
  await failure(tab, "mouse_click", { x: -5, y: 5 }, "element_missing");
  await failure(tab, "mouse_click", { x: 5 }, "invalid_args");

  await ok(tab, "click", { selector: "#field" });
  assert.equal(await inPage(tab, "document.activeElement.id"), "field");
  await ok(tab, "mouse_click", { x: 250, y: 80 });
  assert.equal(await inPage(tab, "document.activeElement === document.body"), true);

  await takeEvents(tab);
  await ok(tab, "hover", { selector: "#item" });
  assert.ok((await takeEvents(tab)).some((e) => e.type === "mouseenter" && e.target === "menu"));
  await ok(tab, "hover", { selector: "#other" });
  const moved = await takeEvents(tab);
  assert.deepEqual(
    moved.filter((e) => e.type === "mouseleave").map((e) => e.target),
    ["item", "menu"],
  );
  assert.ok(moved.some((e) => e.type === "mouseenter" && e.target === "other"));

  await ok(tab, "click", { selector: "#far" });
  assert.ok((await inPage(tab, "scrollY")) > 2000);
});

test("scroll and rect use document coordinates", async (t) => {
  const tab = await open(t, "/pointer");
  await inPage(tab, "scrollTo(0, 0)");
  await ok(tab, "scroll", { direction: "down", amount: 300 });
  assert.equal(await inPage(tab, "scrollY"), 300);
  const box = (await ok(tab, "get", { selector: "#scroller", property: "box" })).value;
  await ok(tab, "scroll", { direction: "down", amount: 50, x: box.x + 20, y: box.y + 20 });
  assert.equal(await inPage(tab, "document.querySelector('#scroller').scrollTop"), 50);
  assert.equal(await inPage(tab, "scrollY"), 300);
  await ok(tab, "scroll", { direction: "up", amount: 100 });
  assert.equal(await inPage(tab, "scrollY"), 200);
  await failure(tab, "scroll", { amount: -1 }, "invalid_args");
  await failure(tab, "scroll", { direction: "sideways" }, "invalid_args");
  await ok(tab, "scroll", { selector: "#far" });
  const far = (await ok(tab, "get", { selector: "#far", property: "box" })).value;
  assert.ok(far.y >= 0 && far.y < (await inPage(tab, "innerHeight")), JSON.stringify(far));

  assert.deepEqual(await ok(tab, "rect", { selector: "#far" }), {
    x: 10,
    y: 3000,
    width: 120,
    height: 30,
  });
  const full = await ok(tab, "rect", { fullPage: true });
  assert.equal(full.x, 0);
  assert.equal(full.y, 0);
  assert.equal(full.height, 4000);
  const viewport = await ok(tab, "rect");
  assert.deepEqual(
    viewport,
    await inPage(
      tab,
      "({ x: visualViewport.pageLeft, y: visualViewport.pageTop, width: visualViewport.width, height: visualViewport.height })",
    ),
  );
  assert.equal(viewport.y, await inPage(tab, "scrollY"));
});

test("upload assigns File objects built from the daemon's file contents", async (t) => {
  const tab = await open(t, "/upload");
  const file = (name, text, mimeType = "text/plain") => ({
    name,
    mimeType,
    data: Buffer.from(text).toString("base64"),
  });
  assert.deepEqual(
    await ok(tab, "upload", {
      selector: "#one",
      files: [file("notes.txt", "hello \u6d4b\u8bd5")],
    }),
    { success: true, fileCount: 1 },
  );
  await ok(tab, "upload", {
    selector: "#many",
    files: [file("a.json", "{}", "application/json"), file("b.txt", "b")],
  });
  const uploads = await until(async () => {
    const seen = await inPage(tab, "globalThis.uploads");
    return seen.length === 2 && seen;
  }, "change events");
  assert.deepEqual(uploads, [
    {
      id: "one",
      trusted: false,
      files: [
        {
          name: "notes.txt",
          type: "text/plain",
          size: Buffer.byteLength("hello \u6d4b\u8bd5"),
          text: "hello \u6d4b\u8bd5",
        },
      ],
    },
    {
      id: "many",
      trusted: false,
      files: [
        { name: "a.json", type: "application/json", size: 2, text: "{}" },
        { name: "b.txt", type: "text/plain", size: 1, text: "b" },
      ],
    },
  ]);
  await failure(
    tab,
    "upload",
    { selector: "#one", files: [file("a", "a"), file("b", "b")] },
    "invalid_args",
    /one file/u,
  );
  await failure(
    tab,
    "upload",
    { selector: "#text", files: [file("a", "a")] },
    "element_action_failed",
    /type=file/u,
  );
  await failure(tab, "upload", { selector: "#one", files: [] }, "invalid_args");
  await failure(tab, "upload", { selector: "#one", files: ["/etc/hosts"] }, "invalid_args");
  await failure(
    tab,
    "upload",
    { selector: "#one", files: [{ name: "bad", mimeType: "text/plain", data: "%%%" }] },
    "invalid_args",
    /base64/u,
  );
});

test("frame returns the frameId that scripting.executeScript uses for the iframe", async (t) => {
  const tab = await open(t, "/frames");
  for (const [selector, frameOrigin] of [
    ["#same", origin],
    ["#cross", crossOrigin],
  ]) {
    const { frameId } = await ok(tab, "frame", { selector });
    assert.ok(Number.isSafeInteger(frameId) && frameId > 0, String(frameId));
    assert.equal(await execute(tab, "() => location.href", [], frameId), frameOrigin + "/child");
  }
  await failure(tab, "frame", { selector: "body" }, "frame_missing");
});
