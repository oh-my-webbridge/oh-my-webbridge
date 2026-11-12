import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

// Starts the worker against a daemon connection whose close() follows the
// WebSocket standard: only 1000 and 3000–4999 are accepted. bufferedAmount
// grows by the UTF-8 size of each frame until the test drains it. tabs.query
// answers list_targets with one tab whose title the test sets.
async function transport(t, name) {
  const token = "a".repeat(64);
  const noopEvent = () => ({ addListener() {} });
  const page = { title: "" };
  let socket, changed;
  let paused = false;
  const originalChrome = globalThis.chrome;
  const originalSocket = globalThis.WebSocket;
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ token, paused }) },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: {
        addListener(listener) {
          changed = listener;
        },
      },
    },
    action: { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} },
    i18n: { getUILanguage: () => "en" },
    debugger: {
      onEvent: {
        addListener(listener) {
          page.event = listener;
        },
      },
      onDetach: noopEvent(),
      getTargets: async () => [],
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
    },
    tabs: {
      get: async (id) => ({ id, url: "https://example.test/", status: "complete" }),
      query: async () => [{ id: 5, url: "https://example.test/", title: page.title }],
      onRemoved: noopEvent(),
      onUpdated: noopEvent(),
    },
    tabGroups: { onRemoved: noopEvent() },
    alarms: { onAlarm: noopEvent(), create: async () => {} },
    runtime: { onStartup: noopEvent(), onInstalled: noopEvent() },
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    closes = [];
    constructor() {
      socket = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(wire) {
      const message = JSON.parse(wire);
      this.sent.push(message);
      this.bufferedAmount += Buffer.byteLength(wire);
      if (message.type === "hello")
        queueMicrotask(() =>
          this.onmessage?.({ data: JSON.stringify({ type: "hello", protocol: 1 }) }),
        );
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
  t.after(async () => {
    paused = true;
    socket?.close();
    changed?.({ paused: { newValue: true } }, "local");
    // The activity layer settles 600 ms after the last action on a tab.
    await delay(650);
    globalThis.chrome = originalChrome;
    globalThis.WebSocket = originalSocket;
  });
  const result = await build({
    entryPoints: ["extension/src/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${name}`
  );
  while (!socket?.sent.some((m) => m.type === "hello")) await setImmediate();
  await setImmediate();
  const connection = socket;
  connection.bufferedAmount = 0;
  return {
    socket: connection,
    page,
    deliver: (id, session, action, args = {}) =>
      connection.onmessage({
        data: JSON.stringify({
          type: "request",
          id,
          command: { session, action, args },
          deadline: Date.now() + 60000,
        }),
      }),
    responses: () => connection.sent.filter((m) => m.type === "response"),
  };
}
// Waits for the worker's timers and promises, up to about ms milliseconds.
async function settle(done, ms = 2000) {
  for (let i = 0; i < ms / 5 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
}

test("close_session names itself as the cause of the commands it cancels", async (t) => {
  const f = await transport(t, "close-cancel");
  const entered = Promise.withResolvers(),
    listed = Promise.withResolvers();
  const query = globalThis.chrome.tabs.query;
  globalThis.chrome.tabs.query = async (filter) => {
    entered.resolve();
    await listed.promise;
    return query(filter);
  };
  // The first listing runs and waits for the tab list; the second waits behind it.
  f.deliver("running", "task", "list_targets");
  await entered.promise;
  f.deliver("queued", "task", "list_targets");
  f.deliver("close", "task", "close_session");
  await settle(() => f.responses().some((m) => m.id === "close"));
  listed.resolve();
  await settle(() => f.responses().length >= 3);
  const reply = (id) => f.responses().find((m) => m.id === id);
  assert.ok(Array.isArray(reply("running").result));
  assert.deepEqual(reply("queued").error, {
    code: "outcome_unknown",
    message: "the session was closed before the command started; observe before retrying",
  });
});

test("a reply after a large one waits for the socket to drain and keeps its order", async (t) => {
  const f = await transport(t, "drain");
  f.page.title = "x".repeat(6 << 20);
  // Both run in one session, so the second answers right after the first.
  f.deliver("large", "task", "list_targets");
  f.deliver("next", "task", "batch", { steps: [] });
  await settle(() => f.responses().length >= 1);
  // Several 10 ms polls of bufferedAmount pass.
  await settle(() => f.responses().length >= 2, 200);
  assert.deepEqual(
    f.responses().map((m) => m.id),
    ["large"],
    "the second reply waits while more than 4 MiB is buffered",
  );
  assert.deepEqual(f.socket.closes, []);
  // The daemon reads the large reply.
  f.socket.bufferedAmount = 0;
  await settle(() => f.responses().length >= 2);
  assert.deepEqual(
    f.responses().map((m) => [m.id, m.error?.code ?? "result"]),
    [
      ["large", "result"],
      ["next", "invalid_args"],
    ],
  );
  assert.equal(f.responses()[0].result[0].title.length, 6 << 20);
  assert.deepEqual(f.socket.closes, []);
});

test("a reply above 32 MiB becomes result_too_large and the connection stays", async (t) => {
  const f = await transport(t, "too-large");
  // 11 Mi three-byte characters are 33 MiB of UTF-8 in 11 Mi string units.
  f.page.title = "会".repeat(11 << 20);
  f.deliver("huge", "task", "list_targets");
  await settle(() => f.responses().length >= 1);
  f.page.title = "small";
  f.deliver("after", "task", "list_targets");
  await settle(() => f.responses().length >= 2);
  const [huge, after] = f.responses();
  assert.equal(huge.id, "huge");
  assert.equal(huge.error?.code, "result_too_large");
  assert.match(huge.error.message, /32 MiB/u);
  assert.equal(huge.result, undefined);
  assert.deepEqual(after.result, [{ tabId: 5, url: "https://example.test/", title: "small" }]);
  assert.deepEqual(f.socket.closes, []);
});

test("an event above 32 MiB detaches its page CDP client and the connection stays", async (t) => {
  const f = await transport(t, "event-too-large");
  f.deliver("attach", `cdp-${"1".repeat(32)}`, "cdp_attach", { tabId: 5 });
  await settle(() => f.responses().length >= 1);
  assert.deepEqual(f.responses()[0].result, { attached: true });
  f.page.event({ tabId: 5 }, "Runtime.consoleAPICalled", {
    args: [{ value: "会".repeat(11 << 20) }],
  });
  const events = () => f.socket.sent.filter((m) => m.type === "event");
  await settle(() => events().length >= 1);
  assert.deepEqual(events(), [
    {
      type: "event",
      tabId: 5,
      method: "Inspector.detached",
      params: { reason: "an event exceeded 32 MiB" },
    },
  ]);
  assert.deepEqual(f.socket.closes, []);
});

test("protocol errors close the daemon connection with a valid close code", async (t) => {
  const f = await transport(t, "protocol-close");
  f.socket.onmessage({ data: "not json" });
  assert.deepEqual(f.socket.closes, [{ code: 4008, reason: "invalid frame" }]);
});

test("a socket that does not drain for 30 seconds is closed for capacity", async (t) => {
  const f = await transport(t, "stalled");
  f.page.title = "x".repeat(6 << 20);
  f.deliver("large", "task", "list_targets");
  await settle(() => f.responses().length >= 1);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  t.after(() => mock.timers.reset());
  f.deliver("next", "task", "batch", { steps: [] });
  for (let i = 0; i < 20; i++) await setImmediate();
  mock.timers.tick(29000);
  assert.deepEqual(f.socket.closes, []);
  mock.timers.tick(2000);
  assert.deepEqual(f.socket.closes, [{ code: 4009, reason: "the daemon stopped reading" }]);
  assert.deepEqual(
    f.responses().map((m) => m.id),
    ["large"],
  );
});

test("token changes during an in-flight settings read reconnect immediately", async (t) => {
  let changed, resolveFirst, started;
  let first = true;
  let paused = false;
  const token = "a".repeat(64);
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const connections = [];
  const noopEvent = () => ({ addListener() {} });
  const originalChrome = globalThis.chrome;
  const originalSocket = globalThis.WebSocket;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          // Only the bridge's settings read stalls; other reads answer at once.
          if (!keys.includes("token")) return {};
          if (first) {
            first = false;
            started();
            return new Promise((resolve) => {
              resolveFirst = resolve;
            });
          }
          return { token, paused };
        },
      },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: {
        addListener(listener) {
          changed = listener;
        },
      },
    },
    action: { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} },
    i18n: { getUILanguage: () => "en" },
    debugger: { onEvent: noopEvent(), onDetach: noopEvent() },
    tabs: { onRemoved: noopEvent(), onUpdated: noopEvent() },
    tabGroups: { onRemoved: noopEvent() },
    alarms: { onAlarm: noopEvent(), create: async () => {} },
    runtime: { onStartup: noopEvent(), onInstalled: noopEvent() },
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    constructor(url, protocols) {
      connections.push({ socket: this, url, protocols });
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(wire) {
      if (JSON.parse(wire).type === "hello")
        queueMicrotask(() =>
          this.onmessage?.({ data: JSON.stringify({ type: "hello", protocol: 1 }) }),
        );
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.();
    }
  };
  t.after(async () => {
    paused = true;
    for (const connection of connections) connection.socket.close();
    changed?.({ paused: { newValue: true } }, "local");
    await setImmediate();
    globalThis.chrome = originalChrome;
    globalThis.WebSocket = originalSocket;
  });
  const result = await build({
    entryPoints: ["extension/src/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
  await began;
  changed({ token: { newValue: token } }, "local");
  resolveFirst({});
  await setImmediate();
  assert.equal(connections.length, 1, "settings change must not wait for the 30-second alarm");
  assert.equal(connections[0].url, "ws://127.0.0.1:17373/extension");
  assert.deepEqual(connections[0].protocols, ["omw.v1", `omw-token.${token}`]);
});

test("Chrome hello reports the browser, its version and the persisted sessions", async (t) => {
  const token = "b".repeat(64);
  let changed;
  const hellos = [];
  const sockets = [];
  const noopEvent = () => ({ addListener() {} });
  const original = {
    chrome: globalThis.chrome,
    socket: globalThis.WebSocket,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  };
  let paused = false;
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ token, paused }) },
      session: {
        get: async () => ({
          sessions: {
            task: { tabs: [], borrowed: [], title: "task" },
            研究: { tabs: [], borrowed: [], title: "研究" },
          },
        }),
        set: async () => {},
      },
      onChanged: {
        addListener(listener) {
          changed = listener;
        },
      },
    },
    action: { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} },
    i18n: { getUILanguage: () => "en" },
    debugger: { onEvent: noopEvent(), onDetach: noopEvent() },
    tabs: { onRemoved: noopEvent(), onUpdated: noopEvent() },
    tabGroups: { onRemoved: noopEvent() },
    alarms: { onAlarm: noopEvent(), create: async () => {} },
    runtime: { onStartup: noopEvent(), onInstalled: noopEvent() },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgentData: {
        getHighEntropyValues: async (hints) => {
          assert.deepEqual(hints, ["fullVersionList"]);
          return {
            fullVersionList: [
              { brand: "Not)A;Brand", version: "24.0.0.0" },
              { brand: "Chromium", version: "156.0.8078.80" },
              { brand: "Google Chrome", version: "156.0.8078.80" },
            ],
          };
        },
      },
    },
  });
  const sent = Promise.withResolvers();
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(wire) {
      const packet = JSON.parse(wire);
      if (packet.type === "hello") {
        hellos.push(packet);
        sent.resolve();
      }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.();
    }
  };
  t.after(async () => {
    paused = true;
    for (const socket of sockets) socket.close();
    changed?.({ paused: { newValue: true } }, "local");
    await setImmediate();
    globalThis.chrome = original.chrome;
    globalThis.WebSocket = original.socket;
    Object.defineProperty(globalThis, "navigator", original.navigator);
  });
  const result = await build({
    entryPoints: ["extension/src/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#hello`
  );
  await sent.promise;
  assert.deepEqual(hellos, [
    {
      type: "hello",
      protocol: 1,
      browser: "chrome",
      browserVersion: "156.0.8078.80",
      sessions: ["task", "研究"],
    },
  ]);
});

