import { closedTab } from "../state.js";

// Firefox reports a tab that no longer exists as "Invalid tab ID: N", from
// tabs.*, webNavigation.*, scripting.executeScript and userScripts.execute.
const closedPrefix = "Invalid tab ID: ";
export function closedTabId(error: Error): number | undefined {
  if (!(error instanceof Error) || !error.message.startsWith(closedPrefix)) return undefined;
  const tabId = Number(error.message.slice(closedPrefix.length));
  return Number.isInteger(tabId) ? tabId : undefined;
}
// Fails with tab_missing when the tab has been closed.
export async function assertTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.get(tabId);
  } catch (error) {
    if (closedTabId(error as Error) === tabId) closedTab(tabId);
    throw error;
  }
}
