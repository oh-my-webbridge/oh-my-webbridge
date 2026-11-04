import assert from "node:assert/strict";
import { test } from "node:test";
import { FiltersEngine } from "@ghostery/adblocker";
import { bundle, firefoxApi } from "./fixtures/firefox-api.mjs";

const anti = {
  name: "anti-ad",
  environment: false,
  images: true,
  fonts: true,
  css: false,
  javascript: false,
};
// Listeners a preset installs for tab 5; navigation.js listens to every tab.
const ofTab = (target) => target.listeners.filter((listener) => listener.filter?.tabId === 5);
async function fixture(t, fetchLists, options) {
  const original = {
    chrome: globalThis.chrome,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
  };
  const api = firefoxApi(options);
  globalThis.chrome = api.chrome;
  const bytes = FiltersEngine.parse("||tracker.test^").serialize();
  globalThis.fetch = fetchLists ?? (async () => new Response(bytes));
  globalThis.setTimeout = (...args) => original.setTimeout(...args).unref();
  t.after(() => Object.assign(globalThis, original));
  const m = await bundle('export * from "./extension/src/firefox/presets.ts";', t.name);
  const request = (details) =>
    api.chrome.webRequest.onBeforeRequest.emit({
      tabId: 5,
      requestId: "1",
      method: "GET",
      documentUrl: "https://news.test/",
      ...details,
    })[0];
  return { ...api, m, request };
}

test("anti-ad cancels listed requests of the task tab and counts the decisions", async (t) => {
  const f = await fixture(t);
  await f.m.configurePreset(5, anti);
  const [listener] = f.chrome.webRequest.onBeforeRequest.listeners;
  assert.deepEqual(listener.filter, { urls: ["<all_urls>"], tabId: 5 });
  assert.deepEqual(listener.extra, ["blocking"]);
  assert.deepEqual(f.request({ url: "https://tracker.test/ad.js", type: "script" }), {
    cancel: true,
  });
  assert.equal(f.request({ url: "https://news.test/app.js", type: "script" }), undefined);
  assert.equal(f.request({ url: "https://news.test/", type: "main_frame" }), undefined);
  assert.deepEqual(f.m.presetStatus(5), {
    ...anti,
    blocked: 1,
    allowed: 2,
    network: true,
    environmentState: "off",
    fallback: [],
  });
  assert.equal(f.m.presetCurrent(5, anti), true);
  assert.equal(f.m.presetCurrent(5, { ...anti, name: "zen" }), false);
});

test("zen cancels the chosen resource types and stops site JavaScript with a CSP header", async (t) => {
  const f = await fixture(t);
  const zen = { ...anti, name: "zen", css: true, javascript: true };
  await f.m.configurePreset(5, zen);
  for (const type of ["image", "imageset", "font", "stylesheet", "script"])
    assert.deepEqual(f.request({ url: `https://news.test/r.${type}`, type }), { cancel: true });
  assert.equal(
    f.request({ url: "https://news.test/data.json", type: "xmlhttprequest" }),
    undefined,
  );
  const [headers] = ofTab(f.chrome.webRequest.onHeadersReceived);
  assert.deepEqual(headers.filter, {
    urls: ["<all_urls>"],
    tabId: 5,
    types: ["main_frame", "sub_frame"],
  });
  assert.deepEqual(headers.extra, ["blocking", "responseHeaders"]);
  assert.deepEqual(
    headers.fn({ responseHeaders: [{ name: "Content-Type", value: "text/html" }] }),
    {
      responseHeaders: [
        { name: "Content-Type", value: "text/html" },
        { name: "Content-Security-Policy", value: "script-src 'none'" },
      ],
    },
  );
});

test("unavailable lists fail open and record why", async (t) => {
  const f = await fixture(t, async () => new Response("missing", { status: 404 }));
  const status = await f.m.configurePreset(5, anti);
  assert.equal(status.network, true);
  assert.match(status.fallback[0], /^network lists unavailable; Error: bundled filters: 404/);
  assert.equal(f.request({ url: "https://tracker.test/ad.js", type: "script" }), undefined);
  assert.equal(f.m.presetStatus(5).allowed, 1);
});

test("environment reports unavailable and network filtering still applies", async (t) => {
  const f = await fixture(t);
  const status = await f.m.configurePreset(5, { ...anti, environment: true });
  assert.equal(status.environmentState, "unavailable");
  assert.match(status.fallback[0], /^environment is not available in Firefox/);
  assert.deepEqual(f.request({ url: "https://tracker.test/ad.js", type: "script" }), {
    cancel: true,
  });
});

test("reconfiguring replaces the tab's listeners and none removes them", async (t) => {
  const f = await fixture(t);
  await f.m.configurePreset(5, { ...anti, name: "zen", javascript: true });
  await f.m.configurePreset(5, anti);
  assert.equal(f.chrome.webRequest.onBeforeRequest.listeners.length, 1);
  assert.equal(ofTab(f.chrome.webRequest.onHeadersReceived).length, 0);
  const status = await f.m.configurePreset(5, { ...anti, name: "none" });
  assert.equal(status.network, false);
  assert.equal(f.chrome.webRequest.onBeforeRequest.listeners.length, 0);
  await f.m.configurePreset(5, anti);
  f.m.forgetPreset(5);
  assert.equal(f.chrome.webRequest.onBeforeRequest.listeners.length, 0);
  assert.deepEqual(f.m.presetStatus(5), {
    name: "none",
    network: false,
    environmentState: "off",
    fallback: [],
  });
});

test("a newer configuration supersedes one still loading the lists", async (t) => {
  const release = Promise.withResolvers();
  const bytes = FiltersEngine.parse("||tracker.test^").serialize();
  const f = await fixture(t, async () => {
    await release.promise;
    return new Response(bytes);
  });
  const first = f.m.configurePreset(5, anti);
  const second = f.m.configurePreset(5, { ...anti, name: "zen" });
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(f.chrome.webRequest.onBeforeRequest.listeners.length, 1);
  assert.equal(f.m.presetStatus(5).name, "zen");
});

test("without access to all websites the status reports that requests are not filtered", async (t) => {
  const f = await fixture(t, undefined, { permissions: [] });
  // The worker refreshes the access state on permission changes.
  const m = await bundle(
    'import "./extension/src/firefox/worker.ts"; export * from "./extension/src/firefox/presets.ts";',
    `${t.name} worker`,
  );
  await m.configurePreset(5, anti);
  // Firefox ignores the cancellation, so the request counts as allowed.
  assert.equal(f.request({ url: "https://tracker.test/ad.js", type: "script" }), undefined);
  const status = m.presetStatus(5);
  assert.equal(status.network, false);
  assert.equal(status.blocked, 0);
  assert.equal(status.allowed, 1);
  assert.match(status.fallback[0], /^request filtering needs access to all websites; /);
  f.state.permissions.add("<all_urls>");
  f.chrome.permissions.onAdded.emit({ permissions: [], origins: ["<all_urls>"] });
  for (let i = 0; i < 10 && !m.presetStatus(5).network; i++) await new Promise(setImmediate);
  assert.deepEqual(f.request({ url: "https://tracker.test/ad.js", type: "script" }), {
    cancel: true,
  });
  assert.deepEqual(m.presetStatus(5), {
    ...anti,
    blocked: 1,
    allowed: 1,
    network: true,
    environmentState: "off",
    fallback: [],
  });
});