test("worker startup releases debugger sessions inherited by persisted tabs", async (t) => {
  const noopEvent = () => ({ addListener() {} });
  const originalChrome = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = originalChrome;
  });
  const detached = [];
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ paused: true }) },
      session: {
        get: async () => ({
          sessions: { task: { tabs: [5], borrowed: [6], title: "task" } },
        }),
        set: async () => {},
      },
      onChanged: noopEvent(),
    },
    action: { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} },
    i18n: { getUILanguage: () => "en" },
    debugger: {
      onEvent: noopEvent(),
      onDetach: noopEvent(),
      getTargets: async () => [
        { type: "page", tabId: 5, attached: true },
        { type: "page", tabId: 6, attached: false },
        { type: "page", tabId: 8, attached: true },
      ],
      detach: async ({ tabId }) => {
        detached.push(tabId);
      },
    },
    tabs: { onRemoved: noopEvent(), onUpdated: noopEvent() },
    tabGroups: { onRemoved: noopEvent() },
    alarms: { onAlarm: noopEvent(), create: async () => {} },
    runtime: { onStartup: noopEvent(), onInstalled: noopEvent() },
  };
  const result = await build({
    entryPoints: ["extension/src/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#restart`
  );
  // No daemon request arrives: startup alone ends the inherited interception.
  // Every fake resolves immediately, so one macrotask turn settles startup.
  await setImmediate();
  assert.deepEqual(detached, [5]);
});

