import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { FiltersEngine } from "@ghostery/adblocker";
import { setImmediate } from "node:timers/promises";

const resources = gunzipSync(await readFile("third_party/filters/resources.gz")).toString();

// The two scriptlets give each environment installation several registrations.
async function fixture(
  t,
  intercept = async () => {},
  filters = "example.test##.ad\nexample.test##+js(no-setTimeout-if, ads)\nexample.test##+js(no-setInterval-if, ads)\n||tracker.test^",
) {
  const original = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };
  const calls = [],
    enabled = new Set(),
    scripts = new Set(),
    javascript = new Map();
  let nextScript = 0;
  const engine = FiltersEngine.parse(filters);
  engine.updateResources(resources, "bundled");
  const bytes = engine.serialize();
  globalThis.fetch = async () => new Response(bytes);
  globalThis.setTimeout = (...args) => {
    const timer = original.setTimeout(...args);
    timer.unref();
    return timer;
  };
  globalThis.chrome = {
    runtime: { getURL: (p) => p },
    tabs: { get: async (id) => ({ id }) },
    debugger: {
      sendCommand: async (source, method, params) => {
        calls.push({ source, method, params });
        const response = await intercept(source, method, params);
        if (response !== undefined) return response;
        if (method === "Page.getFrameTree")
          return {
            frameTree: { frame: { id: source.sessionId ?? "main", url: "https://example.test/" } },
          };
        const id = source.sessionId ?? "";
        if (method === "Fetch.enable") enabled.add(id);
        if (method === "Fetch.disable") enabled.delete(id);
        if (method === "Emulation.setScriptExecutionDisabled") javascript.set(id, params.value);
        if (method === "Page.addScriptToEvaluateOnNewDocument") {
          const identifier = `script-${++nextScript}`;
          scripts.add(identifier);
          return { identifier };
        }
        if (method === "Page.removeScriptToEvaluateOnNewDocument")
          scripts.delete(params.identifier);
        return {};
      },
    },
  };
  const result = await build({
    stdin: {
      contents:
        'export * from "./extension/src/presets.ts"; export {frameEvent} from "./extension/src/frames.ts";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const p = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${t.name}`
  );
  const event = (method, params, sessionId = "") => {
    const pending = p.presetEvent(1, method, params, sessionId);
    p.frameEvent(1, method, params, sessionId);
    return pending;
  };
  const attach = (id) =>
    event("Target.attachedToTarget", { sessionId: id, targetInfo: { targetId: `target-${id}` } });
  t.after(async () => {
    await p.clearPreset(1);
    Object.assign(globalThis, original);
  });
  return { p, event, attach, calls, enabled, scripts, javascript };
}

for (const stage of [
  "Page.enable",
  "Page.getFrameTree",
  "Emulation.setScriptExecutionDisabled",
  "Page.addScriptToEvaluateOnNewDocument",
  "Fetch.enable",
]) {
  test(`clearing during ${stage} leaves no interception or script registration`, async (t) => {
    const entered = Promise.withResolvers(),
      resume = Promise.withResolvers();
    const f = await fixture(t, async (source, method) => {
      if (source.sessionId === "late" && method === stage) {
        entered.resolve();
        await resume.promise;
      }
    });
    await f.p.configurePreset(1, f.p.presetConfig({ environment: true }), "https://example.test");
    const installing = f.attach("late");
    await entered.promise;
    const clearing = f.p.configurePreset(
      1,
      f.p.presetConfig({ preset: "none" }),
      "https://example.test",
    );
    resume.resolve();
    await Promise.all([installing, clearing]);
    if (stage === "Page.addScriptToEvaluateOnNewDocument")
      assert.equal(
        f.calls.filter((c) => c.source.sessionId === "late" && c.method === stage).length,
        1,
        "registration stops once the preset is replaced",
      );
    assert.deepEqual([...f.enabled], []);
    assert.deepEqual([...f.scripts], []);
    assert.equal(f.p.presetStatus(1).name, "none");
  });
}

test("a concurrent attachment burst reserves the target limit and deduplicates sessions", async (t) => {
  const f = await fixture(t);
  await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test");
  await Promise.all(Array.from({ length: 140 }, (_, i) => f.attach(`child-${i}`)));
  assert.equal(f.enabled.size, 128);
  assert.equal(f.calls.filter((c) => c.method === "Fetch.enable").length, 128);
  assert.ok(f.p.presetStatus(1).fallback.some((s) => s.includes("additional frames fail open")));
  const before = f.calls.length;
  await Promise.all(Array.from({ length: 10 }, () => f.attach("child-0")));
  assert.equal(f.calls.length, before);
});

test("reconfiguration and none round trips restore existing children but exclude detached ones", async (t) => {
  const f = await fixture(t);
  await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test");
  await f.attach("existing");
  await f.attach("gone");
  await f.event("Target.detachedFromTarget", { sessionId: "gone" });
  f.enabled.delete("gone");
  const before = f.calls.length;
  await f.p.configurePreset(
    1,
    f.p.presetConfig({ preset: "zen", zen: { javascript: true } }),
    "https://example.test",
  );
  assert.deepEqual(
    [...f.enabled].sort((a, b) => a.localeCompare(b)),
    ["", "existing"],
  );
  assert.ok(
    f.calls
      .slice(before)
      .some(
        (c) =>
          c.source.sessionId === "existing" &&
          c.method === "Emulation.setScriptExecutionDisabled" &&
          c.params.value === true,
      ),
  );
  assert.ok(f.calls.slice(before).every((c) => c.source.sessionId !== "gone"));
  await f.p.configurePreset(1, f.p.presetConfig({ preset: "none" }), "https://example.test");
  await f.attach("attached-while-off");
  assert.equal(f.enabled.size, 0);
  await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test");
  assert.deepEqual(
    [...f.enabled].sort((a, b) => a.localeCompare(b)),
    ["", "attached-while-off", "existing"],
  );
});

test("a detached installing child cannot re-enable interception", async (t) => {
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const f = await fixture(t, async (source, method) => {
    if (source.sessionId === "gone" && method === "Page.enable") {
      entered.resolve();
      await resume.promise;
    }
  });
  await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test");
  const installing = f.attach("gone");
  await entered.promise;
  await f.event("Target.detachedFromTarget", { sessionId: "gone" });
  resume.resolve();
  await installing;
  assert.ok(f.calls.every((c) => c.source.sessionId !== "gone" || c.method !== "Fetch.enable"));
});

test("a preset is current only after its root installation completes", async (t) => {
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  let hold = false;
  const f = await fixture(t, async (source, method) => {
    if (hold && !source.sessionId && method === "Fetch.enable") {
      entered.resolve();
      await resume.promise;
    }
  });
  const config = f.p.presetConfig();
  assert.equal(f.p.presetCurrent(1, config), false, "no live state");
  hold = true;
  const configuring = f.p.configurePreset(1, config, "https://example.test/");
  await entered.promise;
  assert.equal(f.p.presetCurrent(1, config), false, "transition in progress");
  resume.resolve();
  await configuring;
  await setImmediate();
  assert.equal(f.p.presetCurrent(1, config), true);
  assert.equal(f.p.presetCurrent(1, f.p.presetConfig({ preset: "zen" })), false);
  assert.equal(f.p.presetCurrent(1, f.p.presetConfig({ environment: true })), false);
  const none = f.p.presetConfig({ preset: "none" });
  await f.p.configurePreset(1, none, "https://example.test/");
  assert.equal(f.p.presetCurrent(1, none), false, "none has no root interception");
});

test("a target detached during environment registration stops and removes the late script", async (t) => {
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const f = await fixture(t, async (source, method) => {
    if (source.sessionId === "gone" && method === "Page.addScriptToEvaluateOnNewDocument") {
      entered.resolve();
      await resume.promise;
    }
  });
  await f.p.configurePreset(1, f.p.presetConfig({ environment: true }), "https://example.test/");
  const count = (sessionId, method) =>
    f.calls.filter((c) => c.source.sessionId === sessionId && c.method === method).length;
  assert.equal(
    count(undefined, "Page.addScriptToEvaluateOnNewDocument"),
    3,
    "two scriptlets and the stylesheet register separately",
  );
  const installing = f.attach("gone");
  await entered.promise;
  await f.event("Target.detachedFromTarget", { sessionId: "gone" });
  resume.resolve();
  await installing;
  assert.equal(count("gone", "Page.addScriptToEvaluateOnNewDocument"), 1);
  assert.equal(count("gone", "Page.removeScriptToEvaluateOnNewDocument"), 1);
  assert.equal(count("gone", "Fetch.enable"), 0);
  await f.p.clearPreset(1);
  assert.deepEqual([...f.scripts], [], "teardown removes every root registration");
});

for (const reason of ["dispatch failure", "request capacity"]) {
  test(`late ${reason} cleanup cannot overwrite a newer Zen configuration`, async (t) => {
    const entered = Promise.withResolvers(),
      resume = Promise.withResolvers();
    const requestsEntered = Promise.withResolvers(),
      requestsResume = Promise.withResolvers();
    let ready = false,
      disabledOnce = false,
      requests = 0;
    const f = await fixture(t, async (_source, method, params) => {
      if (!ready) return;
      if (
        reason === "dispatch failure" &&
        method === "Fetch.continueRequest" &&
        params.requestId === "broken"
      )
        throw Error("dispatch failed");
      if (
        reason === "request capacity" &&
        method === "Fetch.continueRequest" &&
        params.requestId.startsWith("pending-")
      ) {
        if (++requests === 128) requestsEntered.resolve();
        await requestsResume.promise;
      }
      if (method === "Fetch.disable" && !disabledOnce) {
        disabledOnce = true;
        entered.resolve();
        await resume.promise;
      }
    });
    await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test");
    ready = true;
    const request = (id) =>
      f.event("Fetch.requestPaused", {
        requestId: id,
        resourceType: "XHR",
        request: { url: "https://example.test/api" },
      });
    const pending =
      reason === "request capacity"
        ? Array.from({ length: 128 }, (_, i) => request(`pending-${i}`))
        : [];
    if (pending.length) await requestsEntered.promise;
    const failing = request(reason === "dispatch failure" ? "broken" : "overflow");
    await entered.promise;
    const configuring = f.p.configurePreset(
      1,
      f.p.presetConfig({ preset: "zen", zen: { javascript: true } }),
      "https://example.test/new",
    );
    await setImmediate();
    resume.resolve();
    requestsResume.resolve();
    await Promise.all([failing, configuring, ...pending]);
    assert.ok(f.enabled.has(""), "late cleanup must not disable the new Fetch handler");
    assert.equal(f.javascript.get(""), true, "late cleanup must not restore site JavaScript");
    assert.equal(f.p.presetStatus(1).network, true);
  });
}

for (const initial of ["anti-ad", "none"]) {
  test(`domain-scoped rules retain existing iframe origins after ${initial} reconfiguration`, async (t) => {
    const f = await fixture(
      t,
      async (source, method) => {
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: {
                id: source.sessionId ? "child" : "main",
                url: source.sessionId ? "https://child.test/" : "https://example.test/",
              },
            },
          };
      },
      "||tracker.test^$domain=child.test",
    );
    await f.p.configurePreset(1, f.p.presetConfig({ preset: initial }), "https://example.test/");
    await f.attach("existing");
    if (initial === "anti-ad")
      await f.event(
        "Page.frameNavigated",
        { frame: { id: "child", url: "https://child.test/", parentId: "main" } },
        "existing",
      );
    await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
    await f.event(
      "Fetch.requestPaused",
      {
        requestId: "scoped",
        resourceType: "Script",
        frameId: "child",
        request: { url: "https://tracker.test/ad.js" },
      },
      "existing",
    );
    assert.ok(
      f.calls.some((c) => c.method === "Fetch.failRequest" && c.params.requestId === "scoped"),
    );
  });
}

