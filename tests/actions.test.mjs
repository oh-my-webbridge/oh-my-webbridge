import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";
import { FiltersEngine } from "@ghostery/adblocker";

// Bundles extension modules behind the worker's startup: persisted sessions are
// restored and inherited debugger sessions released before the module resolves.
async function load(t, exports) {
  const result = await build({
    stdin: {
      contents: `${exports} import { initSessions } from "./extension/src/state.ts"; import { releaseInherited } from "./extension/src/cdp.ts"; await initSessions(releaseInherited);`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${t.name}`
  );
}

test("cancelling a new window during filter loading prevents navigation and removes the tab", async (t) => {
  const original = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const updates = [],
    removed = [];
  const bytes = FiltersEngine.parse("||tracker.test^").serialize();
  globalThis.fetch = async () => {
    entered.resolve();
    await resume.promise;
    return new Response(bytes);
  };
  globalThis.setTimeout = (...args) => {
    const timer = original.setTimeout(...args);
    timer.unref();
    return timer;
  };
  globalThis.chrome = {
    storage: { session: { get: async () => ({}), set: async () => {} } },
    windows: { create: async () => ({ id: 1, tabs: [{ id: 1 }] }) },
    tabs: {
      get: async () => ({ id: 1, url: "about:blank" }),
      update: async (...args) => updates.push(args),
      remove: async (id) => removed.push(id),
    },
    debugger: {
      attach: async () => {},
      sendCommand: async (_source, method) =>
        method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "main", url: "about:blank" } } }
          : {},
    },
    runtime: { getURL: (p) => p },
  };
  t.after(() => Object.assign(globalThis, original));
  const { execute } = await load(t, 'export { execute } from "./extension/src/actions.ts";');
  const abort = new AbortController();
  const pending = execute(
    {
      session: "cancel-test",
      action: "window_new",
      args: { url: "https://example.test/side-effect" },
    },
    { signal: abort.signal, check: () => abort.signal.throwIfAborted() },
  );
  await entered.promise;
  abort.abort(new Error("cancelled"));
  resume.resolve();
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(updates, []);
  assert.deepEqual(removed, [1]);
});

for (const tabs of [[1], [1, 2]]) {
  test(`cancelling a preset change stops remaining work with ${tabs.length} owned tabs`, async (t) => {
    const original = {
      chrome: globalThis.chrome,
      fetch: globalThis.fetch,
      setTimeout: globalThis.setTimeout,
    };
    const entered = Promise.withResolvers(),
      resume = Promise.withResolvers();
    const attached = [],
      saved = [];
    const bytes = FiltersEngine.parse("||tracker.test^").serialize();
    globalThis.fetch = async () => {
      entered.resolve();
      await resume.promise;
      return new Response(bytes);
    };
    globalThis.setTimeout = (...args) => {
      const timer = original.setTimeout(...args);
      timer.unref();
      return timer;
    };
    globalThis.chrome = {
      storage: {
        session: {
          get: async () => ({
            sessions: {
              task: { tabs, borrowed: [], current: 1, title: "task", preset: { name: "none" } },
            },
          }),
          set: async (value) => saved.push(value),
        },
      },
      tabs: { get: async (id) => ({ id, url: "https://example.test" }) },
      debugger: {
        getTargets: async () => [],
        attach: async ({ tabId }) => attached.push(tabId),
        sendCommand: async (_source, method) =>
          method === "Page.getFrameTree"
            ? { frameTree: { frame: { id: "main", url: "about:blank" } } }
            : {},
      },
      runtime: { getURL: (p) => p },
    };
    t.after(() => Object.assign(globalThis, original));
    const { execute } = await load(t, 'export { execute } from "./extension/src/actions.ts";');
    const abort = new AbortController();
    const pending = execute(
      { session: "task", action: "preset", args: { preset: "anti-ad" } },
      { signal: abort.signal, check: () => abort.signal.throwIfAborted() },
    );
    await entered.promise;
    abort.abort(new Error("cancelled"));
    resume.resolve();
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(attached, [1]);
    assert.deepEqual(saved, []);
  });
}

// actions.ts plus the worker's tab-removal handling. With hold, the first filter
// load waits until cancel() has aborted the request. Inherited tabs start with a
// debugger session left by a previous worker instance. Methods in failing reject
// while the set contains them; intercept can delay any debugger command.
// debuggerEvent delivers a chrome.debugger.onEvent event.
async function sessionFixture(
  t,
  stored,
  { hold = true, inherited = [], failing = new Set(), intercept = async () => {} } = {},
) {
  const original = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const bytes = FiltersEngine.parse("||tracker.test^").serialize();
  globalThis.fetch = async () => {
    if (hold) {
      hold = false;
      entered.resolve();
      await resume.promise;
    }
    return new Response(bytes);
  };
  globalThis.setTimeout = (...args) => {
    const timer = original.setTimeout(...args);
    timer.unref();
    return timer;
  };
  const calls = [],
    updates = [],
    removed = [],
    saved = [];
  let nextTab = 7;
  const held = new Set(inherited);
  const debuggerListeners = new Set();
  globalThis.chrome = {
    storage: {
      session: {
        get: async () => ({ sessions: stored }),
        set: async (value) => saved.push(structuredClone(value)),
      },
    },
    windows: { create: async () => ({ id: 1, tabs: [{ id: nextTab++ }] }) },
    tabs: {
      create: async () => ({ id: nextTab++ }),
      get: async (id) => ({ id, url: "https://example.test/", status: "complete" }),
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      update: async (...args) => updates.push(args),
      remove: async (id) => removed.push(id),
      group: async () => 1,
    },
    tabGroups: { update: async () => {} },
    debugger: {
      onEvent: {
        addListener: (listener) => debuggerListeners.add(listener),
        removeListener: (listener) => debuggerListeners.delete(listener),
      },
      getTargets: async () => [...held].map((tabId) => ({ type: "page", tabId, attached: true })),
      detach: async ({ tabId }) => {
        calls.push({ tabId, method: "detach" });
        held.delete(tabId);
      },
      attach: async ({ tabId }) => {
        if (held.has(tabId))
          throw Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
        calls.push({ tabId, method: "attach" });
      },
      sendCommand: async (source, method, params) => {
        calls.push({ tabId: source.tabId, sessionId: source.sessionId, method, params });
        await intercept(source, method);
        if (failing.has(method)) throw Error(`${method} failed`);
        return method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "main", url: "https://example.test/" } } }
          : {};
      },
    },
    runtime: { getURL: (p) => p },
  };
  t.after(() => Object.assign(globalThis, original));
  const m = await load(
    t,
    'export { execute } from "./extension/src/actions.ts"; export { removed } from "./extension/src/state.ts"; export { forgetPreset, presetEvent } from "./extension/src/presets.ts"; export { addRef, node, refEvent } from "./extension/src/cdp.ts";',
  );
  const run = (action, args) =>
    m.execute(
      { session: "task", action, args },
      { signal: new AbortController().signal, check: () => {} },
    );
  const cancel = async (action, args) => {
    const abort = new AbortController();
    const pending = m.execute(
      { session: "task", action, args },
      { signal: abort.signal, check: () => abort.signal.throwIfAborted() },
    );
    await entered.promise;
    abort.abort(new Error("cancelled"));
    resume.resolve();
    await assert.rejects(pending, /cancelled/);
  };
  // Mirrors chrome.tabs.onRemoved in worker.ts.
  const closed = async (tabId) => {
    m.forgetPreset(tabId);
    await m.removed(tabId);
  };
  const scriptsDisabled = (tabId) =>
    calls.some(
      (c) =>
        c.tabId === tabId &&
        c.method === "Emulation.setScriptExecutionDisabled" &&
        c.params.value === true,
    );
  const debuggerEvent = (source, method, params = {}) => {
    for (const listener of debuggerListeners) listener(source, method, params);
  };
  return {
    m,
    calls,
    updates,
    removed,
    saved,
    run,
    cancel,
    closed,
    scriptsDisabled,
    debuggerEvent,
    debuggerListeners,
  };
}
const zen = { preset: "zen", zen: { javascript: true } };

for (const action of ["navigate", "window_new"]) {
  test(`a cancelled ${action} into a new tab keeps the session preset`, async (t) => {
    const f = await sessionFixture(t, {});
    await f.cancel(action, { url: "https://example.test/", newTab: true, ...zen });
    assert.deepEqual(f.updates, [], "no navigation started");
    assert.deepEqual(f.removed, [7]);
    await f.closed(7);
    assert.equal(f.saved.at(-1).sessions.task.preset, undefined, "nothing persisted");
    assert.equal((await f.run("preset", { cmd: "status" })).config.name, "anti-ad");
    await f.run("navigate", { url: "https://example.test/later", newTab: true });
    assert.equal(f.scriptsDisabled(8), false, "a later tab does not inherit the cancelled Zen");
  });
}

test("a cancelled navigation of an owned tab keeps the session preset", async (t) => {
  const none = {
    name: "none",
    environment: false,
    images: true,
    fonts: true,
    css: false,
    javascript: false,
  };
  const f = await sessionFixture(t, {
    task: { tabs: [1], borrowed: [], current: 1, title: "task", preset: none },
  });
  await f.cancel("navigate", { url: "https://example.test/next", ...zen });
  assert.deepEqual(f.updates, [], "no navigation started");
  await f.run("navigate", { url: "https://example.test/other", newTab: true });
  assert.equal(f.scriptsDisabled(7), false, "a later tab inherits the stored none preset");
  assert.equal(f.saved.at(-1).sessions.task.preset.name, "none");
});

test("preset rejects an unknown cmd without reconfiguring tabs", async (t) => {
  const f = await sessionFixture(
    t,
    { task: { tabs: [1], borrowed: [], current: 1, title: "task" } },
    { hold: false },
  );
  await f.run("preset", { preset: "anti-ad" });
  await f.m.presetEvent(1, "Fetch.requestPaused", {
    requestId: "ad",
    resourceType: "Script",
    frameId: "main",
    request: { url: "https://tracker.test/ad.js" },
  });
  assert.equal((await f.run("preset", { cmd: "status" })).blocked, 1);
  const before = f.calls.length;
  await assert.rejects(f.run("preset", { cmd: "stats" }), {
    code: "invalid_args",
    message: "preset cmd must be status or omitted",
  });
  assert.equal(f.calls.length, before, "no tab was reconfigured");
  assert.equal((await f.run("preset", { cmd: "status" })).blocked, 1);
});

test("navigation after a worker restart detaches the inherited session and reapplies the preset", async (t) => {
  const f = await sessionFixture(
    t,
    { task: { tabs: [1], borrowed: [], current: 1, title: "task" } },
    { hold: false, inherited: [1] },
  );
  assert.equal((await f.run("preset", { cmd: "status" })).name, "none");
  const result = await f.run("navigate", { url: "https://example.test/after-restart" });
  assert.equal(result.tabId, 1);
  const order = f.calls.filter((c) => c.tabId === 1).map((c) => c.method);
  assert.deepEqual(order.slice(0, 2), ["detach", "attach"]);
  assert.ok(order.includes("Fetch.enable"));
  assert.deepEqual(f.updates, [[1, { url: "https://example.test/after-restart" }]]);
  const status = await f.run("preset", { cmd: "status" });
  assert.equal(status.name, "anti-ad");
  assert.equal(status.network, true);
});

// Commands that reconfiguring a preset sends to the current document.
const reconfiguration = /^(Fetch\.(disable|enable)|Emulation\.|Page\.)/u;
test("navigation keeps an unchanged live preset without commands to the current document", async (t) => {
  const f = await sessionFixture(
    t,
    { task: { tabs: [1], borrowed: [], current: 1, title: "task" } },
    { hold: false },
  );
  const sent = (from) =>
    f.calls.slice(from).filter((c) => c.tabId === 1 && reconfiguration.test(c.method));
  await f.run("navigate", { url: "https://example.test/first" });
  assert.ok(
    sent(0).some((c) => c.method === "Fetch.enable"),
    "the first navigation installs",
  );
  await f.m.presetEvent(1, "Fetch.requestPaused", {
    requestId: "ad",
    resourceType: "Script",
    frameId: "main",
    request: { url: "https://tracker.test/ad.js" },
  });
  let from = f.calls.length;
  await f.run("navigate", { url: "https://other.test/second" });
  assert.deepEqual(sent(from), []);
  assert.deepEqual(f.updates.at(-1), [1, { url: "https://other.test/second" }]);
  const kept = await f.run("preset", { cmd: "status" });
  assert.equal(kept.network, true);
  assert.equal(kept.blocked, 1, "counters continue across the navigation");
  for (const args of [{ preset: "zen" }, { preset: "zen", environment: true }]) {
    from = f.calls.length;
    await f.run("navigate", { url: "https://example.test/changed", ...args });
    assert.ok(
      sent(from).some((c) => c.method === "Fetch.disable"),
      `${JSON.stringify(args)} reconfigures the tab`,
    );
  }
});

test("element references outlive child frame loads but not the main document", async (t) => {
  const f = await sessionFixture(
    t,
    { task: { tabs: [1], borrowed: [], current: 1, title: "task" } },
    { hold: false },
  );
  const live = async (ref) =>
    f.m.node(1, ref).then(
      () => true,
      (error) => (error.code === "stale_ref" ? false : Promise.reject(error)),
    );
  const child = { frame: { id: "ad", parentId: "main", url: "https://ads.test/" } };
  f.m.addRef(1, 11, "@emain.0");
  // An inserted iframe commits in the root session; a cross-site one in its own.
  f.m.refEvent(1, "Page.frameNavigated", child);
  f.m.refEvent(1, "Page.frameNavigated", { frame: { id: "oopif", url: "https://x.test/" } }, "s1");
  f.m.refEvent(1, "DOM.documentUpdated", {}, "s1");
  assert.equal(await live("@emain.0"), true, "child frames leave main-document references");
  f.m.refEvent(1, "Page.frameNavigated", { frame: { id: "main", url: "https://example.test/" } });
  assert.equal(await live("@emain.0"), false, "a main-frame navigation expires them");
  f.m.addRef(1, 12, "@emain.1");
  f.m.refEvent(1, "DOM.documentUpdated", {});
  assert.equal(await live("@emain.1"), false, "a replaced root document expires them");
});

test("navigation finishes on a tab update while worker timers lag", async (t) => {
  const f = await sessionFixture(
    t,
    { task: { tabs: [1], borrowed: [], current: 1, title: "task" } },
    { hold: false },
  );
  await f.run("navigate", { url: "https://example.test/before" });
  // Seen on hosted macOS: a spinning renderer delays the worker's short timers
  // for many seconds while tab events still arrive.
  const timers = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...rest) =>
    timers(callback, ms === 50 ? 60_000 : ms, ...rest);
  const listeners = new Set();
  let status = "loading";
  Object.assign(globalThis.chrome.tabs, {
    get: async (id) => ({ id, url: "https://example.test/after", status }),
    onUpdated: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
  });
  const navigated = f.run("navigate", { url: "https://example.test/after" });
  while (!listeners.size) await new Promise((resolve) => timers(resolve, 10));
  status = "complete";
  for (const listener of listeners) listener(1, { status }, {});
  const started = Date.now();
  assert.equal((await navigated).tabId, 1);
  assert.ok(Date.now() - started < 1000, "the update ended the wait");
  assert.equal(listeners.size, 0, "the wait removed its listener");
});

test("navigation reconfigures a tab whose root target failed open", async (t) => {
  const failing = new Set();
  const f = await sessionFixture(
    t,
    { task: { tabs: [1], borrowed: [], current: 1, title: "task" } },
    { hold: false, failing },
  );
  await f.run("navigate", { url: "https://example.test/first" });
  failing.add("Fetch.continueRequest");
  await f.m.presetEvent(1, "Fetch.requestPaused", {
    requestId: "page",
    resourceType: "Document",
    frameId: "main",
    request: { url: "https://example.test/page" },
  });
  failing.clear();
  const failed = await f.run("preset", { cmd: "status" });
  assert.equal(failed.network, false);
  assert.ok(failed.fallback.some((reason) => reason.includes("failed open")));
  const from = f.calls.length;
  await f.run("navigate", { url: "https://example.test/second" });
  const methods = f.calls.slice(from).map((c) => c.method);
  assert.ok(methods.includes("Page.enable") && methods.includes("Fetch.enable"));
  const restored = await f.run("preset", { cmd: "status" });
  assert.equal(restored.network, true);
  assert.deepEqual(restored.fallback, []);
});

test("window_new persists the new tab before attaching the debugger", async (t) => {
  const f = await sessionFixture(t, {}, { hold: false });
  const attach = globalThis.chrome.debugger.attach;
  let stored;
  globalThis.chrome.debugger.attach = async (source) => {
    stored = f.saved.at(-1)?.sessions?.task?.tabs;
    return attach(source);
  };
  const opened = await f.run("window_new", { url: "https://example.test/" });
  assert.equal(opened.tabId, 7);
  assert.deepEqual(stored, [7], "a restarted worker can release the tab's debugger session");
});

// Chrome 156 aborts a navigation whose response is a download, a 204 No Content
// or a 205 Reset Content without committing a document. It then sends no tab
// update: the tab completes again on its previous page, and the root session
// reports the main frame's Page.frameStoppedLoading. The worker's 50 ms timers
// lag here, as on a busy macOS host, so only that event ends the wait before
// the deadline.
const existing = { task: { tabs: [1], borrowed: [], current: 1, title: "task" } };
for (const { name, action, args, stored, tabId, page, result } of [
  {
    name: "navigate into a new tab",
    action: "navigate",
    args: { newTab: true },
    stored: {},
    tabId: 7,
    page: "about:blank",
    result: { success: true, tabId: 7, url: "about:blank" },
  },
  {
    name: "window_new",
    action: "window_new",
    args: {},
    stored: {},
    tabId: 7,
    page: "about:blank",
    result: { tabId: 7, windowId: 1 },
  },
  {
    name: "navigate in an existing tab",
    action: "navigate",
    args: {},
    stored: existing,
    tabId: 1,
    page: "https://example.test/before",
    result: { success: true, tabId: 1, url: "https://example.test/before" },
  },
]) {
  test(`${name} ends when the response opens no document`, async (t) => {
    const f = await sessionFixture(t, structuredClone(stored), { hold: false });
    const timers = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...rest) =>
      timers(callback, ms === 50 ? 60_000 : ms, ...rest);
    const tabs = new Map([[tabId, { id: tabId, url: page, status: "complete" }]]);
    const tabListeners = new Set();
    Object.assign(globalThis.chrome.tabs, {
      get: async (id) => ({ ...(tabs.get(id) ?? { id, url: "about:blank", status: "complete" }) }),
      query: async () => [...tabs.values()],
      onUpdated: {
        addListener: (listener) => tabListeners.add(listener),
        removeListener: (listener) => tabListeners.delete(listener),
      },
      update: async (id, { url }) => {
        f.updates.push([id, { url }]);
        f.debuggerEvent({ tabId: id }, "Page.frameStartedNavigating", {
          frameId: "main",
          url,
          navigationType: "differentDocument",
        });
        f.debuggerEvent({ tabId: id }, "Page.frameStartedLoading", { frameId: "main" });
        const pending = { id, url: page, status: "loading", pendingUrl: url };
        tabs.set(id, pending);
        // The response arrives after tabs.update has returned.
        timers(() => {
          tabs.set(id, { id, url: page, status: "complete" });
          f.debuggerEvent({ tabId: id }, "Page.frameStoppedLoading", { frameId: "main" });
        }, 20);
        return pending;
      },
    });
    // The daemon's cancellation at the deadline reaches the worker as a message.
    const abort = new AbortController();
    const expiry = timers(
      () =>
        abort.abort(Object.assign(Error("request deadline reached"), { code: "outcome_unknown" })),
      1500,
    );
    // Worker timers are unreferenced in this fixture; keep the test process alive.
    const alive = setInterval(() => {}, 100);
    t.after(() => {
      clearTimeout(expiry);
      clearInterval(alive);
    });
    const started = Date.now();
    const finished = await f.m.execute(
      { session: "task", action, args: { url: "https://example.test/report", ...args } },
      { signal: abort.signal, check: () => abort.signal.throwIfAborted() },
    );
    assert.ok(Date.now() - started < 1000, "the stopped load ended the wait");
    assert.equal(tabListeners.size + f.debuggerListeners.size, 0, "the wait removed its listeners");
    assert.deepEqual(finished, result);
    assert.deepEqual(f.removed, [], "the tab stays open");
    assert.deepEqual(
      (await f.run("list_tabs")).tabs.map((tab) => tab.tabId),
      [tabId],
      "the tab stays in the session",
    );
  });
}

for (const args of [
  { url: "ftp://example.test/file" },
  { url: "https://example.test/", preset: "bogus" },
]) {
  test(`window_new rejects ${JSON.stringify(args)} before opening a window`, async (t) => {
    const f = await sessionFixture(t, {}, { hold: false });
    const created = [];
    globalThis.chrome.windows.create = async (options) => {
      created.push(options);
      return { id: 1, tabs: [{ id: 7 }] };
    };
    await assert.rejects(f.run("window_new", args), { code: "invalid_args" });
    assert.deepEqual(created, []);
    assert.deepEqual(f.calls, []);
  });
}

test("navigate {preset:none} releases root requests while an iframe installation is busy", async (t) => {
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const f = await sessionFixture(
    t,
    { task: { tabs: [1], borrowed: [], current: 1, title: "task" } },
    {
      hold: false,
      intercept: async (source, method) => {
        if (source.sessionId === "busy" && method === "Page.enable") {
          entered.resolve();
          await resume.promise;
        }
      },
    },
  );
  await f.run("navigate", { url: "https://example.test/" });
  const installing = f.m.presetEvent(1, "Target.attachedToTarget", {
    sessionId: "busy",
    targetInfo: { targetId: "busy-target" },
  });
  await entered.promise;
  const navigating = f.run("navigate", { url: "https://example.test/plain", preset: "none" });
  try {
    for (let i = 0; i < 20; i++) await setImmediate();
    assert.ok(
      f.calls.some((c) => c.tabId === 1 && !c.sessionId && c.method === "Fetch.disable"),
      "the current page's root requests are released while the iframe is busy",
    );
  } finally {
    resume.resolve();
  }
  await Promise.all([installing, navigating]);
  assert.deepEqual(f.updates.at(-1), [1, { url: "https://example.test/plain" }]);
  assert.equal((await f.run("preset", { cmd: "status" })).name, "none");
});

// A user tab that task sessions borrow one after another. The worker's frame,
// network and preset events are fed in directly. The page has one button,
// which snapshot reports with backend node id 11.
async function borrowFixture(t) {
  const original = { chrome: globalThis.chrome };
  const calls = [];
  const tab = { id: 5, url: "https://example.test/", title: "user tab", status: "complete" };
  const listeners = { addListener: () => {}, removeListener: () => {} };
  const replies = {
    "Page.getFrameTree": () => ({ frameTree: { frame: { id: "main", url: tab.url } } }),
    "Page.getNavigationHistory": () => ({
      currentIndex: 0,
      entries: [{ id: 1, url: tab.url, title: tab.title }],
    }),
    "Runtime.evaluate": () => ({ result: { type: "string", value: "user tab" } }),
    "Accessibility.getFullAXTree": () => ({
      nodes: [
        {
          nodeId: "1",
          ignored: false,
          role: { value: "button" },
          name: { value: "Send" },
          backendDOMNodeId: 11,
        },
      ],
    }),
    "DOM.resolveNode": () => ({ object: { type: "object", objectId: "button" } }),
    "Runtime.callFunctionOn": () => ({ result: { type: "string", value: "Send" } }),
  };
  globalThis.chrome = {
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: {
      get: async (id) => ({ ...tab, id }),
      query: async () => [tab],
      update: async (id) => ({ ...tab, id }),
      onUpdated: listeners,
    },
    debugger: {
      onEvent: listeners,
      getTargets: async () => [],
      attach: async ({ tabId }) => calls.push({ tabId, method: "attach" }),
      detach: async ({ tabId }) => calls.push({ tabId, method: "detach" }),
      sendCommand: async (source, method, params) => {
        calls.push({ tabId: source.tabId, sessionId: source.sessionId, method, params });
        return replies[method]?.() ?? {};
      },
    },
  };
  t.after(() => Object.assign(globalThis, original));
  const m = await load(
    t,
    [
      'export { execute } from "./extension/src/actions.ts";',
      'export { refEvent } from "./extension/src/cdp.ts";',
      'export { frameEvent, resetScope } from "./extension/src/frames.ts";',
      'export { event as networkEvent } from "./extension/src/network.ts";',
      'export { owner, removed } from "./extension/src/state.ts";',
    ].join("\n"),
  );
  const run = (session, action, args = {}, check = () => {}) =>
    m.execute({ session, action, args }, { signal: new AbortController().signal, check });
  const borrow = (session) => run(session, "find_tab", { url: tab.url, active: true });
  return { m, run, borrow, calls };
}

test("a released borrowed tab keeps no frame selection for the next session", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("first");
  // An out-of-process iframe with its flat child session and default context.
  f.m.frameEvent(5, "Target.attachedToTarget", {
    sessionId: "child-of-first",
    targetInfo: { targetId: "oopif" },
  });
  f.m.frameEvent(
    5,
    "Runtime.executionContextCreated",
    { context: { id: 7, auxData: { frameId: "oopif", isDefault: true } } },
    "child-of-first",
  );
  assert.equal((await f.run("first", "frame", { frameId: "oopif" })).frameId, "oopif");
  await f.run("first", "close_session");
  assert.ok(f.calls.some((c) => c.method === "detach" && c.tabId === 5));

  await f.borrow("second");
  f.calls.length = 0;
  await f.run("second", "evaluate", { code: "document.title" });
  const evaluate = f.calls.find((c) => c.method === "Runtime.evaluate");
  assert.equal(evaluate.sessionId, undefined, "evaluate runs in the main frame");
  assert.equal(evaluate.params.contextId, undefined);
});

// Frame events as the worker receives them: a same-process iframe's default
// context lives in the root session, a cross-process iframe has its own.
const sameProcessFrame = (f, id) =>
  f.m.frameEvent(5, "Runtime.executionContextCreated", {
    context: { id, auxData: { frameId: "child", isDefault: true } },
  });
const crossProcessFrame = (f, id) => {
  f.m.frameEvent(5, "Target.attachedToTarget", {
    sessionId: "oopif-session",
    targetInfo: { targetId: "oopif" },
  });
  f.m.frameEvent(
    5,
    "Runtime.executionContextCreated",
    { context: { id, auxData: { frameId: "oopif", isDefault: true } } },
    "oopif-session",
  );
};
// The session and context of the last Runtime.evaluate.
const lastEvaluate = (f) => {
  const call = f.calls.findLast((c) => c.method === "Runtime.evaluate");
  return { sessionId: call.sessionId, contextId: call.params.contextId };
};
const lostFrame = { code: "frame_unavailable" };
const firstRef = (snapshot) => snapshot.tree.trim().split(" ")[0];

test("a selected frame that navigates is reported once, then commands use the main frame", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("task");
  sameProcessFrame(f, 7);
  await f.run("task", "frame", { frameId: "child" });
  await f.run("task", "evaluate", { code: "document.title" });
  assert.deepEqual(lastEvaluate(f), { sessionId: undefined, contextId: 7 });
  // Chrome destroys the old document's context before it creates the new one.
  f.m.frameEvent(5, "Runtime.executionContextDestroyed", { executionContextId: 7 });
  sameProcessFrame(f, 8);
  const sent = f.calls.length;
  await assert.rejects(f.run("task", "fill", { selector: "#name", value: "typed" }), {
    code: "frame_unavailable",
    message:
      "the selected frame navigated or was removed; commands now use the main frame; select it again with frame",
  });
  assert.deepEqual(
    f.calls
      .slice(sent)
      .filter((c) => c.method === "Runtime.evaluate" || c.method.startsWith("Input.")),
    [],
    "the fill reaches no document",
  );
  await f.run("task", "evaluate", { code: "document.title" });
  assert.deepEqual(lastEvaluate(f), { sessionId: undefined, contextId: undefined });
});

test("a selected frame stays selected when Runtime reports its context again", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("task");
  sameProcessFrame(f, 7);
  await f.run("task", "frame", { frameId: "child" });
  // Runtime.enable after Runtime.disable reports the existing context again.
  sameProcessFrame(f, 7);
  await f.run("task", "evaluate", { code: "document.title" });
  assert.deepEqual(lastEvaluate(f), { sessionId: undefined, contextId: 7 });
  // Another default context of the frame belongs to a new document.
  sameProcessFrame(f, 9);
  await assert.rejects(f.run("task", "evaluate", { code: "document.title" }), lostFrame);
});

test("a cross-process frame is lost when its contexts are cleared or its target detaches", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("task");
  const ends = {
    "contexts cleared": () =>
      f.m.frameEvent(5, "Runtime.executionContextsCleared", {}, "oopif-session"),
    "target detached": () =>
      f.m.frameEvent(5, "Target.detachedFromTarget", { sessionId: "oopif-session" }),
  };
  let id = 3;
  for (const [name, end] of Object.entries(ends)) {
    crossProcessFrame(f, id++);
    assert.equal((await f.run("task", "frame", { frameId: "oopif" })).sessionId, "oopif-session");
    end();
    await assert.rejects(f.run("task", "evaluate", { code: "document.title" }), lostFrame, name);
    await f.run("task", "evaluate", { code: "document.title" });
    assert.deepEqual(lastEvaluate(f), { sessionId: undefined, contextId: undefined }, name);
  }
});

test("ending a frame selection also ends the report of a lost frame", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("task");
  let id = 7;
  const lose = async () => {
    sameProcessFrame(f, id);
    await f.run("task", "frame", { frameId: "child" });
    f.m.frameEvent(5, "Runtime.executionContextDestroyed", { executionContextId: id++ });
  };
  const ends = {
    "frame main": () => f.run("task", "frame", { cmd: "main" }),
    navigate: () => f.run("task", "navigate", { url: "https://example.test/next" }),
    history: () => f.run("task", "history", { cmd: "list" }),
    // worker.ts on a tabs.onUpdated URL change
    "tab URL change": () => f.m.resetScope(5),
  };
  for (const [name, end] of Object.entries(ends)) {
    await lose();
    await end();
    await f.run("task", "evaluate", { code: "document.title" });
    assert.deepEqual(lastEvaluate(f), { sessionId: undefined, contextId: undefined }, name);
  }
  await lose();
  sameProcessFrame(f, 20);
  await f.run("task", "frame", { frameId: "child" });
  await f.run("task", "evaluate", { code: "document.title" });
  assert.deepEqual(lastEvaluate(f), { sessionId: undefined, contextId: 20 }, "a new selection");
  // Listing frames and answering a dialog run outside the selected frame and
  // leave the report to the next command that runs in it.
  f.m.frameEvent(5, "Runtime.executionContextDestroyed", { executionContextId: 20 });
  await f.run("task", "frame", { cmd: "list" });
  await f.run("task", "dialog", { accept: true });
  await assert.rejects(f.run("task", "evaluate", { code: "document.title" }), lostFrame);
  // Releasing the borrowed tab forgets its frames.
  await lose();
  await f.run("task", "close_session");
  await f.borrow("task");
  await f.run("task", "evaluate", { code: "document.title" });
  assert.deepEqual(lastEvaluate(f), { sessionId: undefined, contextId: undefined });
});

test("a frame snapshot reference resolves only while its frame stays selected", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("task");
  crossProcessFrame(f, 3);
  await f.run("task", "frame", { frameId: "oopif" });
  const ref = firstRef(await f.run("task", "snapshot"));
  assert.equal((await f.run("task", "get", { selector: ref })).value, "Send");
  assert.equal(f.calls.findLast((c) => c.method === "DOM.resolveNode").sessionId, "oopif-session");
  // The iframe is removed. Its process numbers nodes apart from the main
  // frame's, so node 11 of the main document is another element.
  f.m.frameEvent(5, "Target.detachedFromTarget", { sessionId: "oopif-session" });
  const sent = f.calls.length;
  await assert.rejects(f.run("task", "get", { selector: ref }), { code: "stale_ref" });
  await assert.rejects(f.run("task", "click", { selector: ref }), { code: "stale_ref" });
  assert.deepEqual(
    f.calls
      .slice(sent)
      .filter((c) => c.method === "DOM.resolveNode" || c.method === "Input.dispatchMouseEvent"),
    [],
    "the main document is not touched",
  );
  // The next command that runs in the frame reports it.
  await assert.rejects(f.run("task", "evaluate", { code: "document.title" }), lostFrame);
  // A same-process frame that navigates: its old document's context goes first.
  sameProcessFrame(f, 7);
  await f.run("task", "frame", { frameId: "child" });
  const before = firstRef(await f.run("task", "snapshot"));
  f.m.frameEvent(5, "Runtime.executionContextDestroyed", { executionContextId: 7 });
  f.m.refEvent(5, "Page.frameNavigated", {
    frame: { id: "child", parentId: "main", url: "https://example.test/next" },
  });
  sameProcessFrame(f, 8);
  await assert.rejects(f.run("task", "get", { selector: before }), { code: "stale_ref" });
  // Other frames loading or navigating keep the references of a frame snapshot.
  crossProcessFrame(f, 4);
  await f.run("task", "frame", { frameId: "oopif" });
  const next = firstRef(await f.run("task", "snapshot"));
  f.m.refEvent(5, "Page.frameNavigated", {
    frame: { id: "ad", parentId: "main", url: "https://ads.test/" },
  });
  f.m.refEvent(
    5,
    "Page.frameNavigated",
    { frame: { id: "ad", parentId: "main", url: "https://ads.test/next" } },
    "ad-session",
  );
  f.m.refEvent(5, "DOM.documentUpdated", {}, "ad-session");
  assert.equal((await f.run("task", "get", { selector: next })).value, "Send");
  // A new main document expires them.
  f.m.refEvent(5, "Page.frameNavigated", { frame: { id: "main", url: "https://example.test/" } });
  await assert.rejects(f.run("task", "get", { selector: next }), { code: "stale_ref" });
});

test("dialog answers through the tab's top-level session while a cross-process frame is selected", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("task");
  crossProcessFrame(f, 3);
  await f.run("task", "frame", { frameId: "oopif" });
  await f.run("task", "dialog", { accept: true, promptText: "yes" });
  assert.deepEqual(
    f.calls.findLast((c) => c.method === "Page.handleJavaScriptDialog"),
    {
      tabId: 5,
      sessionId: undefined,
      method: "Page.handleJavaScriptDialog",
      params: { accept: true, promptText: "yes" },
    },
  );
  await f.run("task", "evaluate", { code: "document.title" });
  assert.deepEqual(lastEvaluate(f), { sessionId: "oopif-session", contextId: 3 });
});

test("Runtime.disable through cdp ends a frame selection in that session", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("task");
  crossProcessFrame(f, 3);
  await f.run("task", "frame", { frameId: "oopif" });
  // Runtime of another session leaves the selection.
  await f.run("task", "cdp", { method: "Runtime.disable" });
  await f.run("task", "evaluate", { code: "document.title" });
  assert.deepEqual(lastEvaluate(f), { sessionId: "oopif-session", contextId: 3 });
  await f.run("task", "cdp", { method: "Runtime.disable", sessionId: "oopif-session" });
  await assert.rejects(f.run("task", "evaluate", { code: "document.title" }), {
    code: "frame_unavailable",
    message:
      "Runtime was disabled in the selected frame's session; commands now use the main frame; select it again with frame",
  });
  await f.run("task", "evaluate", { code: "document.title" });
  assert.deepEqual(lastEvaluate(f), { sessionId: undefined, contextId: undefined });
  // A same-process frame belongs to the root session. Selecting it again
  // enables Runtime, which reports the frame's context again.
  sameProcessFrame(f, 7);
  await f.run("task", "frame", { frameId: "child" });
  await f.run("task", "cdp", { method: "Runtime.disable" });
  await assert.rejects(f.run("task", "evaluate", { code: "document.title" }), lostFrame);
  sameProcessFrame(f, 7);
  await f.run("task", "frame", { frameId: "child" });
  assert.equal(f.calls.findLast((c) => c.method === "Runtime.enable").sessionId, undefined);
  await f.run("task", "evaluate", { code: "document.title" });
  assert.deepEqual(lastEvaluate(f), { sessionId: undefined, contextId: 7 });
});

test("snapshot enables Page events, again after a Page.disable that expires its references", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("task");
  const enables = () => f.calls.filter((c) => c.method === "Page.enable" && !c.sessionId).length;
  const ref = firstRef(await f.run("task", "snapshot"));
  const order = f.calls.map((c) => c.method);
  assert.ok(
    order.indexOf("Page.enable") < order.indexOf("Accessibility.getFullAXTree"),
    "the main frame's navigations are reported before the tree is read",
  );
  assert.equal((await f.run("task", "get", { selector: ref })).value, "Send");
  const current = firstRef(await f.run("task", "snapshot"));
  assert.equal(enables(), 1);
  await f.run("task", "cdp", { method: "Page.disable" });
  await assert.rejects(f.run("task", "get", { selector: current }), { code: "stale_ref" });
  await f.run("task", "snapshot");
  assert.equal(enables(), 2);
});

test("a released borrowed tab keeps no network recording for the next session", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("first");
  await f.run("first", "network", { cmd: "start" });
  f.m.networkEvent(5, "Network.requestWillBeSent", {
    requestId: "r1",
    request: { url: "https://example.test/private?token=first", method: "GET" },
  });
  assert.equal((await f.run("first", "network", { cmd: "list" })).requests.length, 1);
  await f.run("first", "close_session");

  await f.borrow("second");
  assert.deepEqual((await f.run("second", "network", { cmd: "list" })).requests, []);
});

test("a page CDP attach that outlives its request releases the tab", async (t) => {
  const f = await borrowFixture(t);
  const session = `cdp-${"1".repeat(32)}`;
  let deadline = false;
  globalThis.chrome.debugger.attach = async ({ tabId }) => {
    f.calls.push({ tabId, method: "attach" });
    // The daemon gives up on the request while Chrome attaches.
    deadline = true;
  };
  const check = () => {
    if (deadline)
      throw Object.assign(Error("request deadline reached"), { code: "outcome_unknown" });
  };
  await assert.rejects(f.run(session, "cdp_attach", { tabId: 5 }, check), /deadline/u);
  assert.equal(f.m.owner(5), undefined, "no session keeps the tab");
  assert.deepEqual(
    f.calls.filter((c) => c.method === "attach" || c.method === "detach").map((c) => c.method),
    ["attach", "detach"],
  );
});

// The daemon names a new cdp-<id> session for every page CDP connection, so a
// session left behind by one connection is never reused or closed. Sessions are
// limited to 128.
const pageClient = (n) => `cdp-${n.toString(16).padStart(32, "0")}`;

test("cdp_detach ends a page CDP session whose tab was closed", async (t) => {
  const f = await borrowFixture(t);
  for (let n = 1; n <= 128; n++) {
    assert.deepEqual(await f.run(pageClient(n), "cdp_attach", { tabId: 5 }), { attached: true });
    // Mirrors chrome.tabs.onRemoved: the closed tab leaves the session first.
    await f.m.removed(5);
    assert.deepEqual(await f.run(pageClient(n), "cdp_detach", { tabId: 5 }), { detached: true });
  }
  assert.deepEqual(await f.run("research", "list_tabs"), { success: true, tabs: [] });
});

test("cdp_detach ends a page CDP session whose tab closes during the detach", async (t) => {
  const f = await borrowFixture(t);
  // Chrome answers Page.close before it removes the tab, so the cdp_detach sent
  // when the client disconnects can reach chrome.debugger.detach as the tab goes.
  globalThis.chrome.debugger.detach = async ({ tabId }) => {
    f.calls.push({ tabId, method: "detach" });
    throw Error(`No tab with given id ${tabId}.`);
  };
  const replies = [];
  for (let n = 1; n <= 128; n++) {
    assert.deepEqual(await f.run(pageClient(n), "cdp_attach", { tabId: 5 }), { attached: true });
    // The daemon does not wait on the reply of its cdp_detach.
    replies.push(
      await f.run(pageClient(n), "cdp_detach", { tabId: 5 }).catch((error) => error.message),
    );
    // chrome.tabs.onRemoved arrives after the failed detach.
    await f.m.removed(5);
  }
  assert.deepEqual(await f.run("research", "list_tabs"), { success: true, tabs: [] });
  assert.deepEqual(
    new Set(replies.map((reply) => JSON.stringify(reply))),
    new Set(['{"detached":true}']),
  );
  assert.equal(
    f.calls.filter((c) => c.method === "attach").length,
    128,
    "each client attaches again",
  );
});

test("cdp_detach reports a detach failure other than a closed tab", async (t) => {
  const f = await borrowFixture(t);
  const session = pageClient(1);
  globalThis.chrome.debugger.detach = async () => {
    throw Error("Internal error.");
  };
  await f.run(session, "cdp_attach", { tabId: 5 });
  await assert.rejects(f.run(session, "cdp_detach", { tabId: 5 }), /^Error: Internal error\.$/u);
  assert.equal(f.m.owner(5), session);
});

test("a page CDP attach that fails before attaching leaves no session", async (t) => {
  const f = await borrowFixture(t);
  await f.borrow("task");
  globalThis.chrome.tabs.get = async (id) => {
    if (id === 5) return { id, url: "https://example.test/", status: "complete" };
    if (id === 9) return { id, url: "chrome://settings/", status: "complete" };
    throw Error(`No tab with id: ${id}.`);
  };
  const failures = {};
  for (let n = 1; n <= 128; n++) {
    // Owned by the task session, a settings page, or a closed tab.
    await assert.rejects(
      f.run(pageClient(n), "cdp_attach", { tabId: [5, 9, 11][n % 3] }),
      (error) => {
        const kind = error.code ?? "missing";
        failures[kind] = (failures[kind] ?? 0) + 1;
        return true;
      },
    );
  }
  assert.deepEqual(failures, { tab_busy: 42, restricted_tab: 43, missing: 43 });
  assert.equal(f.m.owner(5), "task");
  assert.ok(!f.calls.some((c) => c.method === "detach"), "the task session's tab stays attached");
  assert.deepEqual(await f.run("research", "list_tabs"), { success: true, tabs: [] });
});
