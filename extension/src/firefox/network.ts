import { fail } from "../protocol.js";

type Entry = {
  requestId: string;
  url?: string;
  method?: string;
  status?: number;
  mimeType?: string;
  error?: string;
  complete?: boolean;
};
type Body = { chunks: Uint8Array[]; bytes: number; done: boolean; tooLarge: boolean };
type Listeners = {
  request: (
    details: chrome.webRequest.OnBeforeRequestDetails,
  ) => chrome.webRequest.BlockingResponse | undefined;
  headers: (
    details: chrome.webRequest.OnHeadersReceivedDetails,
  ) => chrome.webRequest.BlockingResponse | undefined;
  completed: (details: chrome.webRequest.OnCompletedDetails) => void;
  failed: (details: chrome.webRequest.OnErrorOccurredDetails) => void;
};
type Recording = {
  entries: Map<string, Entry>;
  bodies: Map<string, Body>;
  bodyBytes: number;
  listeners: Listeners;
};
const recordings = new Map<number, Recording>();
const ENTRY_LIMIT = 500;
const BODY_LIMIT = 1 << 20;
const TOTAL_BODY_LIMIT = 8 << 20;

function header(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string,
): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value;
}
function dropBody(r: Recording, requestId: string): void {
  const body = r.bodies.get(requestId);
  if (!body) return;
  r.bodyBytes -= body.bytes;
  r.bodies.delete(requestId);
}
function entry(r: Recording, requestId: string): Entry {
  let found = r.entries.get(requestId);
  if (!found) {
    found = { requestId };
    r.entries.set(requestId, found);
    if (r.entries.size > ENTRY_LIMIT) {
      const oldest = r.entries.keys().next().value;
      if (oldest !== undefined) {
        r.entries.delete(oldest);
        dropBody(r, oldest);
      }
    }
  }
  return found;
}
// Keeps a copy of the response body while passing every chunk on unchanged.
// Bodies over 1 MiB are not kept, and the oldest kept bodies give way once a
// tab holds 8 MiB.
function capture(tabId: number, r: Recording, requestId: string): void {
  const filter = chrome.webRequest.filterResponseData(requestId);
  const body: Body = { chunks: [], bytes: 0, done: false, tooLarge: false };
  dropBody(r, requestId);
  r.bodies.set(requestId, body);
  filter.ondata = (event) => {
    filter.write(event.data);
    if (recordings.get(tabId) !== r || r.bodies.get(requestId) !== body) {
      filter.disconnect();
      return;
    }
    const chunk = new Uint8Array(event.data);
    if (body.bytes + chunk.length > BODY_LIMIT) {
      body.tooLarge = true;
      r.bodyBytes -= body.bytes;
      body.bytes = 0;
      body.chunks = [];
      filter.disconnect();
      return;
    }
    body.chunks.push(chunk);
    body.bytes += chunk.length;
    r.bodyBytes += chunk.length;
    for (const id of r.bodies.keys()) {
      if (r.bodyBytes <= TOTAL_BODY_LIMIT) break;
      if (id !== requestId) dropBody(r, id);
    }
  };
  filter.onstop = () => {
    body.done = true;
    filter.close();
  };
  filter.onerror = () => {
    dropBody(r, requestId);
  };
}
function decode(
  bytes: Uint8Array,
  mimeType: string | undefined,
): { body: string; base64Encoded: boolean } {
  if (/^(?:text\/|application\/(?:[\w.+-]*\+)?(?:json|xml|javascript))/iu.test(mimeType ?? ""))
    try {
      return {
        body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        base64Encoded: false,
      };
    } catch {
      // Not UTF-8 text: return the bytes as base64 below.
    }
  return { body: bytes.toBase64(), base64Encoded: true };
}
function start(tabId: number): Recording {
  const r: Recording = {
    entries: new Map(),
    bodies: new Map(),
    bodyBytes: 0,
    listeners: {
      request: (details) => {
        const found = entry(r, details.requestId);
        found.url = details.url.slice(0, 8192);
        found.method = details.method;
        found.complete = false;
        delete found.status;
        delete found.mimeType;
        if (details.type !== "websocket") capture(tabId, r, details.requestId);
        return undefined;
      },
      headers: (details) => {
        const found = entry(r, details.requestId);
        found.status = details.statusCode;
        const type = header(details.responseHeaders, "content-type");
        if (type) found.mimeType = type.split(";")[0]!.trim();
        return undefined;
      },
      completed: (details) => {
        const found = entry(r, details.requestId);
        found.status ??= details.statusCode;
        found.complete = true;
      },
      failed: (details) => {
        const found = entry(r, details.requestId);
        found.error = details.error;
        found.complete = true;
      },
    },
  };
  const filter = { urls: ["<all_urls>"], tabId };
  // filterResponseData has to be attached before the response starts.
  chrome.webRequest.onBeforeRequest.addListener(r.listeners.request, filter, ["blocking"]);
  chrome.webRequest.onHeadersReceived.addListener(r.listeners.headers, filter, ["responseHeaders"]);
  chrome.webRequest.onCompleted.addListener(r.listeners.completed, filter);
  chrome.webRequest.onErrorOccurred.addListener(r.listeners.failed, filter);
  return r;
}
export function forgetNetwork(tabId: number): void {
  const r = recordings.get(tabId);
  if (!r) return;
  chrome.webRequest.onBeforeRequest.removeListener(r.listeners.request);
  chrome.webRequest.onHeadersReceived.removeListener(r.listeners.headers);
  chrome.webRequest.onCompleted.removeListener(r.listeners.completed);
  chrome.webRequest.onErrorOccurred.removeListener(r.listeners.failed);
  recordings.delete(tabId);
}
export function network(tabId: number, cmd = "list", filter?: string, requestId?: string): object {
  if (cmd === "start") {
    forgetNetwork(tabId);
    recordings.set(tabId, start(tabId));
    return { recording: true, capacity: ENTRY_LIMIT };
  }
  if (cmd === "stop") {
    forgetNetwork(tabId);
    return { recording: false };
  }
  const r = recordings.get(tabId);
  if (cmd === "detail") {
    if (!requestId) fail("invalid_args", "requestId is required");
    const found = r?.entries.get(requestId);
    if (!r || !found) fail("request_missing", "request was not captured or has been evicted");
    if (!found.complete)
      fail("request_pending", "response body is not complete; wait for complete:true");
    if (found.error) fail("request_failed", found.error);
    const body = r.bodies.get(requestId);
    if (body?.tooLarge) fail("result_too_large", "response body exceeds 1 MiB");
    if (!body?.done)
      fail(
        "body_unavailable",
        "response body was not kept: WebSocket, evicted by newer bodies, or interrupted",
      );
    const bytes = new Uint8Array(body.bytes);
    let offset = 0;
    for (const chunk of body.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { ...found, ...decode(bytes, found.mimeType) };
  }
  if (cmd !== "list") fail("invalid_args", "network cmd must be start, stop, list or detail");
  return {
    requests: [...(r?.entries.values() ?? [])].filter(
      (item) => !filter || item.url?.includes(filter),
    ),
  };
}
