import { send } from "./cdp.js";
import { fail, type JsonObject } from "./protocol.js";

type Entry = {
  requestId: string;
  url?: string;
  method?: string;
  status?: number;
  mimeType?: string;
  error?: string;
  complete?: boolean;
};
const buffers = new Map<number, Map<string, Entry>>();
export function event(tabId: number, method: string, params: JsonObject): void {
  const buffer = buffers.get(tabId);
  if (!buffer || typeof params.requestId !== "string") return;
  const id = params.requestId;
  const entry = buffer.get(id) ?? { requestId: id };
  if (method === "Network.requestWillBeSent") {
    const request = params.request as { url: string; method: string };
    entry.url = request.url.slice(0, 8192);
    entry.method = request.method;
    entry.complete = false;
  } else if (method === "Network.responseReceived") {
    const response = params.response as { status: number; mimeType: string };
    entry.status = response.status;
    entry.mimeType = response.mimeType;
  } else if (method === "Network.loadingFinished") entry.complete = true;
  else if (method === "Network.loadingFailed") {
    entry.error =
      typeof params.errorText === "string" ? params.errorText : "network request failed";
    entry.complete = true;
  } else return;
  buffer.set(id, entry);
  if (buffer.size > 500) {
    const oldest = buffer.keys().next().value;
    if (oldest) buffer.delete(oldest);
  }
}
export function forget(tabId: number): void {
  buffers.delete(tabId);
}
export async function network(
  tabId: number,
  cmd = "list",
  filter?: string,
  requestId?: string,
): Promise<object> {
  if (cmd === "start") {
    await send(tabId, "Network.enable", {
      maxTotalBufferSize: 8 << 20,
      maxResourceBufferSize: 1 << 20,
    });
    buffers.set(tabId, new Map());
    return { recording: true, capacity: 500 };
  }
  if (cmd === "stop") {
    await send(tabId, "Network.disable");
    forget(tabId);
    return { recording: false };
  }
  if (cmd === "detail") {
    if (!requestId) fail("invalid_args", "requestId is required");
    const entry = buffers.get(tabId)?.get(requestId);
    if (!entry) fail("request_missing", "request was not captured or has been evicted");
    if (!entry.complete)
      fail("request_pending", "response body is not complete; wait for complete:true");
    if (entry.error) fail("request_failed", entry.error);
    const body = await send<{ body: string; base64Encoded: boolean }>(
      tabId,
      "Network.getResponseBody",
      { requestId },
    );
    if (body.body.length > 2 << 20)
      fail("result_too_large", "response body exceeds 2 Mi characters");
    return { ...entry, ...body };
  }
  if (cmd !== "list") fail("invalid_args", "network cmd must be start, stop, list or detail");
  return {
    requests: [...(buffers.get(tabId)?.values() ?? [])].filter(
      (entry) => !filter || entry.url?.includes(filter),
    ),
  };
}
