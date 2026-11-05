import {
  actionFinished,
  actionStarted,
  actionTarget,
  elementAction,
  startActivity,
  withoutLayer,
} from "../activity.js";
import { startBridge, type Budget } from "../bridge.js";
import { startIndicator } from "../indicator.js";
import type { Rect } from "../overlay.js";
import { fault, type Command, type Hello, type Json } from "../protocol.js";
import { currentTab, initSessions, removed, removedGroup, sessionNames } from "../state.js";
import { paintFirefox } from "./layer.js";
import { refreshSiteAccess } from "./access.js";
import { execute, forgetTab } from "./actions.js";
import { callPage, resetScope, scopeOf } from "./inject.js";

async function hello(): Promise<Hello> {
  const [sessions, info] = await Promise.all([sessionNames(), chrome.runtime.getBrowserInfo()]);
  return { type: "hello", protocol: 1, browser: "firefox", browserVersion: info.version, sessions };
}
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  void removed(tabId).catch((error: Error) => console.error("remove tab state", error.message));
});
// A new tab URL ends the frame selection. Firefox also reports the unchanged
// URL, for example with status "complete" once an iframe that navigated to
// another site is removed, and reports loading while the main document reloads;
// neither ends it. A selected frame whose document is replaced or removed, a
// reload included, fails the next command for it (inject.ts).
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url !== undefined && change.url !== scopeOf(tabId)?.url) resetScope(tabId);
});
const siteAccessChanged = (): void =>
  void refreshSiteAccess().catch((error: Error) =>
    console.error("read site access", fault(error).message),
  );
chrome.permissions.onAdded.addListener(siteAccessChanged);
chrome.permissions.onRemoved.addListener(siteAccessChanged);
siteAccessChanged();
chrome.tabGroups.onRemoved.addListener((group) => {
  void removedGroup(group.id).catch((error: Error) =>
    console.error("remove group state", error.message),
  );
});
// webRequest listeners, frame selections and recordings live in this page
// instance only; a restarted event page starts without them.
void initSessions(async () => {}).catch((error: Error) =>
  console.error("restore sessions", fault(error).message),
);
function rectOf(value: Json): Rect | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { x, y, width, height } = value;
  return typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number"
    ? { x, y, width, height }
    : undefined;
}
// Runs a command with the activity layer following it on the session's tab.
// The focus frame is measured before the action and again after it, when the
// element may have scrolled into view. Coordinates of a selected iframe are its
// own, so the frame is drawn only for the main frame.
async function tracked(command: Command, budget: Budget): Promise<object> {
  const args = command.args ?? {};
  const tabId = args.tabId ?? args.tab ?? currentTab(command.session);
  if (tabId === undefined) return execute(command, budget);
  if (command.action === "screenshot") return withoutLayer(tabId, () => execute(command, budget));
  const drawing = actionStarted(tabId, command.action);
  const selector = args.selector;
  const follow =
    drawing && elementAction(command.action) && selector !== undefined && !scopeOf(tabId);
  const target = (): Promise<void> =>
    callPage(tabId, "box", { selector }).then(
      (value) => {
        const rect = rectOf(value);
        if (rect) actionTarget(tabId, rect);
      },
      // The action reports a missing element itself.
      () => undefined,
    );
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
startActivity(paintFirefox);
startBridge({
  hello,
  execute: tracked,
  // Any extension API call resets the event page idle timer.
  heartbeat: async () => {
    await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  },
});
