import { fail, type Json } from "../protocol.js";
import { siteAccessHint } from "./access.js";
import type { PageArgs } from "./page-api.js";

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
    if (/^Invalid (?:documentId|frame IDs)/u.test(message)) {
      if ("documentIds" in chosen && chosen.documentIds) scopes.delete(tabId);
      fail(
        "frame_unavailable",
        `${label}: the frame navigated or was removed; commands now use the main frame (${message})`,
      );
    }
    if (message.startsWith("Missing host permission"))
      fail(
        "restricted_tab",
        `${label}: Firefox does not run extension scripts in this page (${message}); ${siteAccessHint}`,
      );
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
  if (!answer) fail("browser_error", `${op}: page script returned no result`);
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
// Evaluates code in the page's main world of the selected frame. Firefox runs
// code strings only through userScripts.execute, which needs the optional
// userScripts permission granted from the popup.
export async function evaluate(tabId: number, code: string): Promise<Json | undefined> {
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
