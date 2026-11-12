import { message, setLanguage } from "./language.js";
import {
  readConnection,
  readControls,
  readPreferences,
  type Connection,
  type Control,
} from "./status.js";

// The toolbar icon shows the connection state; on a controlled tab it shows
// that an agent is working there. Icons come from packages/brand/icons.
type Variant = "connected" | "live" | "offline" | "error" | "paused";

function variant(connection: Connection, control: Control | undefined): Variant {
  switch (connection.state) {
    case "paused":
      return "paused";
    case "connected":
      return control ? "live" : "connected";
    case "offline":
    case "rejected":
      return "error";
    case "unpaired":
    case "connecting":
      return "offline";
  }
}
const icon = (name: Variant): Record<string, string> => ({
  16: `icons/toolbar-${name}-16.png`,
  32: `icons/toolbar-${name}-32.png`,
});
function title(connection: Connection, control: Control | undefined): string {
  if (connection.state === "connected" && control)
    return message("titleControlled", { session: control.session });
  return message(`titleState_${connection.state}`);
}

// Tabs that hold a tab-specific icon and title. The browser keeps those values
// until the tab closes or navigates, also after a session lets the tab go, so
// every update writes the current state to each of them. Session storage keeps
// the list for a restarted background; `marked` mirrors the last saved list.
let marked = new Set<number>();
async function readMarked(): Promise<number[]> {
  const { actionTabs } = (await chrome.storage.session.get("actionTabs")) as {
    actionTabs?: number[];
  };
  return actionTabs ?? [];
}
async function saveMarked(tabIds: Set<number>): Promise<void> {
  const changed = tabIds.size !== marked.size || [...tabIds].some((id) => !marked.has(id));
  marked = tabIds;
  if (changed) await chrome.storage.session.set({ actionTabs: [...tabIds] });
}

async function update(): Promise<void> {
  const [connection, controls, preferences, saved] = await Promise.all([
    readConnection(),
    readControls(),
    readPreferences(),
    readMarked(),
  ]);
  setLanguage(preferences.language);
  await chrome.action.setIcon({ path: icon(variant(connection, undefined)) });
  await chrome.action.setTitle({ title: title(connection, undefined) });
  const tabIds = new Set([...saved, ...Object.keys(controls).map(Number)]);
  const next = new Set<number>();
  for (const tabId of tabIds) {
    const control = controls[tabId];
    try {
      await chrome.action.setIcon({ tabId, path: icon(variant(connection, control)) });
      await chrome.action.setTitle({ tabId, title: title(connection, control) });
      next.add(tabId);
    } catch (error) {
      // The tab closed after the list or the controls were read.
      console.warn(`toolbar icon for tab ${tabId}`, (error as Error).message);
    }
  }
  await saveMarked(next);
}
async function forget(tabId: number): Promise<void> {
  const saved = await readMarked();
  if (saved.includes(tabId)) await saveMarked(new Set(saved.filter((id) => id !== tabId)));
}

// Updates run one at a time, so a slow one never overwrites a newer state.
let queue = Promise.resolve();
function run(task: () => Promise<void>): void {
  const previous = queue;
  queue = (async () => {
    await previous;
    try {
      await task();
    } catch (error) {
      console.error("update toolbar icon", (error as Error).message);
    }
  })();
}

export function startIndicator(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && (changes.connection || changes.controls)) run(update);
    if (area === "local" && changes.preferences) run(update);
  });
  // Chrome clears tab-specific action values when the tab navigates.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading" && marked.has(tabId)) run(update);
  });
  chrome.tabs.onRemoved.addListener((tabId) => run(() => forget(tabId)));
  void chrome.action.setBadgeText({ text: "" });
  run(update);
}