test("cleanup commands use the recovery reserve while 128 jobs wait", async (t) => {
  const token = "a".repeat(64);
  const noopEvent = () => ({ addListener() {} });
  const sent = [];
  let socket, changed;
  let paused = false;
  const originalChrome = globalThis.chrome;
  const originalSocket = globalThis.WebSocket;
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ token, paused }) },
      session: {
        get: async () => ({
          sessions: Object.fromEntries(
            [0, 1, 2, 3].map((i) => [
              `hung-${i}`,
              { tabs: [10 + i], borrowed: [], current: 10 + i, title: `hung-${i}` },
            ]),
          ),
        }),
        set: async () => {},
      },
      onChanged: {
        addListener(listener) {
          changed = listener;
        },
      },
    },
    action: { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} },
    i18n: { getUILanguage: () => "en" },
    debugger: { onEvent: noopEvent(), onDetach: noopEvent(), getTargets: async () => [] },
    // The hung sessions' tabs never answer, so every accepted job keeps waiting.
    tabs: { get: () => new Promise(() => {}), onRemoved: noopEvent(), onUpdated: noopEvent() },
    tabGroups: { onRemoved: noopEvent() },
    alarms: { onAlarm: noopEvent(), create: async () => {} },
    runtime: { onStartup: noopEvent(), onInstalled: noopEvent() },
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    constructor() {
      socket = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(wire) {
      const message = JSON.parse(wire);
      sent.push(message);
      if (message.type === "hello")
        queueMicrotask(() =>
          this.onmessage?.({ data: JSON.stringify({ type: "hello", protocol: 1 }) }),
        );
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.();
    }
  };
  t.after(async () => {
    paused = true;
    socket?.close();
    changed?.({ paused: { newValue: true } }, "local");
    // The activity layer settles 600 ms after the last action on a tab.
    await delay(650);
    globalThis.chrome = originalChrome;
    globalThis.WebSocket = originalSocket;
  });
  const result = await build({
    entryPoints: ["extension/src/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#cleanup-reserve`
  );
  while (!sent.some((m) => m.type === "hello")) await setImmediate();
  await setImmediate();
  const deliver = (id, session, action, args = {}) =>
    socket.onmessage({
      data: JSON.stringify({
        type: "request",
        id,
        command: { session, action, args },
        deadline: Date.now() + 1000,
      }),
    });
  const busy = () =>
    sent.filter((m) => m.type === "response" && m.error?.code === "busy").map((m) => m.id);
  // Four sessions of 32 queued jobs take every ordinary slot.
  for (let i = 0; i < 128; i++) deliver(`hung-${i}`, `hung-${i % 4}`, "snapshot");
  deliver("ordinary", "idle", "snapshot");
  assert.deepEqual(busy(), ["ordinary"]);
  // The daemon releases a disconnected page CDP client and closes PDF streams.
  deliver("detach", `cdp-${"b".repeat(32)}`, "cdp_detach", { tabId: 7 });
  deliver("stream", "hung-0", "artifact_close", { handle: "pdf-1" });
  deliver("close", "idle", "close_session");
  assert.deepEqual(busy(), ["ordinary"]);
});

