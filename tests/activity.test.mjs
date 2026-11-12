import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";

// Loads activity.ts and state.ts as one fresh module instance with a fake
// chrome API. Session 'task' owns tab 7, so the layer follows that tab. Each
// paint records whether it hid the layer and whether a capture was running.
async function activity(t, name) {
  const noopEvent = () => ({ addListener() {} });
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({}) },
      session: {
        get: async () => ({ sessions: { task: { tabs: [7], borrowed: [], title: "task" } } }),
        set: async () => {},
      },
      onChanged: noopEvent(),
    },
    i18n: { getUILanguage: () => "en" },
    runtime: { getURL: (path) => `chrome-extension://omw/${path}` },
    tabs: { onUpdated: noopEvent() },
    alarms: { onAlarm: noopEvent(), create: async () => {} },
  };
  globalThis.fetch = async () => new Response(new Uint8Array([137, 80, 78, 71]));
  t.after(() => {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  });
  const result = await build({
    stdin: {
      contents:
        'export * from "./extension/src/activity.ts"; export { initSessions } from "./extension/src/state.ts";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${name}`
  );
  const paints = [];
  const captures = { running: 0 };
  module.startActivity(async (tabId, state) => {
    paints.push({ tabId, hidden: state.hidden === true, capturing: captures.running > 0 });
  });
  await module.initSessions(async () => {});
  await flush();
  assert.equal(paints.length, 1, "the controlled tab gets the layer");
  // A capture that runs until the test ends it.
  const capture = () => {
    const done = Promise.withResolvers();
    const running = module.withoutLayer(7, async () => {
      captures.running++;
      await done.promise;
      captures.running--;
    });
    return { end: () => done.resolve(), running };
  };
  return { module, paints, capture };
}
// Lets the worker's promise chains run to completion.
async function flush() {
  for (let i = 0; i < 20; i++) await setImmediate();
}

test("the activity layer stays hidden while a capture runs past the settle time", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const { module, paints, capture } = await activity(t, "settle");
  assert.equal(module.actionStarted(7, "click"), true);
  module.actionFinished(7);
  const screenshot = capture();
  await flush();
  // The layer repaints without the focus frame 600 ms after the action.
  mock.timers.tick(600);
  await flush();
  const during = paints.filter((paint) => paint.capturing);
  assert.equal(during.length, 1, JSON.stringify(paints));
  assert.equal(during[0].hidden, true, "the settle repaint keeps the layer hidden");
  screenshot.end();
  await screenshot.running;
  await flush();
  assert.deepEqual(paints.at(-1), { tabId: 7, hidden: false, capturing: false });
});

test("overlapping captures keep the layer hidden until the last one ends", async (t) => {
  const { paints, capture } = await activity(t, "overlap");
  const first = capture();
  const second = capture();
  await flush();
  const before = paints.length;
  first.end();
  await first.running;
  await flush();
  // The end of the first capture repaints the tab while the second still runs.
  const repaints = paints.slice(before);
  assert.deepEqual(repaints, [{ tabId: 7, hidden: true, capturing: true }]);
  second.end();
  await second.running;
  await flush();
  assert.deepEqual(paints.at(-1), { tabId: 7, hidden: false, capturing: false });
});
