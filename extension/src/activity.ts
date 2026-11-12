import type { MessageKey } from "./i18n.js";
import { message } from "./language.js";
import type { ActivityState, Rect } from "./overlay.js";
import { controlledTabs, onSessionsChanged } from "./state.js";
import { readPreferences, type Controls, type Settings } from "./status.js";

// Draws the activity layer on controlled tabs and publishes them for the
// toolbar icon and the popup. The backend supplies the painter: Chrome
// evaluates through its debugger session, Firefox injects a script.
export type Painter = (tabId: number, state: ActivityState) => Promise<void>;
type Tab = {
  session: string;
  borrowed: boolean;
  busy: number;
  label?: string;
  target?: Rect;
  settle?: ReturnType<typeof setTimeout>;
  painted: boolean;
};

// Pages cannot load extension URLs, so the favicon is a data URL of the live
// toolbar icon.
let favicon: Promise<string> | undefined;
async function loadFavicon(): Promise<string> {
  const response = await fetch(chrome.runtime.getURL("icons/toolbar-live-32.png"));
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}
// The layer removes itself unless renewed; a stopped background or a lost
// debugger session cannot leave it on a page. The "activity" alarm renews it
// every 30 seconds, the shortest period Chrome allows.
const lease = 75_000;
// The glow and focus frame stay this long after an action so consecutive
// actions read as one activity.
const settleMs = 600;
const tabs = new Map<number, Tab>();
// Screenshots and PDFs in progress for each tab. Every paint keeps the layer
// hidden on the tab until its last capture ends, so a settle timer, the alarm
// or a finished navigation during the capture cannot show it again.
const capturing = new Map<number, number>();
let painter: Painter | undefined;
let enabled = true;

// Element actions and the label shown above their target.
const labels: Record<string, MessageKey> = {
  click: "activityClick",
  dblclick: "activityClick",
  mouse_click: "activityClick",
  hover: "activityHover",
  fill: "activityType",
  key_type: "activityType",
  select_option: "activitySelect",
  check: "activityCheck",
  uncheck: "activityCheck",
  focus: "activityFocus",
  scroll: "activityScroll",
  drag: "activityDrag",
  upload: "activityUpload",
};
export const elementAction = (action: string): boolean => action in labels;

type Drawn = Omit<ActivityState, "favicon">;
function state(tab: Tab, extra: Partial<Drawn> = {}): Drawn {
  return {
    show: true,
    busy: tab.busy > 0,
    ...(tab.target ? { target: tab.target, label: tab.label ?? "" } : {}),
    session: tab.session,
    lease: Date.now() + lease,
    ...extra,
  };
}

async function paint(tabId: number, value: Drawn): Promise<void> {
  if (!painter) return;
  try {
    favicon ??= loadFavicon();
    const icon = await favicon;
    const hidden = capturing.has(tabId) ? { hidden: true } : {};
    await painter(tabId, { ...value, ...hidden, favicon: icon });
  } catch (error) {
    // The layer is decoration, so a closed, restricted or detached tab loses
    // nothing but the layer.
    console.warn(`activity layer on tab ${tabId}`, (error as Error).message);
  }
}
function refresh(tabId: number): void {
  const tab = tabs.get(tabId);
  if (!tab || !enabled) return;
  tab.painted = true;
  void paint(tabId, state(tab));
}

function publish(): void {
  const controls: Controls = {};
  for (const [tabId, tab] of tabs)
    controls[tabId] = { session: tab.session, borrowed: tab.borrowed, busy: tab.busy > 0 };
  void chrome.storage.session
    .set({ controls })
    .catch((error: Error) => console.error("save controlled tabs", error.message));
}

// Follows the sessions: newly controlled tabs get the layer, released ones lose it.
function sync(): void {
  const current = controlledTabs();
  for (const [tabId, tab] of tabs)
    if (!current.has(tabId)) {
      tabs.delete(tabId);
      clearTimeout(tab.settle);
      if (tab.painted) void paint(tabId, { ...state(tab), show: false });
    }
  for (const [tabId, owner] of current) {
    const tab = tabs.get(tabId);
    if (tab && tab.session === owner.session) continue;
    tabs.set(tabId, { ...owner, busy: 0, painted: false });
    refresh(tabId);
  }
  publish();
}

async function loadEnabled(): Promise<void> {
  try {
    enabled = (await readPreferences()).activityLayer;
  } catch (error) {
    console.error("read preferences", (error as Error).message);
  }
}

export function startActivity(paintWith: Painter): void {
  painter = paintWith;
  onSessionsChanged(sync);
  void loadEnabled();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.preferences) return;
    const preferences = changes.preferences.newValue as Settings["preferences"];
    const next = preferences?.activityLayer ?? true;
    if (next === enabled) return;
    enabled = next;
    for (const [tabId, tab] of tabs) {
      if (enabled) refresh(tabId);
      else if (tab.painted) {
        tab.painted = false;
        void paint(tabId, { ...state(tab), show: false });
      }
    }
  });
  // A finished navigation replaces the document and the layer with it.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "complete") refresh(tabId);
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "activity") for (const tabId of tabs.keys()) refresh(tabId);
  });
  void chrome.alarms.create("activity", { periodInMinutes: 0.5 });
}

// Returns whether the layer is enabled, so callers can skip work that only
// feeds it.
export function actionStarted(tabId: number, action: string): boolean {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  clearTimeout(tab.settle);
  tab.busy++;
  if (!elementAction(action)) tab.target = undefined;
  tab.label = labels[action] ? message(labels[action]) : undefined;
  refresh(tabId);
  publish();
  return enabled;
}

// Records the target of the running action; a report with no action running
// is dropped.
export function actionTarget(tabId: number, target: Rect, action?: string): void {
  const tab = tabs.get(tabId);
  if (!tab || !tab.busy) return;
  tab.target = target;
  if (action && labels[action]) tab.label = message(labels[action]);
  refresh(tabId);
}

export function actionFinished(tabId: number): void {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tab.busy = Math.max(0, tab.busy - 1);
  if (tab.busy) return;
  clearTimeout(tab.settle);
  tab.settle = setTimeout(() => {
    tab.target = undefined;
    refresh(tabId);
    publish();
  }, settleMs);
}

// Runs a capture with the layer hidden, so screenshots and PDFs show the page only.
export async function withoutLayer<T>(tabId: number, capture: () => Promise<T>): Promise<T> {
  capturing.set(tabId, (capturing.get(tabId) ?? 0) + 1);
  try {
    const tab = tabs.get(tabId);
    if (tab?.painted) await paint(tabId, state(tab));
    return await capture();
  } finally {
    const count = capturing.get(tabId)! - 1;
    if (count) capturing.set(tabId, count);
    else capturing.delete(tabId);
    if (tabs.get(tabId)?.painted) refresh(tabId);
  }
}

// Removes the layer before the backend lets go of a tab it keeps open.
export async function releaseLayer(tabId: number): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab?.painted) return;
  tab.painted = false;
  await paint(tabId, { ...state(tab), show: false });
}
