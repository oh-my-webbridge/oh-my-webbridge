import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { bundle, firefoxApi } from "./fixtures/firefox-api.mjs";

const token = "c".repeat(64);
// Starts the Firefox background against fake APIs and a fake daemon socket
// that answers hello and records every frame the extension sends. Like a
// browser WebSocket, the socket's close() accepts only 1000 and 3000–4999,
// and bufferedAmount grows by the UTF-8 size of each frame until the test
// drains it. prepare changes the fake APIs before the background starts; with
// wait false, start returns without waiting for the hello. source is the
// module that starts the background; its exports are returned as module.
async function start(
  t,
  options = {},
  { prepare = () => {}, wait = true, source = 'import "./extension/src/firefox/worker.ts";' } = {},
) {
  const original = {
    chrome: globalThis.chrome,
    WebSocket: globalThis.WebSocket,
    setTimeout: globalThis.setTimeout,
  };
  // Reconnect backoff timers must not keep the test process alive.
  globalThis.setTimeout = (...args) => original.setTimeout(...args).unref();
  const api = firefoxApi(options);
  let paused = false;
  api.chrome.storage.local.get = async () => ({ token, paused });
  const queries = [];
  api.chrome.tabs.query = async (filter) => {
    queries.push(filter);
    return [];
  };
  const sockets = [];
  const frames = [];
  const hello = Promise.withResolvers();
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    closes = [];
    constructor(url, protocols) {
      sockets.push({ socket: this, url, protocols });
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(wire) {
      const packet = JSON.parse(wire);
      frames.push(packet);
      this.bufferedAmount += Buffer.byteLength(wire);
      if (packet.type === "hello") {
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ type: "hello", protocol: 1 }) });
          hello.resolve(packet);
        });
      }
    }
    close(code, reason) {
      if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
        throw new DOMException(`invalid close code ${code}`, "InvalidAccessError");
      if (this.readyState === 3) return;
      this.closes.push({ code, reason });
      this.readyState = 3;
      this.onclose?.();
    }
  };
  prepare(api);
  globalThis.chrome = api.chrome;
  t.after(async () => {
    paused = true;
    for (const { socket } of sockets) socket.close();
    api.chrome.storage.onChanged.emit({ paused: { newValue: true } }, "local");
    // The activity layer settles 600 ms after the last action on a tab.
    await new Promise((resolve) => original.setTimeout(resolve, 650));
    Object.assign(globalThis, original);
  });
  const module = await bundle(source, t.name);
  if (!wait) return { ...api, module, sockets, frames, queries };
  return { ...api, module, sockets, frames, queries, hello: await hello.promise };
}
// Delivers get requests for the session "task" on the first daemon connection.
// The page answers the selector #big with page.big and anything else with
// "small".
async function transport(t) {
  const page = { big: "" };
  const f = await start(t, {
    sessions: { task: { tabs: [5], borrowed: [], current: 5, title: "task" } },
    tabs: [{ id: 5, url: "https://example.test/" }],
    page: async (op, args) => ({
      ok: true,
      value: { value: args?.selector === "#big" ? page.big : "small" },
    }),
  });
  const { socket } = f.sockets[0];
  // The daemon has read the hello.
  socket.bufferedAmount = 0;
  return {
    ...f,
    socket,
    page,
    deliver: (id, args) =>
      socket.onmessage({
        data: JSON.stringify({
          type: "request",
          id,
          command: { session: "task", action: "get", args },
          deadline: Date.now() + 60000,
        }),
      }),
    responses: () => f.frames.filter((frame) => frame.type === "response"),
  };
}
// Waits for the background's timers and promises, up to about ms milliseconds.
async function settle(done, ms = 2000) {
  for (let i = 0; i < ms / 5 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
}

test("Firefox hello reports the browser, its version and the persisted sessions", async (t) => {
  const f = await start(t, {
    sessions: {
      task: { tabs: [], borrowed: [], title: "task" },
      研究: { tabs: [], borrowed: [], title: "研究" },
    },
  });
  assert.equal(f.sockets[0].url, "ws://127.0.0.1:17373/extension");
  assert.deepEqual(f.sockets[0].protocols, ["omw.v1", `omw-token.${token}`]);
  assert.deepEqual(f.hello, {
    type: "hello",
    protocol: 1,
    browser: "firefox",
    browserVersion: "159.0",
    sessions: ["task", "研究"],
  });
});

test("every heartbeat calls an extension API so the event page stays awake", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const f = await start(t);
  await setImmediate();
  assert.deepEqual(f.queries, []);
  t.mock.timers.tick(20000);
  t.mock.timers.tick(20000);
  await setImmediate();
  assert.equal(f.frames.filter((frame) => frame.type === "ping").length, 2);
  assert.deepEqual(f.queries, [
    { active: true, lastFocusedWindow: true },
    { active: true, lastFocusedWindow: true },
  ]);
  // No daemon frame for more than 45 s: the extension drops the connection.
  t.mock.timers.tick(20000);
  assert.equal(f.sockets[0].socket.readyState, 3);
});

