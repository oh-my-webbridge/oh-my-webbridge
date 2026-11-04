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

// Tabs that received a tab-specific icon and need it updated with the global one.
const marked = new Set<number>();

async function update(): Promise<void> {
  const [connection, controls, preferences] = await Promise.all([
    readConnection(),
    readControls(),
    readPreferences(),
  ]);
  setLanguage(preferences.language);
  await chrome.action.setIcon({ path: icon(variant(connection, undefined)) });
  await chrome.action.setTitle({ title: title(connection, undefined) });
  const tabIds = new Set([...marked, ...Object.keys(controls).map(Number)]);
  for (const tabId of tabIds) {
    const control = controls[tabId];
    try {
      await chrome.action.setIcon({ tabId, path: icon(variant(connection, control)) });
      await chrome.action.setTitle({ tabId, title: title(connection, control) });
    } catch (error) {
      // The tab closed after the controls were read.
      console.warn(`toolbar icon for tab ${tabId}`, (error as Error).message);
    }
    if (control) marked.add(tabId);
    else marked.delete(tabId);
  }
}

// Updates run one at a time, so a slow one never overwrites a newer state.
let queue = Promise.resolve();

export function startIndicator(): void {
  const run = (): void => {
    queue = queue
      .then(update)
      .catch((error: Error) => console.error("update toolbar icon", error.message));
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && (changes.connection || changes.controls)) run();
    if (area === "local" && changes.preferences) run();
  });
  // Chrome clears tab-specific action values when the tab navigates.
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading" && marked.has(tabId)) run();
  });
  chrome.tabs.onRemoved.addListener((tabId) => marked.delete(tabId));
  void chrome.action.setBadgeText({ text: "" });
  run();
}
