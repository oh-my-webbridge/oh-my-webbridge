import { sendRoot } from "./cdp.js";
import { selectedScope } from "./frames.js";
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
// A recording belongs to the CDP session of the frame selected at start: the
// root session, which also reports same-process frames, or the flat child
// session of a cross-process frame. Its events, response bodies and
// Network.disable stay in that session when another frame is selected later.
type Recording = { sessionId: string | undefined; requests: Map<string, Entry> };
const recordings = new Map<number, Recording>();
export function event(tabId: number, method: string, params: JsonObject, sessionId?: string): void {
  const recording = recordings.get(tabId);
  if (!recording || recording.sessionId !== sessionId || typeof params.requestId !== "string")
    return;
  const buffer = recording.requests;
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
  recordings.delete(tabId);
}
export async function network(
  tabId: number,
  cmd = "list",
  filter?: string,
  requestId?: string,
): Promise<object> {
  if (cmd === "start") {
    const sessionId = selectedScope(tabId)?.sessionId;
    await sendRoot(
      tabId,
      "Network.enable",
      { maxTotalBufferSize: 8 << 20, maxResourceBufferSize: 1 << 20 },
      sessionId,
    );
    recordings.set(tabId, { sessionId, requests: new Map() });
    return { recording: true, capacity: 500 };
  }
  if (cmd === "stop") {
    // Without a recording, Network.disable goes to the selected frame's session.
    const { sessionId } = recordings.get(tabId) ?? { sessionId: selectedScope(tabId)?.sessionId };
    // Forgotten first: a recording whose frame went away still ends.
    forget(tabId);
    await sendRoot(tabId, "Network.disable", {}, sessionId);
    return { recording: false };
  }
  const recording = recordings.get(tabId);
  if (cmd === "detail") {
    if (!requestId) fail("invalid_args", "requestId is required");
    const entry = recording?.requests.get(requestId);
    if (!recording || !entry)
      fail("request_missing", "request was not captured or has been evicted");
    if (!entry.complete)
      fail("request_pending", "response body is not complete; wait for complete:true");
    if (entry.error) fail("request_failed", entry.error);
    const body = await sendRoot<{ body: string; base64Encoded: boolean }>(
      tabId,
      "Network.getResponseBody",
      { requestId },
      recording.sessionId,
    );
    if (body.body.length > 2 << 20)
      fail("result_too_large", "response body exceeds 2 Mi characters");
    return { ...entry, ...body };
  }
  if (cmd !== "list") fail("invalid_args", "network cmd must be start, stop, list or detail");
  return {
    requests: [...(recording?.requests.values() ?? [])].filter(
      (entry) => !filter || entry.url?.includes(filter),
    ),
  };
}