test("closing a task tab releases its listeners and session entry", async (t) => {
  const f = await start(t, {
    sessions: { task: { tabs: [5], borrowed: [], current: 5, title: "task" } },
    tabs: [{ id: 5, url: "https://example.test/" }],
  });
  const answered = Promise.withResolvers();
  const { socket } = f.sockets[0];
  const send = socket.send.bind(socket);
  socket.send = (wire) => {
    send(wire);
    if (JSON.parse(wire).type === "response") answered.resolve(JSON.parse(wire));
  };
  socket.onmessage({
    data: JSON.stringify({
      type: "request",
      id: "r1",
      command: { session: "task", action: "emulate", args: { data: { "X-Task": "1" } } },
      deadline: Date.now() + 5000,
    }),
  });
  assert.deepEqual(await answered.promise, {
    type: "response",
    id: "r1",
    result: { success: true },
  });
  assert.equal(f.chrome.webRequest.onBeforeSendHeaders.listeners.length, 1);
  f.state.tabs.delete(5);
  f.chrome.tabs.onRemoved.emit(5);
  await setImmediate();
  assert.equal(f.chrome.webRequest.onBeforeSendHeaders.listeners.length, 0);
  assert.deepEqual(f.state.sessions.task.tabs, []);
});

test("a frame selection ends when the tab's URL changes, not when Firefox repeats it", async (t) => {
  const frameId = 12884901889;
  const f = await start(t, {
    sessions: { task: { tabs: [5], borrowed: [], current: 5, title: "task" } },
    tabs: [{ id: 5, url: "https://example.test/" }],
    page: async (op, _args, documentId) => ({
      ok: true,
      value: op === "frame" ? { frameId } : { documentId },
    }),
  });
  f.state.documents.set("doc-frame", { frameId });
  const { socket } = f.sockets[0];
  let next = 0;
  const run = async (action, args = {}) => {
    const id = `r${++next}`;
    socket.onmessage({
      data: JSON.stringify({
        type: "request",
        id,
        command: { session: "task", action, args },
        deadline: Date.now() + 5000,
      }),
    });
    let reply;
    while (!(reply = f.frames.find((frame) => frame.type === "response" && frame.id === id)))
      await setImmediate();
    return reply.error?.code ?? reply.result;
  };
  const updated = (change) => {
    if (change.url) f.state.tabs.get(5).url = change.url;
    f.chrome.tabs.onUpdated.emit(5, change, { ...f.state.tabs.get(5) });
  };
  assert.deepEqual(await run("frame", { selector: "iframe#pay" }), { frameId: String(frameId) });
  assert.deepEqual(await run("get", { selector: "h1" }), { documentId: "doc-frame" });
  // Once an iframe that navigated to another site is removed, Firefox reports
  // the tab complete with its unchanged URL.
  updated({ status: "complete", url: "https://example.test/" });
  assert.deepEqual(await run("get", { selector: "h1" }), { documentId: "doc-frame" });
  // The main document reloads at the same URL and replaces the frame's document.
  updated({ status: "loading" });
  f.state.documents.delete("doc-frame");
  f.state.documents.set("doc-reloaded", { frameId });
  updated({ status: "complete" });
  assert.equal(await run("get", { selector: "h1" }), "frame_unavailable");
  assert.deepEqual(await run("get", { selector: "h1" }), { documentId: "doc-main" });
  // After a lost frame, frame resolves its selector in the main frame.
  assert.deepEqual(await run("frame", { selector: "iframe#pay" }), { frameId: String(frameId) });
  f.state.documents.delete("doc-reloaded");
  f.state.documents.set("doc-moved", { frameId });
  assert.deepEqual(await run("frame", { selector: "iframe#pay" }), { frameId: String(frameId) });
  assert.deepEqual(await run("get", { selector: "h1" }), { documentId: "doc-moved" });
  // A new URL, as after history.pushState, returns to the main frame.
  updated({ url: "https://example.test/#pushed" });
  assert.deepEqual(await run("get", { selector: "h1" }), { documentId: "doc-main" });
});

test("close_session and dialog use the recovery reserve while 128 jobs wait", async (t) => {
  const hung = [0, 1, 2, 3].map((i) => ({ name: `hung-${i}`, tab: 10 + i }));
  const f = await start(t, {
    sessions: Object.fromEntries(
      hung.map(({ name, tab }) => [name, { tabs: [tab], borrowed: [], current: tab, title: name }]),
    ),
    tabs: hung.map(({ tab }) => ({ id: tab, url: "https://example.test/" })),
  });
  // The hung sessions' tabs never answer, so every accepted job keeps waiting.
  f.chrome.tabs.get = () => new Promise(() => {});
  const { socket } = f.sockets[0];
  const deliver = (id, session, action, args = {}) =>
    socket.onmessage({
      data: JSON.stringify({
        type: "request",
        id,
        command: { session, action, args },
        deadline: Date.now() + 5000,
      }),
    });
  const responses = () => f.frames.filter((frame) => frame.type === "response");
  // Four sessions of 32 queued jobs take every ordinary slot.
  for (let i = 0; i < 128; i++) deliver(`hung-${i}`, `hung-${i % 4}`, "snapshot");
  deliver("ordinary", "idle", "snapshot");
  deliver("close", "idle", "close_session");
  deliver("dialog", "hung-0", "dialog", { accept: true });
  while (responses().length < 3) await setImmediate();
  assert.deepEqual(Object.fromEntries(responses().map((r) => [r.id, r.error?.code ?? r.result])), {
    ordinary: "busy",
    close: { success: true, closed: 0 },
    dialog: "unsupported",
  });
});