test("enabling filtering seeds existing same-process iframe origins", async (t) => {
  const f = await fixture(
    t,
    async (_source, method) => {
      if (method === "Page.getFrameTree")
        return {
          frameTree: {
            frame: { id: "main", url: "https://example.test/" },
            childFrames: [{ frame: { id: "child", url: "https://child.test/", parentId: "main" } }],
          },
        };
    },
    "||tracker.test^$domain=child.test",
  );
  await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
  await f.event("Fetch.requestPaused", {
    requestId: "same-process",
    resourceType: "Script",
    frameId: "child",
    request: { url: "https://tracker.test/ad.js" },
  });
  assert.ok(
    f.calls.some((c) => c.method === "Fetch.failRequest" && c.params.requestId === "same-process"),
  );
});

test("concurrent failures share one target cleanup", async (t) => {
  const f = await fixture(t, async (_source, method) => {
    if (method === "Fetch.continueRequest") throw Error("dispatch failed");
  });
  await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
  await Promise.all(
    Array.from({ length: 64 }, (_, i) =>
      f.event("Fetch.requestPaused", {
        requestId: `failed-${i}`,
        resourceType: "XHR",
        request: { url: "https://example.test/api" },
      }),
    ),
  );
  assert.equal(f.calls.filter((c) => c.method === "Fetch.disable").length, 1);
  assert.equal(f.p.presetStatus(1).network, false);
});

