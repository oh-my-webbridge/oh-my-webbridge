import { fail, type JsonObject } from "./protocol.js";
import { locatorExpression } from "./locators.js";
import {
  forgetFrames,
  restoreLost,
  scopeGone,
  scopes,
  selectedScope,
  type Scope,
} from "./frames.js";
import { closedTab } from "./state.js";

// Chrome's errors by their cause. chrome.tabs and chrome.debugger
// (debugger_api.cc) reject with plain text. Errors of DevTools protocol
// commands, from content/browser/devtools, Blink's inspector agents and V8's
// inspector, arrive as the JSON of {code, message}.
const causes = {
  // chrome.tabs: "No tab with id: 5."; chrome.debugger: "No tab with given id 5."
  tab: ["No tab with id: ", "No tab with given id "],
  // chrome.debugger once Chrome has ended the tab's debugger session.
  detached: ["Debugger is not attached to the tab with id: "],
  // The command ended without a reply after it may have reached the page.
  cutoff: [
    "Detached while handling command.",
    "Execution context was destroyed.",
    "Inspected target navigated or closed",
  ],
  // A frame's flat session or an execution context no longer exists.
  session: ["Session with given id not found."],
  context: ["Cannot find context with specified id"],
  // A node addressed by its backend node id no longer exists.
  node: [
    "No node with given id found",
    "Node with given id does not belong to the document",
    "No node found for given backend id",
  ],
  // The element exists but does not take the command.
  refused: ["Element is not focusable", "Node is not a file input element"],
  // The element has no layout box.
  boxless: ["Could not compute content quads."],
} as const;
type Cause = keyof typeof causes;
function chromeMessage(error: Error): string {
  if (!(error instanceof Error)) return "";
  if (!error.message.startsWith("{")) return error.message;
  return (JSON.parse(error.message) as { message?: string }).message ?? "";
}
// The cause of a Chrome error, or undefined for errors outside the list above
// and for coded faults.
export function cause(error: Error): Cause | undefined {
  const message = chromeMessage(error);
  return (Object.keys(causes) as Cause[]).find((key) =>
    causes[key].some((text) => message.startsWith(text)),
  );
}
// The tab that a chrome.tabs or chrome.debugger error reports as closed.
export function closedTabId(error: Error): number | undefined {
  const message = chromeMessage(error);
  const prefix = causes.tab.find((text) => message.startsWith(text));
  return prefix === undefined ? undefined : Number.parseInt(message.slice(prefix.length), 10);
}
async function tabClosed(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return false;
  } catch (error) {
    if (cause(error as Error) === "tab") return true;
    throw error;
  }
}

