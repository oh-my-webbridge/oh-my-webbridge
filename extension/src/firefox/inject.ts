import { fail, type Json } from "../protocol.js";
import { closedTab } from "../state.js";
import { refreshSiteAccess, siteAccessHint } from "./access.js";
import type { PageArgs } from "./page-api.js";
import { assertTab, closedTabId } from "./tabs.js";

type Target = chrome.scripting.InjectionTarget;
type Injected<T> = { documentId: string; frameId: number; result?: T };
// The selected frame of a tab and the tab's URL when it was selected. Its
// documentId stops matching once the frame navigates or is removed, so later
// calls fail instead of reaching a new document.
type Scope = { frameId: number; documentId: string; url?: string };
const scopes = new Map<number, Scope>();

export function resetScope(tabId: number): void {
  scopes.delete(tabId);
}
export function scopeOf(tabId: number): Scope | undefined {
  return scopes.get(tabId);
}
function target(tabId: number): Target {
  const scope = scopes.get(tabId);
  return scope ? { tabId, documentIds: [scope.documentId] } : { tabId, frameIds: [0] };
}
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
// The targeted frame is gone. A selected frame's selection ends with it.
function frameGone(tabId: number, label: string, chosen: Target, detail: string): never {
  if (chosen.documentIds) scopes.delete(tabId);
  fail(
    "frame_unavailable",
    `${label}: the frame navigated or was removed; commands now use the main frame (${detail})`,
  );
}
// The targeted document was replaced while the call was on its way, so the
// script did not run in it: the selected frame or the page navigated.
async function replaced(
  tabId: number,
  label: string,
  chosen: Target,
  detail: string,
): Promise<never> {
  await assertTab(tabId);
  if (chosen.documentIds) frameGone(tabId, label, chosen, detail);
  fail(
    "outcome_unknown",
    `${label}: the page navigated during the command; observe before retrying (${detail})`,
  );
}
// Whether the tab's main frame runs extension scripts now.
async function scriptable(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      injectImmediately: true,
      func: () => true,
    });
    return true;
  } catch (error) {
    if (closedTabId(error as Error) === tabId) closedTab(tabId);
    if (messageOf(error).startsWith("Missing host permission")) return false;
    throw error;
  }
}
// Firefox rejects with "Missing host permission" when no targeted document ran
// the script: the extension lacks site access, Firefox protects the page from
// extensions (about: pages, addons.mozilla.org), or the targeted document was
// replaced on the way (Firefox bug 2047009). A main frame that runs scripts
// again was navigating.
async function unreached(
  tabId: number,
  label: string,
  chosen: Target,
  message: string,
): Promise<never> {
  if (!(await refreshSiteAccess()))
    fail(
      "restricted_tab",
      `${label}: Firefox does not run extension scripts in this page (${message}); ${siteAccessHint}`,
    );
  if (chosen.documentIds || (chosen.frameIds?.[0] === 0 && (await scriptable(tabId))))
    return replaced(tabId, label, chosen, message);
  fail(
    "restricted_tab",
    `${label}: Firefox does not let extensions run scripts in this page (${message})`,
  );
}
// The code ran, and its result is data that the reply to the daemon cannot carry.
function unreturnable(label: string, detail: string): never {
  fail(
    "evaluation_failed",
    `${label}: the code ran, but its result cannot be returned (${detail}); return JSON data such as a string, number, array or plain object`,
  );
}
// Firefox rejects when no targeted frame can run the script and reports a
// script exception through InjectionResult.error.
async function inject<T>(
  tabId: number,
  label: string,
  scriptError: string,
  run: (target: Target) => Promise<Injected<T>[]>,
  chosen: Target = target(tabId),
): Promise<Injected<T>> {
  let results: Injected<T>[];
  try {
    results = await run(chosen);
  } catch (error) {
    const message = messageOf(error);
    if (closedTabId(error as Error) === tabId) closedTab(tabId);
    if (/^Invalid (?:documentId|frame IDs)/u.test(message))
      frameGone(tabId, label, chosen, message);
    if (message.startsWith("Missing host permission"))
      return unreached(tabId, label, chosen, message);
    if (message.endsWith("result is non-structured-clonable data")) unreturnable(label, message);
    fail("browser_error", `${label}: ${message}`);
  }
  const [entry] = results;
  if (!entry) fail("browser_error", `${label}: no frame returned a result`);
  if ("error" in entry && entry.error !== undefined)
    fail(scriptError, `${label}: ${messageOf(entry.error)}`);
  return entry;
}