test("overlapping configure and clear requests leave only the last selected preset", async (t) => {
  const f = await fixture(t);
  await f.p.configurePreset(1, f.p.presetConfig({ environment: true }), "https://example.test/");
  await f.attach("existing");
  const operations = [];
  for (let i = 0; i < 32; i++) {
    operations.push(
      f.p.configurePreset(
        1,
        f.p.presetConfig({ preset: "zen", zen: { javascript: true } }),
        "https://example.test/",
      ),
    );
    operations.push(f.p.clearPreset(1));
  }
  operations.push(
    f.p.configurePreset(1, f.p.presetConfig({ preset: "none" }), "https://example.test/"),
  );
  await Promise.all(operations);
  assert.equal(f.p.presetStatus(1).name, "none");
  assert.equal(f.enabled.size, 0);
  assert.equal(f.scripts.size, 0);
});

test("a tab detached during metadata lookup cannot resurrect preset state", async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  globalThis.chrome.tabs.get = async (id) => {
    entered.resolve();
    await resume.promise;
    return { id };
  };
  const configuring = f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
  await entered.promise;
  f.p.forgetPreset(1);
  resume.resolve();
  await configuring;
  assert.equal(f.p.presetStatus(1).name, "none");
  assert.equal(f.enabled.size, 0);
});

