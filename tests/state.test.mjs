import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";

async function load(t, entry, chromeApi) {
  const original = { chrome: globalThis.chrome, error: console.error };
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => {
    globalThis.chrome = original.chrome;
    console.error = original.error;
  });
  globalThis.chrome = chromeApi;
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${t.name}`
  );
  return { module, errors };
}
// Session storage holding stored; saved receives every write.
const restored = (stored, saved = []) => ({
  storage: {
    session: {
      get: async () => ({ sessions: stored }),
      set: async (value) => {
        saved.push(structuredClone(value));
      },
    },
  },
});

test("session persistence coalesces bursts without retaining stale snapshots", async (t) => {
  let releaseFirst, started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const writes = [];
  const { module: state } = await load(t, "extension/src/state.ts", {
    storage: {
      session: {
        get: async () => ({}),
        set: async (value) => {
          writes.push(structuredClone(value));
          if (writes.length === 1) {
            started();
            await new Promise((resolve) => {
              releaseFirst = resolve;
            });
          }
        },
      },
    },
  });
  await state.initSessions(async () => {});
  const session = await state.getSession("fixture");
  session.current = 1;
  session.tabs = [1];
  const first = state.persist();
  await began;
  session.current = 2;
  session.tabs.push(2);
  session.title = "latest";
  const burst = Array.from({ length: 128 }, () => state.persist());
  releaseFirst();
  await Promise.all([first, ...burst]);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].sessions.fixture.current, 1);
  assert.equal(writes[1].sessions.fixture.current, 2);
  assert.equal(writes[1].sessions.fixture.title, "latest");
  assert.deepEqual(writes[1].sessions.fixture.tabs, [1, 2]);
});

test("restored sessions hand persisted tabs to the backend before commands run", async (t) => {
  const { module: state } = await load(
    t,
    "extension/src/state.ts",
    restored({
      task: { tabs: [1, 2], borrowed: [3], title: "task" },
      other: { tabs: [4], borrowed: [], title: "other" },
    }),
  );
  const released = [];
  const held = Promise.withResolvers();
  const init = state.initSessions(async (tabIds) => {
    released.push(tabIds);
    await held.promise;
  });
  let settled = false;
  const session = state.getSession("task").then((value) => {
    settled = true;
    return value;
  });
  await setImmediate();
  assert.deepEqual(released, [[1, 2, 3, 4]]);
  assert.equal(settled, false, "commands wait for the release");
  held.resolve();
  await init;
  assert.deepEqual((await session).tabs, [1, 2]);
  assert.deepEqual(await state.sessionNames(), ["task", "other"]);
  await state.getSession("new");
  assert.deepEqual(await state.sessionNames(), ["task", "other", "new"]);
});

test("session state refuses commands before and repeated initialization", async (t) => {
  const { module: state } = await load(t, "extension/src/state.ts", restored({}));
  await assert.rejects(state.getSession("early"), { code: "internal" });
  await assert.rejects(state.sessionNames(), { code: "internal" });
  await state.initSessions(async (tabIds) => assert.deepEqual(tabIds, []));
  assert.deepEqual(await state.sessionNames(), []);
  assert.throws(() => state.initSessions(async () => {}), { code: "internal" });
});

test("a failed release keeps session commands failing", async (t) => {
  const { module: state } = await load(
    t,
    "extension/src/state.ts",
    restored({ task: { tabs: [7], borrowed: [], title: "task" } }),
  );
  await assert.rejects(
    state.initSessions(async () => {
      throw Error("getTargets failed");
    }),
    /getTargets failed/u,
  );
  await assert.rejects(state.getSession("task"), /getTargets failed/u);
  await assert.rejects(state.sessionNames(), /getTargets failed/u);
});

test("Chrome releases inherited debugger sessions of persisted tabs only", async (t) => {
  const detached = [];
  const { module: cdp, errors } = await load(t, "extension/src/cdp.ts", {
    storage: { session: { get: async () => ({}), set: async () => {} } },
    debugger: {
      getTargets: async () => [
        { type: "page", tabId: 1, attached: true },
        { type: "page", tabId: 2, attached: false },
        { type: "page", tabId: 3, attached: true },
        { type: "page", tabId: 4, attached: true },
        { type: "page", tabId: 9, attached: true },
        { type: "other", attached: true },
      ],
      detach: async ({ tabId }) => {
        detached.push(tabId);
        if (tabId === 4) throw Error("Debugger is not attached to the tab with id: 4.");
      },
    },
  });
  await cdp.releaseInherited([1, 2, 3, 4]);
  assert.deepEqual(detached, [1, 3, 4], "persisted, attached task and borrowed tabs only");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /tab 4 Error: Debugger is not attached/u);
});

test("Chrome without persisted tabs does not inspect debugger targets", async (t) => {
  const { module: cdp } = await load(t, "extension/src/cdp.ts", {
    debugger: { getTargets: async () => assert.fail("no persisted tab to release") },
  });
  await cdp.releaseInherited([]);
});

test("restored sessions drop the sessions of page CDP clients", async (t) => {
  const saved = [];
  const { module: state } = await load(
    t,
    "extension/src/state.ts",
    restored(
      {
        task: { tabs: [1], borrowed: [], title: "task" },
        [`cdp-${"a".repeat(32)}`]: { tabs: [], borrowed: [5], current: 5, title: "cdp" },
      },
      saved,
    ),
  );
  const released = [];
  await state.initSessions(async (tabIds) => {
    released.push(...tabIds);
  });
  // The backend releases the page client's tab with the other persisted tabs.
  assert.deepEqual(released, [1, 5]);
  assert.deepEqual((await state.getSession("task")).tabs, [1]);
  // The client's daemon connection is gone; the user's tab belongs to no session.
  assert.equal(state.owner(5), undefined);
  assert.deepEqual(await state.sessionNames(), ["task"], "hello omits the page client");
  assert.deepEqual(Object.keys(saved.at(-1).sessions), ["task"]);
});

test("a closed current tab leaves its session without a current tab", async (t) => {
  const { module: state } = await load(
    t,
    "extension/src/state.ts",
    restored({ task: { tabs: [1, 2], borrowed: [3], current: 2, title: "task" } }),
  );
  await state.initSessions(async () => {});
  await state.removed(1);
  assert.equal((await state.getSession("task")).current, 2, "another tab keeps the current one");
  await state.removed(2);
  const session = await state.getSession("task");
  assert.equal(session.current, undefined);
  assert.deepEqual(session.tabs, []);
  assert.deepEqual(session.borrowed, [3]);
});

test("leaving the current tab continues in the last other task tab, else the last other borrowed tab", async (t) => {
  const { module: state } = await load(t, "extension/src/state.ts", restored({}));
  const session = { tabs: [1, 2, 3], borrowed: [4, 5], current: 2, title: "task" };
  state.leaveTab(session, 3);
  assert.equal(session.current, 2, "a tab other than the current one");
  state.leaveTab(session, 2);
  assert.equal(session.current, 3);
  const borrowedOnly = { tabs: [3], borrowed: [4, 5], current: 3, title: "task" };
  state.leaveTab(borrowedOnly, 3);
  assert.equal(borrowedOnly.current, 5);
  const last = { tabs: [], borrowed: [5], current: 5, title: "task" };
  state.leaveTab(last, 5);
  assert.equal(last.current, undefined);
});
