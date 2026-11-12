import {
  expired,
  fail,
  fault,
  type Budget,
  type Command,
  type Fault,
  type Hello,
  type Request,
} from "./protocol.js";
import { pageClient } from "./state.js";
import {
  daemonRunning,
  validToken,
  type Connection,
  type ConnectionState,
  type Settings,
} from "./status.js";

export type Bridge = {
  hello: () => Promise<Hello>;
  execute: (command: Command, budget: Budget) => Promise<object>;
  // Runs with every 20-second ping. Firefox suspends an event page after 30
  // idle seconds and counts extension API calls, not WebSocket traffic.
  heartbeat?: () => Promise<void>;
  // Runs when a daemon connection closes, after its jobs are aborted. Chrome
  // releases the tabs of the page CDP clients that the connection served.
  disconnected?: () => Promise<void>;
};
let socket: WebSocket | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let attempt = 0;
let lastTraffic = 0;
let connecting = false;
let settingsRevision = 0;
let bridge: Bridge | undefined;
const jobs = new Map<string, { abort: AbortController; session: string; action: string }>();
const queues = new Map<string, { tail: Promise<void>; count: number }>();

// WebSocket.close accepts only 1000 and 3000–4999. These codes stand for 1008
// (policy violation), 1009 (message too big) and 1011 (internal error).
const closeProtocol = 4008;
const closeCapacity = 4009;
const closeInternal = 4011;
// The daemon reads messages of up to 32 MiB (MaxMessage in
// internal/bridge/protocol.go).
const maxMessage = 32 << 20;
// Frames wait while the socket holds more than 4 MiB that the daemon has not
// read yet, up to 64 MiB of waiting frames. A socket that sends nothing for 30
// seconds while it waits is closed: the daemon stopped reading.
const bufferLimit = 4 << 20;
const backlogLimit = 64 << 20;
const drainPoll = 10;
const drainTimeout = 30000;
const backlogs = new Map<WebSocket, { frames: { wire: string; size: number }[]; bytes: number }>();