test("frame-tree snapshots cannot replace newer iframe navigation events", async (t) => {
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const f = await fixture(
    t,
    async (source, method) => {
      if (source.sessionId === "existing" && method === "Page.getFrameTree") {
        entered.resolve();
        await resume.promise;
        return {
          frameTree: { frame: { id: "child", url: "https://old-child.test/", parentId: "main" } },
        };
      }
    },
    "||tracker.test^$domain=new-child.test",
  );
  await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
  const installing = f.attach("existing");
  await entered.promise;
  await f.event(
    "Page.frameNavigated",
    { frame: { id: "child", url: "https://new-child.test/", parentId: "main" } },
    "existing",
  );
  resume.resolve();
  await installing;
  await f.event(
    "Fetch.requestPaused",
    {
      requestId: "new-origin",
      resourceType: "Script",
      frameId: "child",
      request: { url: "https://tracker.test/ad.js" },
    },
    "existing",
  );
  assert.ok(
    f.calls.some((c) => c.method === "Fetch.failRequest" && c.params.requestId === "new-origin"),
  );
});

// Chrome reports no Page.frameDetached for the iframes of a replaced document.
test("replaced documents release their frames so later iframes keep third-party rules", async (t) => {
  const f = await fixture(t, async () => {}, "||ads.test^$third-party");
  await f.p.configurePreset(1, f.p.presetConfig(), "https://site-0.test/");
  let frame = 0;
  for (let i = 0; i < 45; i++) {
    await f.event("Page.frameNavigated", { frame: { id: "main", url: `https://site-${i}.test/` } });
    for (let j = 0; j < 24; j++) {
      const frameId = `frame-${++frame}`;
      await f.event("Page.frameAttached", { frameId, parentFrameId: "main" });
      await f.event("Page.frameNavigated", {
        frame: { id: frameId, url: "https://example.test/widget.html", parentId: "main" },
      });
    }
  }
  await f.event("Page.frameAttached", { frameId: "ad", parentFrameId: "main" });
  await f.event("Fetch.requestPaused", {
    requestId: "ad-document",
    resourceType: "Document",
    frameId: "ad",
    request: { url: "https://ads.test/frame.html" },
  });
  assert.ok(
    f.calls.some((c) => c.method === "Fetch.failRequest" && c.params.requestId === "ad-document"),
    "the 45th document still classifies the iframe as a third-party subdocument",
  );
});

