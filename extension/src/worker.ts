import { presetEvent } from "./presets.js";
import { debuggerDetached, execute, forgetTab, releasePageClients } from "./actions.js";
import {
  actionFinished,
  actionStarted,
  actionTarget,
  elementAction,
  startActivity,
  withoutLayer,
} from "./activity.js";
import { emit, startBridge, type Budget } from "./bridge.js";
import { clearRefs, detached, onNode, rawEventTabs, refEvent, releaseInherited } from "./cdp.js";
import { startIndicator } from "./indicator.js";
import { paintChrome } from "./layer.js";
import { event as networkEvent } from "./network.js";
import { fault, type Command, type Hello, type JsonObject } from "./protocol.js";
import { currentTab, initSessions, removed, removedGroup, sessionNames } from "./state.js";
import { topDocument } from "./frames.js";
import { frameEvent, resetScope } from "./frames.js";
import { observe } from "./features.js";
import type { Rect } from "./overlay.js";

// User-Agent Client Hints are not part of TypeScript's DOM library.
type UserAgentData = {
  getHighEntropyValues(
    hints: ["fullVersionList"],
  ): Promise<{ fullVersionList: { brand: string; version: string }[] }>;
};
async function hello(): Promise<Hello> {
  const agent = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
  const [sessions, versions] = await Promise.all([
    sessionNames(),
    agent?.getHighEntropyValues(["fullVersionList"]),
  ]);
  const browserVersion = versions?.fullVersionList.find(
    (entry) => entry.brand === "Chromium",
  )?.version;
  return {
    type: "hello",
    protocol: 1,
    browser: "chrome",
    ...(browserVersion ? { browserVersion } : {}),
    sessions,
  };
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;
  refEvent(source.tabId, method, (params ?? {}) as JsonObject, source.sessionId);
  void presetEvent(source.tabId, method, (params ?? {}) as JsonObject, source.sessionId).catch(
    (error: Error) => console.error("preset event", error.message),
  );
  networkEvent(source.tabId, method, (params ?? {}) as JsonObject, source.sessionId);
  frameEvent(source.tabId, method, (params ?? {}) as JsonObject, source.sessionId);
  observe(source.tabId, method, (params ?? {}) as JsonObject);
  if (method === "Target.attachedToTarget") {
    const p = params as { sessionId: string };
    void chrome.debugger
      .sendCommand({ tabId: source.tabId, sessionId: p.sessionId }, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe", exclude: false }],
      })
      .catch((error: Error) => console.error("attach nested frame", error.message));
  }
  // Only send events when connected. The daemon bounds each subscriber; Chrome's
  // event stream is never retained as an unbounded extension-side queue.
  if (rawEventTabs.has(source.tabId))
    emit({
      type: "event",
      tabId: source.tabId,
      sessionId: source.sessionId,
      method,
      params: params ?? {},
    });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source.tabId) return;
  detached(source.tabId);
  if (rawEventTabs.has(source.tabId))
    emit({ type: "event", tabId: source.tabId, method: "Inspector.detached", params: { reason } });
  debuggerDetached(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  void removed(tabId).catch((error: Error) => console.error("remove tab state", error.message));
});
// Chrome also reports a tab loading while a child frame navigates, which
// changes neither the main document nor the frame selection. A reload keeps
// the URL and arrives as the main frame's Page.frameNavigated; frames.ts then
// reports a selected frame whose document went away.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  clearRefs(tabId);
  resetScope(tabId);
});
chrome.tabGroups.onRemoved.addListener((group) => {
  void removedGroup(group.id).catch((error: Error) =>
    console.error("remove group state", error.message),
  );
});
// Element actions that do not aim the pointer report their target here; the
// pointer actions report it from the point they aim at (actions.ts).
const pointer = new Set(["click", "dblclick", "mouse_click", "hover", "drag"]);
const measure =
  "function(){const r=this.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height};}";

// Runs a command with the activity layer following it on the session's tab.
async function tracked(command: Command, budget: Budget): Promise<object> {
  const args = command.args ?? {};
  const tabId = args.tabId ?? args.tab ?? currentTab(command.session);
  if (tabId === undefined) return execute(command, budget);
  if (command.action === "screenshot" || command.action === "save_as_pdf")
    return withoutLayer(tabId, () => execute(command, budget));
  const drawing = actionStarted(tabId, command.action);
  const selector = args.selector;
  // Pointer actions report their own target; for the others the frame is
  // measured before the action and again after it, when the element may have
  // scrolled into view.
  const follow =
    drawing &&
    elementAction(command.action) &&
    !pointer.has(command.action) &&
    selector !== undefined &&
    topDocument(tabId);
  const target = async (): Promise<void> => {
    let rect: Rect;
    try {
      rect = await onNode<Rect>(tabId, selector!, measure);
    } catch {
      // The action reports a missing or detached element itself.
      return;
    }
    actionTarget(tabId, rect);
  };
  try {
    if (follow && command.action !== "scroll") await target();
    const result = await execute(command, budget);
    if (follow) await target();
    return result;
  } finally {
    actionFinished(tabId);
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});
startIndicator();
startActivity(paintChrome);
void initSessions(releaseInherited).catch((error: Error) =>
  console.error("restore sessions", fault(error).message),
);
// Page CDP clients reach their tabs through one daemon connection only.
startBridge({ hello, execute: tracked, disconnected: releasePageClients });
