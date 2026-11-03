import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { Script, createContext, runInContext } from "node:vm";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { FiltersEngine, Request } from "@ghostery/adblocker";

test("pinned official lists block advertising and respect exceptions", async () => {
  const engine = FiltersEngine.deserialize(await readFile("dist/extension/filters.bin"));
  assert.equal(
    engine.match(
      Request.fromRawDetails({
        url: "https://googleads.g.doubleclick.net/pagead/ads",
        sourceUrl: "https://example.com/",
        type: "script",
      }),
    ).match,
    true,
  );
  assert.equal(
    engine.match(
      Request.fromRawDetails({
        url: "https://example.com/article.js",
        sourceUrl: "https://example.com/",
        type: "script",
      }),
    ).match,
    false,
  );
  const custom = FiltersEngine.parse("||tracker.test^\n@@||tracker.test/needed.js$script");
  assert.equal(
    custom.match(
      Request.fromRawDetails({
        url: "https://tracker.test/needed.js",
        sourceUrl: "https://example.com",
        type: "script",
      }),
    ).match,
    false,
  );
});
test("presets fail open, release paused requests, restore JavaScript and exclude disabled features", async (t) => {
  const previous = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };
  globalThis.setTimeout = (...args) => {
    const timer = previous.setTimeout(...args);
    timer.unref();
    return timer;
  };
  t.after(() => Object.assign(globalThis, previous));
  const calls = [];
  let failFetch = false;
  globalThis.fetch = async () => {
    throw Error("bundle missing");
  };
  globalThis.chrome = {
    runtime: { getURL: (p) => p },
    tabs: { get: async (id) => ({ id }) },
    debugger: {
      sendCommand: async (source, method, params) => {
        if (method === "Page.getFrameTree")
          return {
            frameTree: { frame: { id: source.sessionId ?? "main", url: "https://example.test/" } },
          };
        calls.push({ source, method, params });
        if (failFetch && method === "Fetch.failRequest") throw Error("dispatch failed");
        return { identifier: "script-1" };
      },
    },
  };
  const result = await build({
    entryPoints: ["extension/src/presets.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const p = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
  assert.deepEqual(p.presetConfig(), {
    name: "anti-ad",
    environment: false,
    images: true,
    fonts: true,
    css: false,
    javascript: false,
  });
  assert.throws(() => p.presetConfig({ zen: { images: "yes" } }));
  const config = p.presetConfig({ preset: "zen", zen: { javascript: true } });
  await p.configurePreset(1, config, "https://example.com");
  assert.ok(p.presetStatus(1).fallback.some((s) => s.includes("unavailable")));
  await p.presetEvent(1, "Fetch.requestPaused", {
    requestId: "a",
    request: { url: "https://example.com/page" },
    resourceType: "Document",
  });
  assert.ok(calls.some((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "a"));
  await p.presetEvent(1, "Fetch.requestPaused", {
    requestId: "b",
    request: { url: "https://example.com/photo.png" },
    resourceType: "Image",
  });
  assert.ok(calls.some((c) => c.method === "Fetch.failRequest" && c.params.requestId === "b"));
  failFetch = true;
  await p.presetEvent(1, "Fetch.requestPaused", {
    requestId: "c",
    request: { url: "https://example.com/photo.png" },
    resourceType: "Image",
  });
  assert.ok(calls.some((c) => c.method === "Fetch.disable"));
  assert.equal(p.presetStatus(1).network, false);
  await p.clearPreset(1);
  // Failed interception must restore script execution as part of fail-open.
  assert.ok(
    calls.some(
      (c) => c.method === "Emulation.setScriptExecutionDisabled" && c.params.value === false,
    ),
  );
  assert.equal(p.presetStatus(1).name, "none");
});

test("environment installation precedes interception and degrades without stalling requests", async (t) => {
  const previous = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.setTimeout = (...args) => {
    const timer = previous.setTimeout(...args);
    timer.unref();
    return timer;
  };
  const bytes = FiltersEngine.parse("example.test##.ad\n||tracker.test^").serialize();
  globalThis.fetch = async () => new Response(bytes);
  const calls = [];
  let paused = false,
    injectFailure = true;
  globalThis.chrome = {
    runtime: { getURL: (p) => p },
    tabs: { get: async (id) => ({ id }) },
    debugger: {
      sendCommand: async (source, method, params) => {
        if (method === "Page.getFrameTree")
          return {
            frameTree: { frame: { id: source.sessionId ?? "main", url: "https://example.test/" } },
          };
        calls.push({ source, method, params });
        if (method === "Page.addScriptToEvaluateOnNewDocument") {
          assert.equal(
            paused,
            false,
            "renderer injection must not wait behind a paused navigation",
          );
          if (injectFailure) throw Error("injection unsupported");
          return { identifier: "environment-1" };
        }
        return {};
      },
    },
  };
  const result = await build({
    entryPoints: ["extension/src/presets.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const p = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#environment`
  );
  const config = p.presetConfig({ environment: true });
  await p.configurePreset(2, config, "https://example.test");
  assert.equal(p.presetStatus(2).environmentState, "unavailable");
  assert.equal(p.presetStatus(2).network, true);
  assert.ok(p.presetStatus(2).fallback.some((s) => s.includes("network filtering retained")));
  injectFailure = false;
  await p.configurePreset(2, config, "https://example.test");
  const before = calls.length;
  paused = true;
  await p.presetEvent(2, "Fetch.requestPaused", {
    requestId: "document",
    request: { url: "https://example.test" },
    resourceType: "Document",
  });
  assert.ok(calls.slice(before).some((c) => c.method === "Fetch.continueRequest"));
  assert.ok(calls.slice(before).every((c) => c.method !== "Page.addScriptToEvaluateOnNewDocument"));
  const after = calls.length;
  await p.presetEvent(99, "Fetch.requestPaused", {
    requestId: "custom",
    request: { url: "https://example.test" },
    resourceType: "Document",
  });
  assert.equal(calls.length, after, "unowned/custom raw Fetch is untouched");
  await p.clearPreset(2);
});

test("a late Fetch failure cannot disable a newer navigation preset", async (t) => {
  const previous = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.setTimeout = (...args) => {
    const timer = previous.setTimeout(...args);
    timer.unref();
    return timer;
  };
  const bytes = FiltersEngine.parse("||tracker.test^").serialize();
  globalThis.fetch = async () => new Response(bytes);
  let rejectOld, started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const calls = [];
  globalThis.chrome = {
    runtime: { getURL: (p) => p },
    tabs: { get: async (id) => ({ id }) },
    debugger: {
      sendCommand: async (source, method, params) => {
        if (method === "Page.getFrameTree")
          return {
            frameTree: { frame: { id: source.sessionId ?? "main", url: "https://example.test/" } },
          };
        calls.push({ method, params });
        if (method === "Fetch.continueRequest" && params.requestId === "old") {
          started();
          return new Promise((_, reject) => {
            rejectOld = reject;
          });
        }
        return {};
      },
    },
  };
  const result = await build({
    entryPoints: ["extension/src/presets.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const p = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#generation`
  );
  const config = p.presetConfig();
  await p.configurePreset(1, config, "https://example.test/old");
  const old = p.presetEvent(1, "Fetch.requestPaused", {
    requestId: "old",
    request: { url: "https://example.test/api" },
    resourceType: "XHR",
  });
  await began;
  await p.configurePreset(1, config, "https://example.test/new");
  const before = calls.filter((c) => c.method === "Fetch.disable").length;
  rejectOld(Error("request from previous navigation no longer exists"));
  await old;
  assert.equal(p.presetStatus(1).network, true);
  assert.equal(calls.filter((c) => c.method === "Fetch.disable").length, before);
  await p.clearPreset(1);
});

test("iframe interception is bounded and detached targets are released", async (t) => {
  const previous = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.setTimeout = (...args) => {
    const timer = previous.setTimeout(...args);
    timer.unref();
    return timer;
  };
  const bytes = FiltersEngine.parse("||tracker.test^").serialize();
  globalThis.fetch = async () => new Response(bytes);
  const calls = [];
  globalThis.chrome = {
    runtime: { getURL: (p) => p },
    tabs: { get: async (id) => ({ id }) },
    debugger: {
      sendCommand: async (source, method, params) => {
        if (method === "Page.getFrameTree")
          return {
            frameTree: { frame: { id: source.sessionId ?? "main", url: "https://example.test/" } },
          };
        calls.push({ source, method, params });
        return {};
      },
    },
  };
  const result = await build({
    entryPoints: ["extension/src/presets.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const p = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#iframe-lifecycle`
  );
  await p.configurePreset(1, p.presetConfig(), "https://example.test");
  for (let i = 0; i < 140; i++)
    await p.presetEvent(1, "Target.attachedToTarget", { sessionId: `child-${i}` });
  assert.equal(calls.filter((c) => c.method === "Fetch.enable").length, 128);
  assert.ok(p.presetStatus(1).fallback.some((s) => s.includes("additional frames fail open")));
  for (let i = 0; i < 140; i++)
    await p.presetEvent(1, "Target.detachedFromTarget", { sessionId: `child-${i}` });
  const before = calls.length;
  await p.clearPreset(1);
  assert.equal(calls.slice(before).filter((c) => c.method === "Fetch.disable").length, 1);
  assert.ok(calls.slice(before).every((c) => !c.source.sessionId));
});

test("environment registers each scriptlet and the stylesheet separately", async (t) => {
  const previous = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.setTimeout = (...args) => {
    const timer = previous.setTimeout(...args);
    timer.unref();
    return timer;
  };
  // Both setTimeout/setInterval scriptlets embed the bundled RangeParser class;
  // the set-constant argument produces a scriptlet source that cannot parse.
  const engine = FiltersEngine.parse(
    [
      "example.test##.ad",
      "example.test##+js(no-setTimeout-if, ads)",
      "example.test##+js(no-setInterval-if, ads)",
      "example.test##+js(set-constant, ads, `broken)",
    ].join("\n"),
  );
  engine.updateResources(
    gunzipSync(await readFile("third_party/filters/resources.gz")).toString(),
    "bundled",
  );
  const bytes = engine.serialize();
  globalThis.fetch = async () => new Response(bytes);
  const registered = new Map();
  let next = 0;
  globalThis.chrome = {
    runtime: { getURL: (p) => p },
    tabs: { get: async (id) => ({ id }) },
    debugger: {
      sendCommand: async (_source, method, params) => {
        if (method === "Page.getFrameTree")
          return { frameTree: { frame: { id: "main", url: "about:blank" } } };
        if (method === "Page.addScriptToEvaluateOnNewDocument") {
          const identifier = `script-${++next}`;
          registered.set(identifier, params.source);
          return { identifier };
        }
        if (method === "Page.removeScriptToEvaluateOnNewDocument")
          registered.delete(params.identifier);
        return {};
      },
    },
  };
  const result = await build({
    entryPoints: ["extension/src/presets.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const p = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#isolation`
  );
  await p.configurePreset(1, p.presetConfig({ environment: true }), "https://example.test/");
  assert.equal(p.presetStatus(1).environmentState, "active");
  const sources = [...registered.values()];
  const syntax = sources.map((source) => {
    try {
      new Script(source);
      return "parses";
    } catch (error) {
      return String(error);
    }
  });
  t.diagnostic(JSON.stringify(syntax));
  assert.equal(sources.length, 4, "three scriptlets and one stylesheet");
  assert.ok(sources.every((source) => source.includes('location.hostname!=="example.test"')));
  const failed = syntax.flatMap((outcome, index) => (outcome === "parses" ? [] : [sources[index]]));
  assert.equal(failed.length, 1, "only the unparsable scriptlet fails");
  assert.ok(failed[0].includes("broken"));
  const stylesheet = sources.filter((source) =>
    source.includes(".ad { display: none !important; }"),
  );
  assert.equal(stylesheet.length, 1);
  const page = (hostname) => {
    const appended = [];
    runInContext(
      stylesheet[0],
      createContext({
        location: { hostname },
        document: {
          documentElement: { append: (style) => appended.push(style.textContent) },
          createElement: () => ({}),
        },
        MutationObserver: function () {
          return { observe() {}, disconnect() {} };
        },
      }),
    );
    return appended;
  };
  assert.deepEqual(page("example.test"), [".ad { display: none !important; }"]);
  assert.deepEqual(page("other.test"), [], "hostname guard");
  await p.clearPreset(1);
  assert.equal(registered.size, 0, "teardown removes every registration");
});

test("switching the last filtered tab to none releases the engine after 30 seconds", async (t) => {
  const previous = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  t.after(() => Object.assign(globalThis, previous));
  const timers = new Map();
  let next = 0,
    fetches = 0;
  globalThis.setTimeout = (callback, ms) => {
    timers.set(++next, { callback, ms });
    return next;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const bytes = FiltersEngine.parse("||tracker.test^").serialize();
  globalThis.fetch = async () => {
    fetches++;
    return new Response(bytes);
  };
  globalThis.chrome = {
    runtime: { getURL: (p) => p },
    tabs: { get: async (id) => ({ id }) },
    debugger: {
      sendCommand: async (_source, method) =>
        method === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "main", url: "https://example.test/" } } }
          : {},
    },
  };
  const result = await build({
    entryPoints: ["extension/src/presets.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const p = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#idle-release`
  );
  await p.configurePreset(1, p.presetConfig(), "https://example.test/");
  await p.configurePreset(1, p.presetConfig({ preset: "none" }), "https://example.test/");
  const idle = [...timers.values()].filter((timer) => timer.ms === 30000);
  assert.equal(idle.length, 1, "release is scheduled after the switch to none");
  idle[0].callback();
  await p.configurePreset(1, p.presetConfig(), "https://example.test/");
  assert.equal(fetches, 2, "the released engine is loaded again");
  await p.clearPreset(1);
});