test("a replaced iframe document releases descendants on child targets", async (t) => {
  const f = await fixture(t, async () => {}, "||tracker.test^$domain=old-child.test");
  await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
  await f.attach("oopif");
  const load = async () => {
    await f.event("Page.frameAttached", { frameId: "a", parentFrameId: "main" });
    await f.event("Page.frameNavigated", {
      frame: { id: "a", url: "https://a.test/", parentId: "main" },
    });
    await f.event(
      "Page.frameNavigated",
      { frame: { id: "b", url: "https://old-child.test/", parentId: "a" } },
      "oopif",
    );
    await f.event(
      "Page.frameNavigated",
      { frame: { id: "c", url: "https://old-child.test/c", parentId: "b" } },
      "oopif",
    );
  };
  const outcome = async (requestId) => {
    await f.event(
      "Fetch.requestPaused",
      {
        requestId,
        resourceType: "Script",
        frameId: "c",
        request: { url: "https://tracker.test/ad.js" },
      },
      "oopif",
    );
    return f.calls.find((c) => c.params?.requestId === requestId)?.method;
  };
  await load();
  assert.equal(await outcome("loaded"), "Fetch.failRequest");
  await f.event("Page.frameNavigated", {
    frame: { id: "a", url: "https://other.test/", parentId: "main" },
  });
  assert.equal(await outcome("replaced"), "Fetch.continueRequest");
  await load();
  await f.event("Page.frameDetached", { frameId: "a" });
  assert.equal(await outcome("detached"), "Fetch.continueRequest");
});

test("a top-level navigation during the frame-tree query discards the replaced subtree", async (t) => {
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const f = await fixture(
    t,
    async (source, method) => {
      if (!source.sessionId && method === "Page.getFrameTree") {
        entered.resolve();
        await resume.promise;
        return {
          frameTree: {
            frame: { id: "main", url: "https://example.test/" },
            childFrames: [
              { frame: { id: "stale", url: "https://old-child.test/", parentId: "main" } },
            ],
          },
        };
      }
    },
    "||tracker.test^$domain=old-child.test",
  );
  const configuring = f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
  await entered.promise;
  await f.event("Page.frameNavigated", { frame: { id: "main", url: "https://next.test/" } });
  resume.resolve();
  await configuring;
  await f.event("Fetch.requestPaused", {
    requestId: "stale-origin",
    resourceType: "Script",
    frameId: "stale",
    request: { url: "https://tracker.test/ad.js" },
  });
  assert.ok(
    f.calls.some(
      (c) => c.method === "Fetch.continueRequest" && c.params.requestId === "stale-origin",
    ),
  );
});

