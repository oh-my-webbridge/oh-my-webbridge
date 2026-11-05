import { applyActivity, type ActivityState } from "../overlay.js";

// Firefox draws the activity layer with an injected function in the page's
// content-script world.
export async function paintFirefox(tabId: number, state: ActivityState): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, func: applyActivity, args: [state] });
}