const attachments = new Map<number, Promise<void>>();
export const rawEventTabs = new Set<number>();
export async function attach(tabId: number): Promise<void> {
  let pending = attachments.get(tabId);
  if (!pending) {
    pending = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
        await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }],
        });
      } catch (error) {
        attachments.delete(tabId);
        if (cause(error as Error) === "tab") closedTab(tabId);
        fail("debugger_unavailable", `attach tab ${tabId}: ${String(error)}`);
      }
    })();
    attachments.set(tabId, pending);
  }
  await pending;
}
export const attached = (tabId: number): boolean => attachments.has(tabId);
// Sends a command to the selected frame's session, or the tab's root session.
// A selected frame whose session or execution context went away before Chrome
// reported it fails the command with frame_unavailable.
export async function send<T extends object>(
  tabId: number,
  method: string,
  params: JsonObject = {},
  sessionId?: string,
): Promise<T> {
  await attach(tabId);
  const scope = sessionId ? undefined : selectedScope(tabId);
  try {
    return await sendRoot<T>(tabId, method, params, sessionId ?? scope?.sessionId);
  } catch (error) {
    const reason = cause(error as Error);
    if (
      scope &&
      (reason === "session" ||
        (reason === "context" && (params.contextId ?? scope.contextId) === scope.contextId))
    )
      scopeGone(tabId, scope);
    throw error;
  }
}
// A command that Chrome ends because the tab closed fails with tab_missing.
// One cut off by a navigation or by the end of the debugger session fails with
// outcome_unknown, since the page may have acted on it; Chrome ends the
// commands of a closing tab the same way.
export async function sendRoot<T extends object>(
  tabId: number,
  method: string,
  params: JsonObject = {},
  sessionId?: string,
): Promise<T> {
  await attach(tabId);
  try {
    return ((await chrome.debugger.sendCommand(
      { tabId, ...(sessionId ? { sessionId } : {}) },
      method,
      params,
    )) ?? {}) as T;
  } catch (error) {
    const reason = cause(error as Error);
    if (reason === "tab") closedTab(tabId);
    if (reason === "cutoff") {
      if (await tabClosed(tabId)) closedTab(tabId);
      fail(
        "outcome_unknown",
        "the page navigated or the debugger detached during the command; observe before retrying",
      );
    }
    throw error;
  }
}
// Root sessions that report Page events. A navigation wait ends on the main
// frame's Page.frameStoppedLoading, the only report Chrome sends when a
// navigation commits no document, and element references expire on the main
// frame's Page.frameNavigated.
const pageEvents = new Set<number>();
export async function enablePageEvents(tabId: number): Promise<void> {
  if (pageEvents.has(tabId)) return;
  await sendRoot(tabId, "Page.enable");
  pageEvents.add(tabId);
}
// Page.disable sent through the cdp action also stops the events that expire
// element references, so the references go and the next snapshot or
// navigation enables Page events again.
export function pageEventsDisabled(tabId: number): void {
  pageEvents.delete(tabId);
  clearRefs(tabId);
}
export async function detach(tabId: number): Promise<void> {
  if (!attachments.has(tabId)) return;
  await chrome.debugger.detach({ tabId });
  attachments.delete(tabId);
  pageEvents.delete(tabId);
}
export function detached(tabId: number): void {
  attachments.delete(tabId);
  pageEvents.delete(tabId);
}
// A restarted worker inherits the extension's tab debugger sessions, including
// Fetch interception, but none of the state that answers paused requests.
// Detaching ends the root and flat child sessions and releases those requests;
// the next command attaches again, and a frame selection that the previous
// instance recorded for one of these tabs ends as lost.
export async function releaseInherited(tabIds: number[]): Promise<void> {
  if (!tabIds.length) return;
  const persisted = new Set(tabIds);
  for (const target of await chrome.debugger.getTargets()) {
    const tabId = target.tabId;
    if (tabId === undefined || !target.attached || !persisted.has(tabId)) continue;
    try {
      await chrome.debugger.detach({ tabId });
      forgetFrames(tabId);
      clearRefs(tabId);
    } catch (error) {
      // DevTools or another client can hold the tab; later attaches report it.
      console.error(`release inherited debugger session for tab ${tabId}`, String(error));
    }
  }
  await restoreLost(tabIds);
}

export type Remote = {
  type: string;
  value?: JsonObject | string | number | boolean | null;
  objectId?: string;
  description?: string;
};
type ExceptionDetails = { text: string; exception?: Remote };
// The first line of what a page script threw. V8 sets the text of a
// synchronous throw to "Uncaught"; the description of an Error starts with its
// name and message, followed by its stack.
function thrown(details: ExceptionDetails): string {
  return (details.exception?.description ?? details.text).split("\n", 1)[0] ?? details.text;
}
export async function evaluate<T>(
  tabId: number,
  expression: string,
  contextId?: number,
): Promise<T> {
  const selectedContext = contextId ?? scopes.get(tabId)?.contextId;
  const response = await send<{ result: Remote; exceptionDetails?: ExceptionDetails }>(
    tabId,
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      ...(selectedContext ? { contextId: selectedContext } : {}),
    },
  );
  if (response.exceptionDetails)
    fail(
      "evaluation_failed",
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
    );
  return response.result.value as T;
}