// A cross-site iframe whose renderer is busy answers neither its installation's
// Page.enable nor Emulation.setScriptExecutionDisabled; Fetch commands still
// reach the browser process.
for (const next of ["none", "clear", "zen"]) {
  test(`switching to ${next} releases root requests while an iframe installation is busy`, async (t) => {
    const entered = Promise.withResolvers(),
      resume = Promise.withResolvers();
    const f = await fixture(t, async (source, method) => {
      if (
        source.sessionId === "busy" &&
        ["Page.enable", "Emulation.setScriptExecutionDisabled"].includes(method)
      ) {
        entered.resolve();
        await resume.promise;
      }
    });
    await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
    const installing = f.attach("busy");
    await entered.promise;
    const switching =
      next === "clear"
        ? f.p.clearPreset(1)
        : f.p.configurePreset(1, f.p.presetConfig({ preset: next }), "https://example.test/");
    try {
      for (let i = 0; i < 20; i++) await setImmediate();
      assert.equal(
        f.enabled.has(""),
        false,
        "root interception is released before the iframe answers",
      );
      await f.event("Fetch.requestPaused", {
        requestId: "root",
        resourceType: "XHR",
        frameId: "main",
        request: { url: "https://example.test/api" },
      });
      if (next === "zen")
        assert.ok(
          f.calls.some(
            (c) => c.method === "Fetch.continueRequest" && c.params.requestId === "root",
          ),
        );
    } finally {
      resume.resolve();
    }
    await Promise.all([installing, switching]);
    assert.equal(f.javascript.get(""), false);
    // Only the new preset's own installation may enable Fetch afterwards.
    assert.deepEqual(f.enabled, new Set(next === "zen" ? ["", "busy"] : []));
  });
}

// A fail-open cleanup restores site JavaScript through the iframe's renderer,
// which a busy iframe does not answer. That must not hold back later preset
// changes, which release the root target first.
async function busyIframe(t, { failRestore = false } = {}) {
  const resume = Promise.withResolvers(),
    burstEntered = Promise.withResolvers(),
    burstResume = Promise.withResolvers();
  let busy = false,
    burst = 0;
  const f = await fixture(t, async (source, method, params) => {
    if (busy && source.sessionId === "busy" && !method.startsWith("Fetch.")) {
      await resume.promise;
      if (failRestore && method === "Emulation.setScriptExecutionDisabled")
        throw Error("Target closed");
    }
    if (method === "Fetch.continueRequest" && params.requestId === "broken")
      throw Error("Invalid InterceptionId.");
    if (method === "Fetch.continueRequest" && params.requestId.startsWith("burst-")) {
      if (++burst === 128) burstEntered.resolve();
      await burstResume.promise;
    }
  });
  const request = (requestId, sessionId) =>
    f.event(
      "Fetch.requestPaused",
      { requestId, resourceType: "XHR", request: { url: "https://example.test/api" } },
      sessionId,
    );
  // Fail the busy iframe open through a dispatch failure or the request limit.
  const failOpen = async (reason) => {
    busy = true;
    const burstRequests =
      reason === "request capacity"
        ? Array.from({ length: 128 }, (_, i) => request(`burst-${i}`))
        : [];
    if (burstRequests.length) await burstEntered.promise;
    const failing = request(reason === "request capacity" ? "overflow" : "broken", "busy");
    burstResume.resolve();
    await Promise.all(burstRequests);
    for (let i = 0; i < 20; i++) await setImmediate();
    // Wrapped so that awaiting failOpen does not wait for the cleanup.
    return { failing };
  };
  t.after(() => resume.resolve());
  return { ...f, failOpen, resume: () => resume.resolve() };
}

for (const reason of ["dispatch failure", "request capacity"]) {
  for (const next of ["none", "clear"]) {
    test(`switching to ${next} after a busy iframe's ${reason} releases the root first`, async (t) => {
      const f = await busyIframe(t);
      await f.p.configurePreset(
        1,
        f.p.presetConfig({ preset: "zen", zen: { javascript: true } }),
        "https://example.test/",
      );
      await f.attach("busy");
      const { failing } = await f.failOpen(reason);
      const before = f.calls.length;
      const switching =
        next === "clear"
          ? f.p.clearPreset(1)
          : f.p.configurePreset(1, f.p.presetConfig({ preset: "none" }), "https://example.test/");
      try {
        for (let i = 0; i < 20; i++) await setImmediate();
        assert.ok(
          f.calls.slice(before).some((c) => !c.source.sessionId && c.method === "Fetch.disable"),
          "the root is released before the busy iframe answers",
        );
        assert.equal(f.enabled.has(""), false);
      } finally {
        f.resume();
      }
      await Promise.all([failing, switching]);
      assert.deepEqual([...f.enabled], []);
      assert.equal(f.javascript.get("busy"), false, "site JavaScript is restored once it answers");
    });
  }
}

