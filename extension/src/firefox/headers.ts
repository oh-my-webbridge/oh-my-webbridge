import { fail, type JsonObject } from "../protocol.js";

type Listener = (
  details: chrome.webRequest.OnBeforeSendHeadersDetails,
) => chrome.webRequest.BlockingResponse | undefined;
const listeners = new Map<number, Listener>();

export function forgetHeaders(tabId: number): void {
  const listener = listeners.get(tabId);
  if (listener) chrome.webRequest.onBeforeSendHeaders.removeListener(listener);
  listeners.delete(tabId);
}
// Adds the headers to every request of the tab, replacing the previous set
// and same-named request headers, like Network.setExtraHTTPHeaders in Chrome.
export function setExtraHeaders(tabId: number, data: JsonObject): void {
  const entries = Object.entries(data);
  const values: [string, string][] = [];
  for (const [name, value] of entries) {
    if (typeof value !== "string" || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) break;
    values.push([name, value]);
  }
  if (
    entries.length > 128 ||
    values.length !== entries.length ||
    JSON.stringify(data).length > 32768
  )
    fail("invalid_args", "headers must be at most 128 string values / 32 KiB without CR or LF");
  forgetHeaders(tabId);
  if (!values.length) return;
  const names = new Set(values.map(([name]) => name.toLowerCase()));
  const listener: Listener = (details) => ({
    requestHeaders: [
      ...(details.requestHeaders ?? []).filter((h) => !names.has(h.name.toLowerCase())),
      ...values.map(([name, value]) => ({ name, value })),
    ],
  });
  listeners.set(tabId, listener);
  chrome.webRequest.onBeforeSendHeaders.addListener(listener, { urls: ["<all_urls>"], tabId }, [
    "blocking",
    "requestHeaders",
  ]);
}
