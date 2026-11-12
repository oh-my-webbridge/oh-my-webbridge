import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

// Loads indicator.ts as a fresh module instance against a fake chrome API.
// Session storage is shared between instances, so a second instance stands
// for a restarted background. The fake action keeps the global value and the
// tab-specific values apart, as Chrome does: a tab shows its own value until
// the tab closes or navigates.
function browser() {
  const session = {};
  const local = {};
  const listeners = [];
  const open = new Set([7, 8]);
  const icons = { global: undefined, tabs: new Map() };
  const titles = { global: undefined, tabs: new Map() };
  const set = (store, details, value) => {
    if (details.tabId === undefined) store.global = value;
    else if (!open.has(details.tabId)) throw new Error(`No tab with id: ${details.tabId}.`);
    else store.tabs.set(details.tabId, value);
  };
  const write = async (area, store, values) => {
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      changes[key] = { newValue: value };
      store[key] = structuredClone(value);
    }
    for (const listener of listeners) listener(changes, area);
  };
  const read = async (store, keys) =>
    Object.fromEntries(
      [keys]
        .flat()
        .filter((key) => key in store)
        .map((key) => [key, structuredClone(store[key])]),
    );
  const noopEvent = () => ({ addListener() {} });
  const removed = [];
  const chrome = {
    storage: {
      session: {
        get: (keys) => read(session, keys),
        set: (values) => write("session", session, values),
      },
      local: { get: (keys) => read(local, keys), set: (values) => write("local", local, values) },
      onChanged: { addListener: (listener) => listeners.push(listener) },
    },
    action: {
      setBadgeText: async () => {},
      setIcon: async (details) => set(icons, details, details.path[16]),
      setTitle: async (details) => set(titles, details, details.title),
    },
    i18n: { getUILanguage: () => "en" },
    tabs: {
      onUpdated: noopEvent(),
      onRemoved: { addListener: (listener) => removed.push(listener) },
    },
  };
  // The icon and title that the toolbar shows while tabId is selected.
  const shown = (tabId) => ({
    icon: icons.tabs.get(tabId) ?? icons.global,
    title: titles.tabs.get(tabId) ?? titles.global,
  });
  const close = (tabId) => {
    open.delete(tabId);
    icons.tabs.delete(tabId);
    titles.tabs.delete(tabId);
    for (const listener of removed) listener(tabId);
  };
  // The background stops: its listeners no longer receive events.
  const stop = () => {
    listeners.length = 0;
    removed.length = 0;
  };
  return { chrome, session, shown, close, stop };
}

async function start(t, fake, name) {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = fake.chrome;
  t.after(() => {
    globalThis.chrome = originalChrome;
  });
  const result = await build({
    entryPoints: ["extension/src/indicator.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${name}`
  );
  module.startIndicator();
}

// Waits until the toolbar of tabId shows icon.
async function until(fake, tabId, icon) {
  for (let i = 0; i < 400 && fake.shown(tabId).icon !== icon; i++) await delay(5);
  return fake.shown(tabId);
}

const connected = { state: "connected", since: 1 };
const paused = { state: "paused", since: 2 };
const control = { session: "task", borrowed: true, busy: false };

test("a released tab follows later connection changes", async (t) => {
  const fake = browser();
  await start(t, fake, "released");
  await fake.chrome.storage.session.set({ connection: connected, controls: { 7: control } });
  assert.equal(
    (await until(fake, 7, "icons/toolbar-live-16.png")).icon,
    "icons/toolbar-live-16.png",
  );
  await fake.chrome.storage.session.set({ controls: {} });
  assert.equal(
    (await until(fake, 7, "icons/toolbar-connected-16.png")).icon,
    "icons/toolbar-connected-16.png",
  );
  await fake.chrome.storage.session.set({ connection: paused });
  const shown = await until(fake, 7, "icons/toolbar-paused-16.png");
  assert.deepEqual(shown, fake.shown(8), "the released tab shows the same state as other tabs");
  assert.equal(shown.icon, "icons/toolbar-paused-16.png");
});

test("a restarted background keeps updating tabs that a session released", async (t) => {
  const fake = browser();
  await start(t, fake, "before-restart");
  await fake.chrome.storage.session.set({ connection: connected, controls: { 7: control } });
  await until(fake, 7, "icons/toolbar-live-16.png");
  await fake.chrome.storage.session.set({ controls: {} });
  await until(fake, 7, "icons/toolbar-connected-16.png");
  fake.stop();
  await start(t, fake, "after-restart");
  await fake.chrome.storage.session.set({ connection: paused });
  assert.equal(
    (await until(fake, 7, "icons/toolbar-paused-16.png")).icon,
    "icons/toolbar-paused-16.png",
  );
});

test("a closed tab leaves the list of tabs with their own toolbar values", async (t) => {
  const fake = browser();
  await start(t, fake, "closed");
  await fake.chrome.storage.session.set({ connection: connected, controls: { 7: control } });
  await until(fake, 7, "icons/toolbar-live-16.png");
  for (let i = 0; i < 400 && !fake.session.actionTabs?.includes(7); i++) await delay(5);
  assert.deepEqual(fake.session.actionTabs, [7]);
  fake.close(7);
  for (let i = 0; i < 400 && fake.session.actionTabs.length; i++) await delay(5);
  assert.deepEqual(fake.session.actionTabs, []);
});
