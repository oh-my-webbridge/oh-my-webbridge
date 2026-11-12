import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { FiltersEngine } from "@ghostery/adblocker";
import { bundle, firefoxApi } from "./fixtures/firefox-api.mjs";

const owned = {
  sessions: { task: { tabs: [5], borrowed: [], current: 5, title: "task" } },
  tabs: [{ id: 5, url: "https://example.test/", title: "Example" }],
};
async function fixture(t, options = owned) {
  const original = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };
  const api = firefoxApi(options);
  globalThis.chrome = api.chrome;
  const bytes = FiltersEngine.parse("||tracker.test^").serialize();
  globalThis.fetch = async () => new Response(bytes);
  // The engine's idle release timer must not keep the test process alive.
  globalThis.setTimeout = (...args) => original.setTimeout(...args).unref();
  t.after(() => Object.assign(globalThis, original));
  const m = await bundle(
    'export { execute } from "./extension/src/firefox/actions.ts"; import { initSessions } from "./extension/src/state.ts"; await initSessions(async () => {});',
    t.name,
  );
  // Like bridge.ts, check fails once the request is cancelled.
  const run = (
    action,
    args,
    signal = new AbortController().signal,
    deadline = Date.now() + 30000,
  ) =>
    m.execute(
      { session: "task", action, args },
      {
        signal,
        deadline,
        check: () => {
          if (signal.aborted)
            throw {
              code: "outcome_unknown",
              message: "request deadline reached; observe before retrying",
            };
        },
      },
    );
  return { ...api, run };
}

test("actions Firefox cannot perform fail as unsupported without opening a session", async (t) => {
  const f = await fixture(t, {});
  for (const action of [
    "save_as_pdf",
    "dialog",
    "drag",
    "mouse",
    "console",
    "cdp",
    "cdp_attach",
    "cdp_detach",
    "list_targets",
    "artifact_read",
  ])
    await assert.rejects(f.run(action, {}), {
      code: "unsupported",
      message: new RegExp(`^${action} is not available in Firefox: `),
    });
  assert.deepEqual(f.state.sessions, {});
});

test("page actions install page.js once per document and keep its result", async (t) => {
  const calls = [];
  const f = await fixture(t, {
    ...owned,
    page: async (op, args) => {
      calls.push({ op, args });
      return { ok: true, value: { success: true } };
    },
  });
  assert.deepEqual(await f.run("click", { selector: "#go" }), { success: true });
  assert.deepEqual(await f.run("hover", { selector: "#menu" }), { success: true });
  assert.deepEqual(calls, [
    { op: "click", args: { selector: "#go" } },
    { op: "hover", args: { selector: "#menu" } },
  ]);
  assert.deepEqual(
    f.state.executed.map((e) => (e.files ? e.files : e.args[0])),
    ["click", ["page.js"], "click", "hover"],
  );
  assert.ok(f.state.executed.every((e) => e.injectImmediately));
  assert.ok(f.state.executed.every((e) => e.target.tabId === 5 && e.target.frameIds[0] === 0));
});

test("page failures keep their error code", async (t) => {
  const f = await fixture(t, {
    ...owned,
    page: async () => ({ ok: false, code: "element_missing", message: "no element matches #x" }),
  });
  await assert.rejects(f.run("get", { selector: "#x" }), {
    code: "element_missing",
    message: "no element matches #x",
  });
});

test("snapshot adds the tab URL and title", async (t) => {
  const f = await fixture(t, {
    ...owned,
    page: async () => ({ ok: true, value: { tree: '@e1.0 button "Go"', truncated: false } }),
  });
  assert.deepEqual(await f.run("snapshot", { interactive: true }), {
    url: "https://example.test/",
    title: "Example",
    tree: '@e1.0 button "Go"',
    truncated: false,
  });
});