test("a Firefox reply after a large one waits for the socket to drain and keeps its order", async (t) => {
  const f = await transport(t);
  f.page.big = "x".repeat(6 << 20);
  // Both run in one session, so the second answers right after the first.
  f.deliver("large", { selector: "#big", property: "html" });
  f.deliver("next", { property: "title" });
  await settle(() => f.responses().length >= 1);
  // Several 10 ms polls of bufferedAmount pass.
  await settle(() => f.responses().length >= 2, 200);
  assert.deepEqual(
    f.responses().map((r) => r.id),
    ["large"],
    "the second reply waits while more than 4 MiB is buffered",
  );
  assert.deepEqual(f.socket.closes, []);
  // The daemon reads the large reply.
  f.socket.bufferedAmount = 0;
  await settle(() => f.responses().length >= 2);
  const [large, next] = f.responses();
  assert.equal(large.result.value.length, 6 << 20);
  assert.deepEqual([next.id, next.result], ["next", { value: "small" }]);
  assert.deepEqual(f.socket.closes, []);
});

test("a Firefox reply above 32 MiB becomes result_too_large and the connection stays", async (t) => {
  const f = await transport(t);
  // 11 Mi three-byte characters are 33 MiB of UTF-8 in 11 Mi string units.
  f.page.big = "会".repeat(11 << 20);
  f.deliver("huge", { selector: "#big", property: "html" });
  f.deliver("after", { property: "title" });
  await settle(() => f.responses().length >= 2);
  const [huge, after] = f.responses();
  assert.equal(huge.id, "huge");
  assert.equal(huge.error?.code, "result_too_large");
  assert.match(huge.error.message, /32 MiB/u);
  assert.equal(huge.result, undefined);
  assert.deepEqual([after.id, after.result], ["after", { value: "small" }]);
  assert.deepEqual(f.socket.closes, []);
});

test("a Firefox socket that does not drain for 30 seconds is closed for capacity", async (t) => {
  const f = await transport(t);
  f.page.big = "x".repeat(6 << 20);
  f.deliver("large", { selector: "#big", property: "html" });
  await settle(() => f.responses().length >= 1);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  f.deliver("next", { property: "title" });
  for (let i = 0; i < 20; i++) await setImmediate();
  t.mock.timers.tick(29000);
  assert.deepEqual(f.socket.closes, []);
  t.mock.timers.tick(2000);
  assert.deepEqual(f.socket.closes, [{ code: 4009, reason: "the daemon stopped reading" }]);
  assert.deepEqual(
    f.responses().map((r) => r.id),
    ["large"],
  );
});

test("an event above 32 MiB from the Firefox background becomes Inspector.detached", async (t) => {
  // The Firefox background forwards no CDP events itself; the test sends one
  // through the bridge that it started.
  const f = await start(
    t,
    {},
    {
      source:
        'export { emit } from "./extension/src/bridge.ts"; import "./extension/src/firefox/worker.ts";',
    },
  );
  const { socket } = f.sockets[0];
  f.module.emit({
    type: "event",
    tabId: 5,
    method: "Runtime.consoleAPICalled",
    params: { args: [{ value: "会".repeat(11 << 20) }] },
  });
  assert.deepEqual(
    f.frames.filter((frame) => frame.type === "event"),
    [
      {
        type: "event",
        tabId: 5,
        method: "Inspector.detached",
        params: { reason: "an event exceeded 32 MiB" },
      },
    ],
  );
  assert.deepEqual(socket.closes, []);
});

test("Firefox closes the daemon connection for an invalid frame with a valid close code", async (t) => {
  const f = await start(t);
  const { socket } = f.sockets[0];
  socket.onmessage({ data: "not json" });
  assert.deepEqual(socket.closes, [{ code: 4008, reason: "invalid frame" }]);
});

test("Firefox closes the daemon connection when the hello fails with a valid close code", async (t) => {
  const failing = await start(
    t,
    {},
    {
      prepare: (api) => {
        api.chrome.runtime.getBrowserInfo = async () => {
          throw new Error("browser information unavailable");
        };
      },
      wait: false,
    },
  );
  await settle(() => failing.sockets[0]?.socket.closes.length > 0);
  assert.deepEqual(failing.sockets[0].socket.closes, [
    { code: 4011, reason: "session state unavailable" },
  ]);
});