// Backend node ids are numbered per renderer process, so a reference also
// keeps the frame selection of its snapshot, whose session resolves it.
type Ref = { tabId: number; backendNodeId: number; scope: Scope | undefined };
const refs = new Map<string, Ref>();
const tabRefs = new Map<number, string[]>();
export function clearRefs(tabId: number): void {
  for (const key of tabRefs.get(tabId) ?? []) refs.delete(key);
  tabRefs.delete(tabId);
}
// References expire when their document is replaced. snapshot enables the root
// session's Page events, so the main frame's Page.frameNavigated reports each
// new main document, a reload included; tabs.onUpdated clears references when
// the tab's URL changes. Other frames loading or navigating leave every
// reference, including those from a snapshot of a selected frame: when that
// frame itself is replaced or removed, frames.ts ends the selection and node()
// rejects the references of the ended selection.
export function refEvent(
  tabId: number,
  method: string,
  params: JsonObject,
  sessionId?: string,
): void {
  if (method !== "Page.frameNavigated" && method !== "DOM.documentUpdated") return;
  const child = !!sessionId || !!(params.frame as { parentId?: string } | undefined)?.parentId;
  if (!child) clearRefs(tabId);
}
export function addRef(tabId: number, backendNodeId: number, key: string, scope?: Scope): void {
  refs.set(key, { tabId, backendNodeId, scope });
  const keys = tabRefs.get(tabId) ?? [];
  keys.push(key);
  tabRefs.set(tabId, keys);
}
// A node that went away during a command: the element of an @e reference left
// its document, or the element that a selector matched was removed.
function nodeGone(selector: string): never {
  if (selector.startsWith("@e"))
    fail("stale_ref", "element no longer exists; take a fresh snapshot");
  fail("element_missing", `no element matches ${selector}`);
}
// Sends a command about the element that selector names. A node or document
// that went away fails as nodeGone, an element that the command does not take
// fails with element_action_failed, and one without a layout box with
// element_hidden.
async function elementSend<T extends object>(
  tabId: number,
  selector: string,
  method: string,
  params: JsonObject,
): Promise<T> {
  try {
    return await send<T>(tabId, method, params);
  } catch (error) {
    const reason = cause(error as Error);
    if (reason === "node" || reason === "context") nodeGone(selector);
    if (reason === "refused") fail("element_action_failed", chromeMessage(error as Error));
    if (reason === "boxless") fail("element_hidden", "element has no layout box");
    throw error;
  }
}
// Sends a DOM command for the element that selector names, by its backend
// node id.
export async function nodeCommand<T extends object>(
  tabId: number,
  selector: string,
  method: string,
  params: JsonObject = {},
): Promise<T> {
  return elementSend<T>(tabId, selector, method, { ...params, ...(await node(tabId, selector)) });
}
// Releases a remote object. A navigation or a lost frame destroys its context,
// which releases it too, so the release is best effort and never replaces the
// result or the error of the command.
async function release(tabId: number, objectId: string): Promise<void> {
  try {
    await sendRoot(tabId, "Runtime.releaseObject", { objectId }, scopes.get(tabId)?.sessionId);
  } catch (error) {
    console.warn(`release a remote object of tab ${tabId}`, (error as Error).message);
  }
}
// Whether the node of an @e reference is still in its document. A removed
// element keeps its node until it is collected.
async function connected(tabId: number, selector: string, backendNodeId: number): Promise<boolean> {
  const { object } = await elementSend<{ object: Remote }>(tabId, selector, "DOM.resolveNode", {
    backendNodeId,
  });
  if (!object.objectId) nodeGone(selector);
  const objectId = object.objectId;
  try {
    const { result } = await elementSend<{ result: Remote }>(
      tabId,
      selector,
      "Runtime.callFunctionOn",
      { objectId, functionDeclaration: "function(){return this.isConnected}", returnByValue: true },
    );
    return !!result.value;
  } finally {
    await release(tabId, objectId);
  }
}
// Runs the locator for selector in the selected frame. A selector that the
// locator rejects, such as CSS with a syntax error, fails with invalid_args.
async function locate(tabId: number, selector: string, pick: "[0]" | ".length"): Promise<Remote> {
  const contextId = scopes.get(tabId)?.contextId;
  const found = await send<{ result: Remote; exceptionDetails?: ExceptionDetails }>(
    tabId,
    "Runtime.evaluate",
    {
      expression: `${locatorExpression(selector)}${pick}`,
      returnByValue: pick === ".length",
      ...(contextId ? { contextId } : {}),
    },
  );
  if (found.exceptionDetails) fail("invalid_args", thrown(found.exceptionDetails));
  return found.result;
}
export async function node(tabId: number, selector: string): Promise<{ backendNodeId: number }> {
  if (selector.startsWith("@e")) {
    const ref = refs.get(selector);
    const scope = scopes.get(tabId);
    if (
      !ref ||
      ref.tabId !== tabId ||
      ref.scope?.frameId !== scope?.frameId ||
      ref.scope?.sessionId !== scope?.sessionId
    )
      fail("stale_ref", "element reference expired; take a fresh snapshot");
    if (!(await connected(tabId, selector, ref.backendNodeId))) nodeGone(selector);
    return { backendNodeId: ref.backendNodeId };
  }
  if (selector.startsWith("role=")) {
    const nodes = await roleNodes(tabId, selector);
    if (!nodes[0]) fail("element_missing", `no element matches ${selector}`);
    return nodes[0];
  }
  const found = await locate(tabId, selector, "[0]");
  if (!found.objectId) fail("element_missing", `no element matches ${selector}`);
  const objectId = found.objectId;
  try {
    const detail = await elementSend<{ node: { backendNodeId: number } }>(
      tabId,
      selector,
      "DOM.describeNode",
      { objectId },
    );
    return { backendNodeId: detail.node.backendNodeId };
  } finally {
    await release(tabId, objectId);
  }
}
export async function roleNodes(
  tabId: number,
  selector: string,
): Promise<{ backendNodeId: number }[]> {
  const match = selector.match(/^role=([^[]+?)(?:\[name=(.+)\])?(?:\s*>>\s*nth=(-?\d+))?$/u);
  if (!match) fail("invalid_args", 'role syntax: role=button[name="Submit"] >>nth=0');
  let name: string | undefined;
  try {
    name = match[2] ? (JSON.parse(match[2]) as string) : undefined;
  } catch {
    fail("invalid_args", "role name must be a JSON string");
  }
  const result = await send<{
    nodes: {
      ignored: boolean;
      role?: { value: string };
      name?: { value: string };
      backendDOMNodeId?: number;
    }[];
  }>(
    tabId,
    "Accessibility.getFullAXTree",
    scopes.has(tabId) ? { frameId: scopes.get(tabId)!.frameId } : {},
  );
  const matches = result.nodes
    .filter(
      (n) =>
        !n.ignored &&
        n.role?.value === match[1] &&
        (name === undefined || n.name?.value === name) &&
        n.backendDOMNodeId,
    )
    .map((n) => ({ backendNodeId: n.backendDOMNodeId! }));
  if (match[3] === undefined) return matches;
  const selected = matches.at(Number(match[3]));
  return selected ? [selected] : [];
}
export async function countNodes(tabId: number, selector: string): Promise<number> {
  if (selector.startsWith("role=")) return (await roleNodes(tabId, selector)).length;
  if (selector.startsWith("@e")) {
    await node(tabId, selector);
    return 1;
  }
  return (await locate(tabId, selector, ".length")).value as number;
}
export async function object(tabId: number, selector: string): Promise<string> {
  const { object } = await nodeCommand<{ object: Remote }>(tabId, selector, "DOM.resolveNode");
  if (!object.objectId) nodeGone(selector);
  return object.objectId;
}
export async function onNode<T>(
  tabId: number,
  selector: string,
  functionDeclaration: string,
  args: (string | boolean)[] = [],
): Promise<T> {
  const objectId = await object(tabId, selector);
  try {
    const result = await elementSend<{ result: Remote; exceptionDetails?: ExceptionDetails }>(
      tabId,
      selector,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
    );
    if (result.exceptionDetails) fail("element_action_failed", thrown(result.exceptionDetails));
    return result.result.value as T;
  } finally {
    await release(tabId, objectId);
  }
}