test("a selected frame is addressed by document until it navigates away", async (t) => {
  const frameId = 12884901889;
  const f = await fixture(t, {
    ...owned,
    page: async (op, _args, documentId) => ({
      ok: true,
      value: op === "frame" ? { frameId } : { documentId },
    }),
  });
  f.state.documents.set("doc-frame", { frameId });
  assert.deepEqual(await f.run("frame", { selector: "iframe#pay" }), { frameId: String(frameId) });
  assert.deepEqual(await f.run("get", { selector: "h1" }), { documentId: "doc-frame" });
  assert.deepEqual(f.state.executed.at(-1).target, { tabId: 5, documentIds: ["doc-frame"] });
  f.state.documents.delete("doc-frame");
  await assert.rejects(f.run("get", { selector: "h1" }), { code: "frame_unavailable" });
  assert.deepEqual(await f.run("get", { selector: "h1" }), { documentId: "doc-main" });
});

test("cookies use the selected document and stop once another site replaces it", async (t) => {
  const frameId = 12884901889;
  const urls = {
    "doc-main": "https://example.test/",
    "doc-frame": "https://pay.example.test/",
    "doc-moved": "https://login.other.test/",
  };
  // webNavigation reports the URL of the frame's current document.
  const frames = [
    { frameId: 0, parentFrameId: -1, url: urls["doc-main"] },
    { frameId, parentFrameId: 0, url: urls["doc-frame"] },
  ];
  const f = await fixture(t, {
    ...owned,
    frames,
    cookies: [
      {
        name: "sid",
        value: "1",
        domain: "login.other.test",
        path: "/",
        storeId: "firefox-default",
      },
    ],
    page: async (op, args, documentId) => ({
      ok: true,
      value:
        op === "frame"
          ? { frameId }
          : op === "get" && args.property === "url"
            ? { value: urls[documentId] }
            : {},
    }),
  });
  f.state.documents.set("doc-frame", { frameId });
  await f.run("frame", { selector: "iframe#pay" });
  await f.run("cookies", {});
  assert.deepEqual(f.state.cookieQueries, [
    { url: urls["doc-frame"], storeId: "firefox-default", partitionKey: {} },
  ]);
  // The iframe navigates to another site: its frameId stays, its document changes.
  f.state.documents.delete("doc-frame");
  f.state.documents.set("doc-moved", { frameId });
  frames[1].url = urls["doc-moved"];
  await assert.rejects(f.run("cookies", { cmd: "clear" }), { code: "frame_unavailable" });
  assert.deepEqual(f.state.cookieRemovals, []);
  assert.equal(f.state.cookieQueries.length, 1);
  // The selection has ended; the next command uses the tab's URL.
  await f.run("cookies", {});
  assert.deepEqual(f.state.cookieQueries.at(-1), {
    url: urls["doc-main"],
    storeId: "firefox-default",
    partitionKey: {},
  });
});

test("evaluate runs code in the main world only with the userScripts permission", async (t) => {
  const denied = await fixture(t);
  await assert.rejects(denied.run("evaluate", { code: "6*7" }), {
    code: "unsupported",
    message: /Allow scripts/,
  });
  const f = await fixture(t, { ...owned, permissions: ["userScripts"], evaluate: 42 });
  assert.deepEqual(await f.run("evaluate", { code: "6*7" }), { type: "value", value: 42 });
  assert.deepEqual(f.state.userScripts, [
    {
      target: { tabId: 5, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      js: [{ code: "6*7" }],
    },
  ]);
});

test("wait polls the page condition and honours state:hidden", async (t) => {
  const answers = [true, true, false];
  const f = await fixture(t, {
    ...owned,
    page: async () => ({ ok: true, value: { matched: answers.shift() } }),
  });
  assert.deepEqual(await f.run("wait", { selector: ".spinner", state: "hidden" }), {
    success: true,
  });
  assert.deepEqual(answers, []);
});

test("wait reports wait_timeout before the deadline and outcome_unknown when cancelled", async (t) => {
  const f = await fixture(t, {
    ...owned,
    page: async () => ({ ok: true, value: { matched: false } }),
  });
  const deadline = Date.now() + 800;
  await assert.rejects(f.run("wait", { url: "*nomatch*" }, undefined, deadline), {
    code: "wait_timeout",
  });
  assert.ok(Date.now() < deadline, "wait answers before the request deadline");
  const abort = new AbortController();
  const pending = f.run("wait", { selector: "#nope" }, abort.signal);
  await new Promise((resolve) => setTimeout(resolve, 120));
  abort.abort();
  await assert.rejects(pending, { code: "outcome_unknown" });
});

test("emulate adds request headers and reports every other field as unsupported", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("emulate", { width: 800, offline: true }), {
    code: "unsupported",
    message: /^emulate width, offline is not available in Firefox/,
  });
  assert.deepEqual(await f.run("emulate", { data: { "X-Test": "1" } }), { success: true });
  const [listener] = f.chrome.webRequest.onBeforeSendHeaders.listeners;
  assert.deepEqual(listener.filter, { urls: ["<all_urls>"], tabId: 5 });
  assert.deepEqual(listener.extra, ["blocking", "requestHeaders"]);
  assert.deepEqual(
    listener.fn({
      requestHeaders: [
        { name: "x-test", value: "0" },
        { name: "Accept", value: "*/*" },
      ],
    }),
    {
      requestHeaders: [
        { name: "Accept", value: "*/*" },
        { name: "X-Test", value: "1" },
      ],
    },
  );
  assert.deepEqual(f.state.sessions.task.settings, { data: { "X-Test": "1" } });
});

