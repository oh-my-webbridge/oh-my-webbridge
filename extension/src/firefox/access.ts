import { fail } from "../protocol.js";

// Firefox lets the user withdraw "Access to all websites", the <all_urls>
// host permission, in about:addons at any time. Without it Firefox still
// calls the blocking webRequest listeners but ignores their cancellations,
// tabs.captureTab disappears and cookies.getAll returns nothing.
const allSites = { origins: ["<all_urls>"] };
export const siteAccessHint = "check that oh-my-webbridge may access all websites in about:addons";
// Last known state; refreshSiteAccess runs at startup, on permission changes
// and before an action depends on it.
let granted = false;
export async function refreshSiteAccess(): Promise<boolean> {
  granted = await chrome.permissions.contains(allSites);
  return granted;
}
export function hasSiteAccess(): boolean {
  return granted;
}
export async function requireSiteAccess(label: string): Promise<void> {
  if (!(await refreshSiteAccess()))
    fail("restricted_tab", `${label}: oh-my-webbridge may not access websites; ${siteAccessHint}`);
}