// UTF-8 size of a JSON.stringify result, which has no lone surrogates.
function utf8Size(text: string): number {
  let size = text.length;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit < 0xe000) size += 1;
    else if (unit >= 0x800) size += 2;
    else if (unit >= 0x80) size += 1;
  }
  return size;
}
// Sends one frame after the frames already waiting for this connection.
function transmit(connection: WebSocket, wire: string, size: number): void {
  if (connection.readyState !== WebSocket.OPEN) return;
  const backlog = backlogs.get(connection);
  if (!backlog && connection.bufferedAmount <= bufferLimit) {
    connection.send(wire);
    return;
  }
  if (!backlog) {
    backlogs.set(connection, { frames: [{ wire, size }], bytes: size });
    drain(connection, Date.now());
    return;
  }
  backlog.frames.push({ wire, size });
  backlog.bytes += size;
  if (backlog.bytes > backlogLimit) {
    backlogs.delete(connection);
    connection.close(closeCapacity, "transport capacity exceeded");
  }
}
// WebSocket has no drain event, so the waiting frames poll bufferedAmount.
function drain(connection: WebSocket, since: number): void {
  setTimeout(() => {
    const backlog = backlogs.get(connection);
    if (!backlog) return;
    if (connection.readyState !== WebSocket.OPEN) {
      backlogs.delete(connection);
      return;
    }
    let sent = since;
    while (backlog.frames.length && connection.bufferedAmount <= bufferLimit) {
      const frame = backlog.frames.shift()!;
      backlog.bytes -= frame.size;
      connection.send(frame.wire);
      sent = Date.now();
    }
    if (!backlog.frames.length) backlogs.delete(connection);
    else if (Date.now() - sent >= drainTimeout) {
      backlogs.delete(connection);
      connection.close(closeCapacity, "the daemon stopped reading");
    } else drain(connection, sent);
  }, drainPoll);
}
// Sends hello, ping and event frames on the daemon connection; frames are
// dropped while disconnected. An event above the daemon's message limit
// becomes the tab's Inspector.detached: the daemon closes that tab's page CDP
// clients, so the event is not dropped without notice and other sessions keep
// the connection. Any other frame above the limit closes the connection.
export function emit(value: object, connection = socket): void {
  if (connection?.readyState !== WebSocket.OPEN) return;
  let wire = JSON.stringify(value);
  let size = utf8Size(wire);
  if (size > maxMessage) {
    const { type, tabId } = value as { type?: string; tabId?: number };
    if (type !== "event" || tabId === undefined) {
      connection.close(closeCapacity, "message exceeds 32 MiB");
      return;
    }
    wire = JSON.stringify({
      type: "event",
      tabId,
      method: "Inspector.detached",
      params: { reason: "an event exceeded 32 MiB" },
    });
    size = utf8Size(wire);
  }
  transmit(connection, wire, size);
}
// Answers request id. A response above the daemon's message limit is replaced
// by a result_too_large error, so the command still gets its answer.
function respond(
  connection: WebSocket,
  id: string,
  answer: { result: object } | { error: Fault },
): void {
  if (connection.readyState !== WebSocket.OPEN) return;
  let wire = JSON.stringify({ type: "response", id, ...answer });
  let size = utf8Size(wire);
  if (size > maxMessage) {
    wire = JSON.stringify({
      type: "response",
      id,
      error: {
        code: "result_too_large",
        message: `the response is ${size} bytes; a message to the daemon carries at most 32 MiB (${maxMessage} bytes)`,
      },
    });
    size = utf8Size(wire);
  }
  transmit(connection, wire, size);
}
function publish(state: ConnectionState): void {
  const connection: Connection = { state, since: Date.now() };
  void chrome.storage.session
    .set({ connection })
    .catch((cause: Error) => console.error("save connection state", cause.message));
}
// A closed connection is offline when nothing answers on the daemon address.
// A daemon that answers refused the handshake, unless the connection had
// worked: then the daemon restarted and the next attempt reconnects.
async function closed(opened: boolean): Promise<void> {
  const running = await daemonRunning();
  publish(running ? (opened ? "connecting" : "rejected") : "offline");
}
function enqueue(request: Request, connection: WebSocket, execute: Bridge["execute"]): void {
  const name = request.command.session;
  // CDP is multiplexed: Fetch continuations and debugger commands must run
  // while another protocol command awaits a response on the same target.
  // Control commands run outside the session queue and may use 16 slots beyond
  // the 128 ordinary ones, as in the daemon (internal/bridge/hub.go):
  // close_session and dialog recover a session, and the daemon's cdp_detach and
  // artifact_close release a closed page CDP client's tab and a finished stream.
  // Firefox answers dialog, cdp_detach and artifact_close with unsupported.
  const control = ["dialog", "close_session", "cdp_detach", "artifact_close"].includes(
    request.command.action,
  );
  const queueName =
    request.command.action === "close_session"
      ? `close:${name}`
      : control || (request.command.action === "cdp" && pageClient(name))
        ? request.id
        : name;
  const queue = queues.get(queueName) ?? { tail: Promise.resolve(), count: 0 };
  if (jobs.size >= (control ? 144 : 128) || queue.count >= 32 || jobs.has(request.id)) {
    respond(connection, request.id, {
      error: { code: "busy", message: "extension queue capacity reached" },
    });
    return;
  }
  if (request.command.action === "close_session") {
    for (const job of jobs.values())
      if (job.session === name && job.action !== "close_session") job.abort.abort();
  }
  const abort = new AbortController();
  jobs.set(request.id, { abort, session: name, action: request.command.action });
  queue.count++;
  queues.set(queueName, queue);
  const timer = setTimeout(() => abort.abort(), Math.max(0, request.deadline - Date.now()));
  const check = (): void => {
    if (abort.signal.aborted || Date.now() >= request.deadline) expired();
  };
  const previous = queue.tail;
  queue.tail = (async () => {
    await previous;
    try {
      check();
      const result = await execute(request.command, {
        signal: abort.signal,
        check,
        deadline: request.deadline,
      });
      respond(connection, request.id, { result });
    } catch (error) {
      respond(connection, request.id, { error: fault(error as Error) });
    } finally {
      clearTimeout(timer);
      jobs.delete(request.id);
      queue.count--;
      if (!queue.count) queues.delete(queueName);
    }
  })();
}
// Sends hello on a new connection. Without the session state that hello
// reports, the connection closes and the next attempt starts over.
async function greet(connection: WebSocket, hello: Bridge["hello"]): Promise<void> {
  try {
    emit(await hello(), connection);
  } catch (error) {
    console.error("prepare hello", fault(error as Error).message);
    connection.close(closeInternal, "session state unavailable");
  }
}
function schedule(): void {
  clearTimeout(retry);
  const ms = Math.min(30000, 500 * 2 ** Math.min(attempt++, 6)) * (0.8 + Math.random() * 0.4);
  retry = setTimeout(() => {
    void connect();
  }, ms);
}
async function connect(): Promise<void> {
  if (!bridge) fail("internal", "bridge is not started");
  const { hello, execute, heartbeat: keepAlive, disconnected } = bridge;
  if (connecting || (socket && socket.readyState !== WebSocket.CLOSED)) return;
  const revision = settingsRevision;
  connecting = true;
  try {
    const settings: Settings = await chrome.storage.local.get(["token", "paused"]);
    if (revision !== settingsRevision) return;
    if (settings.paused || !validToken(settings.token)) {
      publish(settings.paused ? "paused" : "unpaired");
      return;
    }
    let opened = false;
    const connection = new WebSocket("ws://127.0.0.1:17373/extension", [
      "omw.v1",
      `omw-token.${settings.token}`,
    ]);
    socket = connection;
    // Retries keep the last classified state, so the icon does not flicker.
    if (attempt === 0) publish("connecting");
    const opening = setTimeout(() => connection.close(), 5000);
    connection.onopen = (): void => {
      clearTimeout(opening);
      lastTraffic = Date.now();
      void greet(connection, hello);
    };
    connection.onmessage = (event: MessageEvent<string>): void => {
      lastTraffic = Date.now();
      try {
        const message = JSON.parse(event.data) as
          | Request
          | { type: "hello" | "cancel" | "pong"; protocol?: number; id?: string };
        if (message.type === "hello") {
          if (message.protocol !== 1) {
            connection.close(closeProtocol, "protocol mismatch");
            return;
          }
          attempt = 0;
          opened = true;
          publish("connected");
          clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (Date.now() - lastTraffic > 45000) {
              connection.close();
              return;
            }
            emit({ type: "ping" }, connection);
            void keepAlive?.().catch((error: Error) =>
              console.error("background keepalive", error.message),
            );
          }, 20000);
        } else if (message.type === "cancel") {
          if (message.id) jobs.get(message.id)?.abort.abort();
        } else if (message.type === "request") {
          if (
            typeof message.id !== "string" ||
            !message.command ||
            typeof message.command.session !== "string" ||
            typeof message.command.action !== "string" ||
            !Number.isFinite(message.deadline)
          )
            fail("invalid_request", "malformed request envelope");
          enqueue(message, connection, execute);
        }
      } catch (error) {
        console.error("invalid daemon frame", fault(error as Error).message);
        connection.close(closeProtocol, "invalid frame");
      }
    };
    connection.onclose = (): void => {
      clearTimeout(opening);
      clearInterval(heartbeat);
      backlogs.delete(connection);
      for (const job of jobs.values()) job.abort.abort();
      void disconnected?.().catch((error: Error) =>
        console.error("release connection state", error.message),
      );
      if (socket === connection) {
        socket = undefined;
        void closed(opened).catch((error: Error) =>
          console.error("classify closed connection", error.message),
        );
        schedule();
      }
    };
  } catch (error) {
    console.error("connect", fault(error as Error).message);
    publish("offline");
    schedule();
  } finally {
    connecting = false;
    if (revision !== settingsRevision) void connect();
  }
}

// Registers the reconnect listeners and opens the daemon connection. Call it
// once from the background entry point, synchronously at top level, so the
// listeners exist before the browser delivers the event that woke it.
export function startBridge(options: Bridge): void {
  if (bridge) fail("internal", "bridge is already started");
  bridge = options;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes.token && !changes.paused)) return;
    settingsRevision++;
    clearTimeout(retry);
    if (socket) socket.close(1000, "settings changed");
    void connect();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "reconnect") void connect();
  });
  chrome.runtime.onStartup.addListener(() => {
    void connect();
  });
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
    void connect();
  });
  void chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
  void connect();
}