test("navigate filters a new task tab before loading it and waits for the commit", async (t) => {
  const f = await fixture(t, { commit: false });
  const pending = f.run("navigate", { url: "https://example.test/" });
  for (let i = 0; i < 20 && !f.state.navigations.length; i++) await setImmediate();
  assert.deepEqual(f.state.navigations, [{ tabId: 7, url: "https://example.test/" }]);
  const [blocking] = f.chrome.webRequest.onBeforeRequest.listeners;
  assert.deepEqual(blocking.filter, { urls: ["<all_urls>"], tabId: 7 });
  assert.deepEqual(blocking.extra, ["blocking"]);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false, "navigate waits for the new document");
  f.state.top.before(7, "https://example.test/");
  f.state.top.commit(7, "https://example.test/");
  f.state.top.complete(7, "https://example.test/");
  assert.deepEqual(await pending, { success: true, tabId: 7, url: "https://example.test/" });
  assert.deepEqual(f.state.groups, [{ tabIds: [7], groupId: undefined }]);
  assert.deepEqual(f.state.sessions.task.tabs, [7]);
  assert.equal(f.state.sessions.task.preset.name, "anti-ad");
});

// Resolves once pending settles or after ms, reporting which came first.
async function settlesWithin(pending, ms) {
  return Promise.race([
    pending.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

test("navigate loads a new tab only after the tab's own about:blank document", async (t) => {
  const url = "https://example.test/";
  const f = await fixture(t, { commit: false, blank: false });
  const pending = f.run("navigate", { url });
  for (let i = 0; i < 20 && !f.state.tabs.has(7); i++) await setImmediate();
  assert.equal(await settlesWithin(pending, 150), false);
  // A navigation issued now could be replaced by the late about:blank load.
  assert.deepEqual(f.state.navigations, [], "the tab is still loading about:blank");
  f.state.top.before(7, "about:blank");
  f.state.top.commit(7, "about:blank");
  f.state.top.complete(7, "about:blank");
  for (let i = 0; i < 20 && !f.state.navigations.length; i++) await setImmediate();
  assert.deepEqual(f.state.navigations, [{ tabId: 7, url }]);
  // The target load then moves to another content process; the tab reads
  // complete in between.
  f.state.top.before(7, url);
  f.state.top.abort(7, url);
  f.state.tabs.get(7).status = "complete";
  assert.equal(await settlesWithin(pending, 150), false, "the target has not committed");
  f.state.top.before(7, url);
  f.state.top.commit(7, url);
  assert.equal(await settlesWithin(pending, 150), false, "the target has not loaded");
  f.state.top.complete(7, url);
  assert.deepEqual(await pending, { success: true, tabId: 7, url });
});

test("navigate creates a tab only once Firefox has attached the navigation listeners", async (t) => {
  const url = "https://example.test/";
  const f = await fixture(t, { webNavigation: "manual" });
  const pending = f.run("navigate", { url });
  assert.equal(await settlesWithin(pending, 150), false);
  // Events of a tab created now would never reach the listeners.
  assert.equal(f.state.tabs.has(7), false, "no tab before the listeners are attached");
  f.state.loadWebNavigation();
  assert.deepEqual(await pending, { success: true, tabId: 7, url });
});

test("navigate ends without a new document when the response is downloaded", async (t) => {
  const url = "https://example.test/file.bin";
  const f = await fixture(t, { ...owned, commit: false });
  const pending = f.run("navigate", { url });
  for (let i = 0; i < 20 && !f.state.navigations.length; i++) await setImmediate();
  f.state.top.before(5, url);
  // A process switch also aborts the load and reads complete; it starts again.
  f.state.top.abort(5, url);
  f.state.tabs.get(5).status = "complete";
  f.chrome.tabs.onUpdated.emit(5, { status: "complete" }, { ...f.state.tabs.get(5) });
  assert.equal(await settlesWithin(pending, 150), false, "an aborted load is not the end");
  f.state.top.before(5, url);
  // Firefox completes an attachment load without committing a document.
  f.state.top.complete(5, url);
  assert.deepEqual(await pending, { success: true, tabId: 5, url: "https://example.test/" });
});

for (const statusCode of [204, 205])
  test(`navigate ends on the current document when the response is ${statusCode}`, async (t) => {
    const url = `https://example.test/empty-${statusCode}`;
    const f = await fixture(t, { ...owned, commit: false });
    const pending = f.run("navigate", { url });
    for (let i = 0; i < 20 && !f.state.navigations.length; i++) await setImmediate();
    f.state.top.before(5, url);
    f.state.top.noContent(5, url, statusCode);
    assert.deepEqual(await pending, { success: true, tabId: 5, url: "https://example.test/" });
  });

// Opening a URL that answers with a download or 204 leaves the new tab on
// about:blank; the tab stays in the session like any other task tab.
for (const { label, respond } of [
  { label: "a download", respond: (f, tabId, url) => f.state.top.complete(tabId, url) },
  { label: "a 204 response", respond: (f, tabId, url) => f.state.top.noContent(tabId, url) },
])
  for (const action of ["navigate", "window_new"])
    test(`${action} into a new tab that gets ${label} keeps the blank tab in the session`, async (t) => {
      const url = "https://example.test/file";
      const f = await fixture(t, { commit: false });
      const pending = f.run(action, { url, ...(action === "navigate" ? { newTab: true } : {}) });
      for (let i = 0; i < 40 && !f.state.navigations.length; i++) await setImmediate();
      assert.deepEqual(f.state.navigations, [{ tabId: 7, url }]);
      f.state.top.before(7, url);
      respond(f, 7, url);
      assert.deepEqual(
        await pending,
        action === "navigate"
          ? { success: true, tabId: 7, url: "about:blank" }
          : { tabId: 7, windowId: 3 },
      );
      assert.deepEqual(f.state.removed, []);
      assert.deepEqual(f.state.sessions.task.tabs, [7]);
      const { tabs } = await f.run("list_tabs", {});
      assert.deepEqual(
        tabs.map((tab) => [tab.tabId, tab.url]),
        [[7, "about:blank"]],
      );
    });

// The request of a navigation, as webRequest reports it.
function request(f, tabId, url, extra = {}) {
  return f.chrome.webRequest.onBeforeRequest.emit({
    tabId,
    frameId: 0,
    requestId: "9",
    type: "main_frame",
    method: "GET",
    url,
    ...extra,
  });
}

test("navigate ends on the current document when a preset blocks it", async (t) => {
  const url = "https://tracker.test/landing";
  const f = await fixture(t, { ...owned, commit: false });
  const pending = f.run("navigate", { url, preset: "anti-ad" });
  for (let i = 0; i < 40 && !f.state.navigations.length; i++) await setImmediate();
  f.state.top.before(5, url);
  assert.deepEqual(request(f, 5, url), [{ cancel: true }]);
  // Firefox keeps the tab's document and reports no error for the cancelled load.
  f.state.tabs.get(5).status = "complete";
  f.chrome.tabs.onUpdated.emit(5, { status: "complete" }, { ...f.state.tabs.get(5) });
  assert.deepEqual(await pending, { success: true, tabId: 5, url: "https://example.test/" });
});

test("a preset blocking the redirect target of a new tab ends its navigation", async (t) => {
  const url = "https://example.test/out";
  const f = await fixture(t, { commit: false });
  const pending = f.run("navigate", { url });
  for (let i = 0; i < 40 && !f.state.navigations.length; i++) await setImmediate();
  f.state.top.before(7, url);
  assert.deepEqual(request(f, 7, url), [undefined]);
  f.chrome.webRequest.onBeforeRedirect.emit({
    tabId: 7,
    requestId: "9",
    type: "main_frame",
    url,
    redirectUrl: "https://tracker.test/ad",
  });
  assert.equal(await settlesWithin(pending, 50), false);
  assert.deepEqual(request(f, 7, "https://tracker.test/ad"), [{ cancel: true }]);
  assert.deepEqual(await pending, { success: true, tabId: 7, url: "about:blank" });
  assert.deepEqual(f.state.sessions.task.tabs, [7]);
});

test("a request the page starts itself does not end navigate", async (t) => {
  const url = "https://example.test/next";
  const f = await fixture(t, { ...owned, commit: false });
  const pending = f.run("navigate", { url, preset: "anti-ad" });
  for (let i = 0; i < 40 && !f.state.navigations.length; i++) await setImmediate();
  f.state.top.before(5, url);
  // The old document navigates to a blocked address and to a 204 response.
  request(f, 5, "https://tracker.test/pixel", { requestId: "10" });
  f.chrome.webRequest.onHeadersReceived.emit({
    tabId: 5,
    frameId: 0,
    requestId: "11",
    type: "main_frame",
    url: "https://example.test/beacon",
    statusCode: 204,
  });
  assert.equal(await settlesWithin(pending, 150), false);
  f.state.top.commit(5, url);
  f.state.top.complete(5, url);
  assert.deepEqual(await pending, { success: true, tabId: 5, url });
});

test("a 200 response after a process switch still waits for the new document", async (t) => {
  const url = "https://other.test/";
  const f = await fixture(t, { ...owned, commit: false });
  const pending = f.run("navigate", { url });
  for (let i = 0; i < 20 && !f.state.navigations.length; i++) await setImmediate();
  f.state.top.before(5, url);
  f.state.top.abort(5, url);
  f.chrome.webRequest.onHeadersReceived.emit({
    tabId: 5,
    frameId: 0,
    type: "main_frame",
    url,
    statusCode: 200,
  });
  assert.equal(await settlesWithin(pending, 150), false);
  f.state.top.before(5, url);
  f.state.top.commit(5, url);
  f.state.top.complete(5, url);
  assert.deepEqual(await pending, { success: true, tabId: 5, url });
});

test("a cancelled navigation wait reports outcome_unknown and what it saw", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const f = await fixture(t, {
    ...owned,
    commit: false,
    history: { back: "https://example.test/previous" },
  });
  for (const [action, args] of [
    ["navigate", { url: "https://example.test/next" }],
    ["history", { cmd: "back" }],
    ["history", { cmd: "forward" }],
  ]) {
    const abort = new AbortController();
    const pending = f.run(action, args, abort.signal);
    for (let i = 0; i < 20; i++) await setImmediate();
    abort.abort();
    await assert.rejects(pending, { code: "outcome_unknown" }, JSON.stringify([action, args]));
  }
  assert.match(warnings.mock.calls[0].arguments[0], /^navigation of tab 5 did not finish: /);
});

test("a cancelled wait for a new tab's about:blank load reports outcome_unknown", async (t) => {
  t.mock.method(console, "warn", () => {});
  const f = await fixture(t, { commit: false, blank: false });
  for (const action of ["navigate", "window_new"]) {
    const abort = new AbortController();
    const pending = f.run(action, { url: "https://example.test/" }, abort.signal);
    for (let i = 0; i < 20; i++) await setImmediate();
    abort.abort();
    await assert.rejects(pending, { code: "outcome_unknown" }, action);
  }
});

test("window_new loads its tab only after the window's about:blank document", async (t) => {
  const url = "https://example.test/";
  const f = await fixture(t, { commit: false, blank: false });
  const pending = f.run("window_new", { url });
  for (let i = 0; i < 20 && !f.state.tabs.has(7); i++) await setImmediate();
  assert.equal(await settlesWithin(pending, 150), false);
  assert.deepEqual(f.state.navigations, []);
  f.state.top.before(7, "about:blank");
  f.state.top.commit(7, "about:blank");
  f.state.top.complete(7, "about:blank");
  for (let i = 0; i < 20 && !f.state.navigations.length; i++) await setImmediate();
  assert.deepEqual(f.state.navigations, [{ tabId: 7, url }]);
  f.state.top.before(7, url);
  f.state.top.commit(7, url);
  f.state.top.complete(7, url);
  assert.deepEqual(await pending, { tabId: 7, windowId: 3 });
});

test("navigate ends on a tab status update when Firefox shows an error page", async (t) => {
  const url = "http://127.0.0.1:9/";
  const f = await fixture(t, { ...owned, commit: false });
  const pending = f.run("navigate", { url });
  for (let i = 0; i < 20 && !f.state.navigations.length; i++) await setImmediate();
  // A refused connection commits the error page without onCompleted.
  const tab = f.state.tabs.get(5);
  tab.url = url;
  f.chrome.webNavigation.onCommitted.emit({ tabId: 5, frameId: 0, url });
  assert.equal(await settlesWithin(pending, 150), false);
  tab.status = "complete";
  f.chrome.tabs.onUpdated.emit(5, { status: "complete", url }, { ...tab });
  assert.deepEqual(await pending, { success: true, tabId: 5, url });
});

test("navigate to a fragment of the current page ends with the same-document update", async (t) => {
  const url = "https://example.test/#part";
  const f = await fixture(t, { ...owned, commit: false });
  const pending = f.run("navigate", { url });
  for (let i = 0; i < 20 && !f.state.navigations.length; i++) await setImmediate();
  const tab = f.state.tabs.get(5);
  tab.url = url;
  tab.status = "complete";
  f.chrome.webNavigation.onReferenceFragmentUpdated.emit({ tabId: 5, frameId: 0, url });
  assert.deepEqual(await pending, { success: true, tabId: 5, url });
});

test("history back across sites waits for the restarted load", async (t) => {
  const previous = "https://other.test/";
  const f = await fixture(t, { ...owned, commit: false, history: { back: previous } });
  const pending = f.run("history", { cmd: "back" });
  for (let i = 0; i < 20 && !f.state.navigations.length; i++) await setImmediate();
  f.state.top.before(5, previous);
  f.state.top.abort(5, previous);
  // Between the two loads the tab reads complete.
  f.state.tabs.get(5).status = "complete";
  assert.equal(await settlesWithin(pending, 150), false, "the entry has not committed");
  f.state.top.before(5, previous);
  f.state.top.commit(5, previous);
  f.state.top.complete(5, previous);
  assert.deepEqual(await pending, { success: true, url: previous });
});

test("history back follows the previous entry and reports a missing one", async (t) => {
  const f = await fixture(t, { ...owned, history: { back: "https://example.test/previous" } });
  assert.deepEqual(await f.run("history", { cmd: "back" }), {
    success: true,
    url: "https://example.test/previous",
  });
  await assert.rejects(f.run("history", { cmd: "forward" }), { code: "history_missing" });
  await assert.rejects(f.run("history", {}), { code: "unsupported" });
});

test("screenshot captures the page rectangle with tabs.captureTab", async (t) => {
  const rect = { x: 0, y: 120, width: 300, height: 3000 };
  const f = await fixture(t, { ...owned, page: async () => ({ ok: true, value: rect }) });
  assert.deepEqual(await f.run("screenshot", { fullPage: true, format: "jpeg", quality: 80 }), {
    data: "SU1BR0U=",
    format: "jpeg",
    mimeType: "image/jpeg",
  });
  const injections = f.state.executed.length;
  assert.deepEqual(await f.run("screenshot", {}), {
    data: "SU1BR0U=",
    format: "png",
    mimeType: "image/png",
  });
  assert.deepEqual(f.state.captures, [
    { tabId: 5, format: "jpeg", quality: 80, rect },
    { tabId: 5, format: "png" },
  ]);
  assert.equal(f.state.executed.length, injections, "the viewport needs no page measurement");
});

test("upload sends the file contents the daemon read", async (t) => {
  const received = [];
  const f = await fixture(t, {
    ...owned,
    page: async (op, args) => {
      received.push({ op, args });
      return { ok: true, value: { success: true, fileCount: args.files.length } };
    },
  });
  await assert.rejects(f.run("upload", { selector: "input", files: ["/etc/hosts"] }), {
    code: "invalid_args",
  });
  const file = { name: "a.txt", mimeType: "text/plain", data: "YQ==" };
  assert.deepEqual(await f.run("upload", { selector: "input", files: [file] }), {
    success: true,
    fileCount: 1,
  });
  assert.deepEqual(received, [{ op: "upload", args: { selector: "input", files: [file] } }]);
});

// Firefox rejects downloads.cancel for an erased or a completed download.
async function refuseCancel(id) {
  throw new Error(`Download ${id} is already complete`);
}

test("a download that disappears keeps download_missing when the cancel fails", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const f = await fixture(t, { ...owned, downloadItems: () => [], cancel: refuseCancel });
  await assert.rejects(f.run("download", { url: "/file.txt" }), { code: "download_missing" });
  assert.deepEqual(f.state.downloads, [
    { url: "https://example.test/file.txt", saveAs: false, cookieStoreId: "firefox-default" },
  ]);
  assert.deepEqual(f.state.cancelled, [41]);
  assert.deepEqual(warnings.mock.calls[0].arguments, [
    "cancel download 41",
    "Download 41 is already complete",
  ]);
});

test("a download cancelled at the deadline keeps outcome_unknown when it completed", async (t) => {
  t.mock.method(console, "warn", () => {});
  const f = await fixture(t, {
    ...owned,
    downloadItems: (id) => [{ id, state: "in_progress" }],
    cancel: refuseCancel,
  });
  const abort = new AbortController();
  const pending = f.run("download", { url: "/file.txt" }, abort.signal);
  for (let i = 0; i < 20 && !f.state.downloads.length; i++) await setImmediate();
  abort.abort();
  await assert.rejects(pending, { code: "outcome_unknown" });
  assert.deepEqual(f.state.cancelled, [41]);
});

test("network records webRequest events and returns a captured body", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.run("network", { cmd: "start" }), { recording: true, capacity: 500 });
  const request = f.chrome.webRequest.onBeforeRequest.listeners[0];
  assert.deepEqual(request.filter, { urls: ["<all_urls>"], tabId: 5 });
  request.fn({
    requestId: "r1",
    url: "https://example.test/api",
    method: "GET",
    type: "xmlhttprequest",
    tabId: 5,
  });
  f.chrome.webRequest.onHeadersReceived.emit({
    requestId: "r1",
    statusCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }],
  });
  const [filter] = f.state.filters;
  const payload = new TextEncoder().encode('{"ok":true}');
  filter.ondata({ data: payload.buffer });
  filter.onstop();
  f.chrome.webRequest.onCompleted.emit({ requestId: "r1", statusCode: 200 });
  assert.deepEqual(filter.written, [payload], "the page receives the body unchanged");
  assert.equal(filter.closed, true);
  assert.deepEqual(await f.run("network", { cmd: "detail", requestId: "r1" }), {
    requestId: "r1",
    url: "https://example.test/api",
    method: "GET",
    complete: true,
    status: 200,
    mimeType: "application/json",
    body: '{"ok":true}',
    base64Encoded: false,
  });
  assert.equal((await f.run("network", { cmd: "list", filter: "/api" })).requests.length, 1);
  assert.deepEqual(await f.run("network", { cmd: "stop" }), { recording: false });
  assert.equal(f.chrome.webRequest.onBeforeRequest.listeners.length, 0);
});