// Runs one page.js operation in the selected frame. page.js is injected on
// first use in each document and keeps its element references there.
export async function callPage(tabId: number, op: string, args: PageArgs = {}): Promise<Json> {
  const call = (chosen: Target) =>
    chrome.scripting.executeScript({
      target: chosen,
      injectImmediately: true,
      func: (name: string, values: PageArgs) => globalThis.__omwPage?.(name, values) ?? null,
      args: [op, args],
    });
  let answer = (await inject(tabId, op, "browser_error", call)).result;
  if (answer === null) {
    await inject(tabId, op, "browser_error", (chosen) =>
      chrome.scripting.executeScript({
        target: chosen,
        injectImmediately: true,
        files: ["page.js"],
      }),
    );
    answer = (await inject(tabId, op, "browser_error", call)).result;
  }
  // Firefox returns no result when the document unloads as the script reaches
  // it, and page.js is missing when the call reaches the next document.
  if (!answer) return replaced(tabId, op, target(tabId), "page script returned no result");
  if (!answer.ok) fail(answer.code, answer.message);
  return answer.value;
}
// Drops the element references of the selected frame's document, if page.js
// is installed there.
export async function clearRefs(tabId: number): Promise<void> {
  await inject(tabId, "clear_refs", "browser_error", (chosen) =>
    chrome.scripting.executeScript({
      target: chosen,
      injectImmediately: true,
      func: () => globalThis.__omwPage?.("clear_refs", {}) ?? null,
    }),
  );
}
export async function selectFrame(tabId: number, frameId: number): Promise<void> {
  if (frameId === 0) {
    scopes.delete(tabId);
    return;
  }
  const entry = await inject(
    tabId,
    "frame",
    "browser_error",
    (chosen) =>
      chrome.scripting.executeScript({ target: chosen, injectImmediately: true, func: () => true }),
    { tabId, frameIds: [frameId] },
  );
  const { url } = await chrome.tabs.get(tabId);
  scopes.set(tabId, { frameId, documentId: entry.documentId, url });
}
// Runs code in the page's main world of the selected frame and returns the
// completion value. Firefox runs code strings only through
// userScripts.execute, which needs the optional userScripts permission
// granted from the popup.
async function execute(tabId: number, code: string): Promise<Json | undefined> {
  if (!(await chrome.permissions.contains({ permissions: ["userScripts"] })))
    fail(
      "unsupported",
      "evaluate is not available in Firefox until user scripts are allowed: open the oh-my-webbridge settings page and choose Allow scripts",
    );
  const entry = await inject<Json>(tabId, "evaluate", "evaluation_failed", (chosen) =>
    chrome.userScripts.execute<Json>({
      target: chosen,
      world: "MAIN",
      injectImmediately: true,
      js: [{ code }],
    }),
  );
  return entry.result;
}
// The value of code for the evaluate action. userScripts.execute returns
// structured-clone data, which can hold values JSON cannot, such as a BigInt
// or a cyclic object.
export async function evaluate(tabId: number, code: string): Promise<Json | undefined> {
  const value = await execute(tabId, code);
  try {
    JSON.stringify(value);
  } catch (error) {
    unreturnable("evaluate", messageOf(error));
  }
  return value;
}
// Whether code's value is truthy, for wait.
export async function evaluateCondition(tabId: number, code: string): Promise<boolean> {
  return !!(await execute(tabId, code));
}