test("a busy iframe's fail-open restore is sent before a newer Zen configuration", async (t) => {
  const f = await busyIframe(t);
  await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
  await f.attach("busy");
  const { failing } = await f.failOpen("dispatch failure");
  const switching = f.p.configurePreset(
    1,
    f.p.presetConfig({ preset: "zen", zen: { javascript: true } }),
    "https://example.test/",
  );
  try {
    for (let i = 0; i < 20; i++) await setImmediate();
    assert.equal(f.javascript.get(""), true, "the root installs Zen before the iframe answers");
  } finally {
    f.resume();
  }
  await Promise.all([failing, switching]);
  // Chrome applies one session's commands in the order they are sent.
  assert.deepEqual(
    f.calls
      .filter(
        (c) => c.source.sessionId === "busy" && c.method === "Emulation.setScriptExecutionDisabled",
      )
      .map((c) => c.params.value),
    [false, false, true],
  );
  assert.equal(f.javascript.get("busy"), true);
  assert.deepEqual(
    [...f.enabled].sort((a, b) => a.localeCompare(b)),
    ["", "busy"],
  );
});

test("a failed site JavaScript restore after fail-open is reported", async (t) => {
  const f = await busyIframe(t, { failRestore: true });
  await f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
  await f.attach("busy");
  const { failing } = await f.failOpen("dispatch failure");
  f.resume();
  await failing;
  for (let i = 0; i < 20; i++) await setImmediate();
  assert.ok(
    f.p
      .presetStatus(1)
      .fallback.some((reason) => reason.startsWith("site JavaScript not restored after fail-open")),
  );
});

// The request over the pending limit is released at once. Its target's cleanup
// waits in the preset queue, which a reconfiguration still installing a busy
// iframe holds.
test("the request over the pending limit continues while a busy iframe installs", async (t) => {
  const resume = Promise.withResolvers(),
    burstEntered = Promise.withResolvers(),
    burstResume = Promise.withResolvers();
  let busy = false,
    burst = 0;
  const f = await fixture(t, async (source, method, params) => {
    if (busy && source.sessionId === "busy" && !method.startsWith("Fetch.")) await resume.promise;
    if (method === "Fetch.continueRequest" && params.requestId.startsWith("burst-")) {
      if (++burst === 128) burstEntered.resolve();
      await burstResume.promise;
    }
  });
  const request = (requestId) =>
    f.event("Fetch.requestPaused", {
      requestId,
      resourceType: "Image",
      request: { url: `https://example.test/${requestId}.png` },
    });
  // The iframe target is attached before the preset installs on the tab.
  await f.attach("busy");
  busy = true;
  const configuring = f.p.configurePreset(1, f.p.presetConfig(), "https://example.test/");
  let overflow;
  try {
    for (let i = 0; i < 20; i++) await setImmediate();
    assert.ok(f.enabled.has(""), "the root intercepts while the iframe installs");
    const burstRequests = Array.from({ length: 128 }, (_, i) => request(`burst-${i}`));
    await burstEntered.promise;
    overflow = request("overflow");
    burstResume.resolve();
    await Promise.all(burstRequests);
    for (let i = 0; i < 20; i++) await setImmediate();
    assert.ok(
      f.calls.some(
        (c) => c.method === "Fetch.continueRequest" && c.params.requestId === "overflow",
      ),
      "the request over the limit continues before the iframe answers",
    );
    assert.ok(
      f.p.presetStatus(1).fallback.includes("interception capacity exceeded; target failed open"),
    );
  } finally {
    resume.resolve();
    burstResume.resolve();
  }
  await Promise.all([configuring, overflow]);
  assert.equal(f.enabled.has(""), false, "the root fails open once the preset queue is free");
});