test("cookies cover every partition of the page URL and map Chrome's cookie fields", async (t) => {
  const partitioned = {
    name: "sid",
    value: "1",
    domain: ".example.test",
    path: "/",
    secure: true,
    httpOnly: true,
    session: false,
    expirationDate: 1900000000,
    sameSite: "no_restriction",
    storeId: "firefox-default",
    partitionKey: { topLevelSite: "https://news.test" },
  };
  const f = await fixture(t, { ...owned, cookies: [partitioned] });
  assert.deepEqual(await f.run("cookies", {}), {
    cookies: [
      {
        name: "sid",
        value: "1",
        domain: ".example.test",
        path: "/",
        expires: 1900000000,
        httpOnly: true,
        secure: true,
        session: false,
        sameSite: "None",
        partitionKey: { topLevelSite: "https://news.test" },
      },
    ],
  });
  assert.deepEqual(f.state.cookieQueries, [
    { url: "https://example.test/", storeId: "firefox-default", partitionKey: {} },
  ]);
  await f.run("cookies", { cmd: "set", data: { name: "a", value: "b", sameSite: "Lax" } });
  assert.deepEqual(f.state.cookieWrites, [
    {
      url: "https://example.test/",
      storeId: "firefox-default",
      name: "a",
      value: "b",
      sameSite: "lax",
    },
  ]);
  await assert.rejects(f.run("cookies", { cmd: "set", data: { name: "a", sameSite: "Loose" } }), {
    code: "invalid_args",
  });
  await f.run("cookies", { cmd: "clear" });
  assert.deepEqual(f.state.cookieRemovals, [
    {
      url: "https://example.test/",
      name: "sid",
      storeId: "firefox-default",
      partitionKey: { topLevelSite: "https://news.test" },
    },
  ]);
});