test("a closed daemon connection releases its page CDP clients' tabs", async (t) => {
  const token = "a".repeat(64);
  const listeners = {};
  const event = (name) => ({
    addListener: (fn) => {
      listeners[name] = fn;
    },
  });
  const calls = [];
  let stored = {};
  let paused = false;
  const tab = { id: 5, url: "https://example.test/", status: "complete" };
  const originalChrome = globalThis.chrome;
  const originalSocket = globalThis.WebSocket;
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ token, paused }) },
      session: {
        get: async () => structuredClone(stored),
        set: async (value) => {
          stored = { ...stored, ...structuredClone(value) };
        },
      },
      onChanged: event("storage"),
    },
    action: { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} },
    i18n: { getUILanguage: () => "en" },
    debugger: {
      onEvent: event("debuggerEvent"),
      onDetach: event("debuggerDetach"),
      getTargets: async () => [],
      attach: async ({ tabId }) => calls.push({ method: "attach", tabId }),
      detach: async ({ tabId }) => calls.push({ method: "detach", tabId }),
      sendCommand: async () => ({}),
    },
    tabs: {
      get: async (id) => ({ ...tab, id }),
      query: async () => [tab],
      onRemoved: event("tabRemoved"),
      onUpdated: event("tabUpdated"),
    },
    tabGroups: { onRemoved: event("groupRemoved") },
    alarms: { onAlarm: event("alarm"), create: async () => {} },
    runtime: { onStartup: event("startup"), onInstalled: event("installed") },
  };
  const sockets = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    responses = new Map();
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(wire) {
      const message = JSON.parse(wire);
      if (message.type === "hello")
        queueMicrotask(() =>
          this.onmessage?.({ data: JSON.stringify({ type: "hello", protocol: 1 }) }),
        );
      if (message.type === "response") this.responses.set(message.id, message);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.();
    }
  };
  t.after(async () => {
    paused = true;
    for (const socket of sockets) socket.close();
    listeners.storage?.({ paused: { newValue: true } }, "local");
    await setImmediate();
    globalThis.chrome = originalChrome;
    globalThis.WebSocket = originalSocket;
  });
  const result = await build({
    entryPoints: ["extension/src/worker.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#page-clients`
  );
  const ready = async (socket) => {
    while (!socket?.onmessage || socket.readyState !== 1) await setImmediate();
  };
  const call = async (socket, id, session, action, args) => {
    socket.onmessage({
      data: JSON.stringify({
        type: "request",
        id,
        command: { session, action, args },
        deadline: Date.now() + 5000,
      }),
    });
    while (!socket.responses.has(id)) await setImmediate();
    return socket.responses.get(id);
  };
  await ready(sockets[0]);
  // A page CDP client of the first daemon borrows the user's tab.
  const first = await call(sockets[0], "attach-1", `cdp-${"1".repeat(32)}`, "cdp_attach", {
    tabId: 5,
  });
  assert.deepEqual(first.result, { attached: true });
  // The daemon stops before the client disconnects, so no cdp_detach arrives.
  sockets[0].close();
  for (let i = 0; i < 100 && Object.keys(stored.sessions ?? {}).length; i++) await setImmediate();
  assert.deepEqual(Object.keys(stored.sessions ?? {}), [], "no session keeps the user's tab");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["attach", "detach"],
  );
  listeners.alarm({ name: "reconnect" });
  while (sockets.length < 2) await setImmediate();
  await ready(sockets[1]);
  const second = await call(sockets[1], "attach-2", `cdp-${"2".repeat(32)}`, "cdp_attach", {
    tabId: 5,
  });
  assert.deepEqual(second.result, { attached: true }, "the next daemon's client attaches");
});