test("cookies and downloads use the cookie store of the tab's container", async (t) => {
  const f = await fixture(t, {
    sessions: { task: { tabs: [], borrowed: [5], current: 5, title: "task" } },
    tabs: [{ id: 5, url: "https://example.test/", cookieStoreId: "firefox-container-2" }],
  });
  await f.run("cookies", {});
  await f.run("cookies", { cmd: "set", data: { name: "a", value: "b" } });
  await f.run("download", { url: "/file.txt" });
  assert.deepEqual(f.state.cookieQueries, [
    { url: "https://example.test/", storeId: "firefox-container-2", partitionKey: {} },
  ]);
  assert.deepEqual(f.state.cookieWrites, [
    { url: "https://example.test/", storeId: "firefox-container-2", name: "a", value: "b" },
  ]);
  assert.deepEqual(f.state.downloads, [
    {
      url: "https://example.test/file.txt",
      saveAs: false,
      cookieStoreId: "firefox-container-2",
    },
  ]);
});

// Without site access Firefox dispatches no webRequest events, so network
// capture and extra headers would report success and do nothing.
test("screenshot, cookies, network start and emulate data need access to all websites", async (t) => {
  const f = await fixture(t, { ...owned, permissions: [] });
  const listeners = () =>
    Object.values(f.chrome.webRequest)
      .filter((target) => Array.isArray(target?.listeners))
      .reduce((count, target) => count + target.listeners.length, 0);
  const before = listeners();
  for (const { action, args } of [
    { action: "screenshot", args: {} },
    { action: "cookies", args: {} },
    { action: "network", args: { cmd: "start" } },
    { action: "emulate", args: { data: { "X-Test": "1" } } },
  ])
    await assert.rejects(f.run(action, args), {
      code: "restricted_tab",
      message: new RegExp(`^${action}: .*access all websites in about:addons$`),
    });
  assert.deepEqual(f.state.captures, []);
  assert.deepEqual(f.state.cookieQueries, []);
  assert.equal(listeners(), before);
  assert.equal(f.state.sessions.task.settings, undefined);
  assert.deepEqual(await f.run("network", { cmd: "list" }), { requests: [] });
});
