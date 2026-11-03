import { fail, type JsonObject } from "./protocol.js";
import { locatorExpression } from "./locators.js";
import { forgetFrames, scopes, selectedScope, type Scope } from "./frames.js";

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
        fail("debugger_unavailable", `attach tab ${tabId}: ${String(error)}`);
      }
    })();
    attachments.set(tabId, pending);
  }
  await pending;
}
export const attached = (tabId: number): boolean => attachments.has(tabId);
export async function send<T extends object>(
  tabId: number,
  method: string,
  params: JsonObject = {},
  sessionId?: string,
): Promise<T> {
  await attach(tabId);
  return sendRoot<T>(tabId, method, params, sessionId ?? selectedScope(tabId)?.sessionId);
}
export async function sendRoot<T extends object>(
  tabId: number,
  method: string,
  params: JsonObject = {},
  sessionId?: string,
): Promise<T> {
  await attach(tabId);
  return ((await chrome.debugger.sendCommand(
    { tabId, ...(sessionId ? { sessionId } : {}) },
    method,
    params,
  )) ?? {}) as T;
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
// the next command attaches again.
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
}

export type Remote = {
  type: string;
  value?: JsonObject | string | number | boolean | null;
  objectId?: string;
  description?: string;
};
export async function evaluate<T>(
  tabId: number,
  expression: string,
  contextId?: number,
): Promise<T> {
  const selectedContext = contextId ?? scopes.get(tabId)?.contextId;
  const response = await send<{
    result: Remote;
    exceptionDetails?: { text: string; exception?: Remote };
  }>(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    ...(selectedContext ? { contextId: selectedContext } : {}),
  });
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
    return { backendNodeId: ref.backendNodeId };
  }
  if (selector.startsWith("role=")) {
    const nodes = await roleNodes(tabId, selector);
    if (!nodes[0]) fail("element_missing", `no element matches ${selector}`);
    return nodes[0];
  }
  const found = await send<{ result: Remote; exceptionDetails?: { text: string } }>(
    tabId,
    "Runtime.evaluate",
    {
      expression: `${locatorExpression(selector)}[0]`,
      ...(scopes.has(tabId) ? { contextId: scopes.get(tabId)!.contextId } : {}),
    },
  );
  if (found.exceptionDetails) fail("invalid_args", found.exceptionDetails.text);
  if (!found.result.objectId) fail("element_missing", `no element matches ${selector}`);
  try {
    const detail = await send<{ node: { backendNodeId: number } }>(tabId, "DOM.describeNode", {
      objectId: found.result.objectId,
    });
    return { backendNodeId: detail.node.backendNodeId };
  } finally {
    await send(tabId, "Runtime.releaseObject", { objectId: found.result.objectId });
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
  return evaluate(tabId, `${locatorExpression(selector)}.length`);
}
export async function object(tabId: number, selector: string): Promise<string> {
  const result = await send<{ object: Remote }>(
    tabId,
    "DOM.resolveNode",
    await node(tabId, selector),
  );
  if (!result.object.objectId) fail("stale_ref", "element no longer exists");
  return result.object.objectId;
}
export async function onNode<T>(
  tabId: number,
  selector: string,
  functionDeclaration: string,
  args: (string | boolean)[] = [],
): Promise<T> {
  const objectId = await object(tabId, selector);
  try {
    const result = await send<{ result: Remote; exceptionDetails?: { text: string } }>(
      tabId,
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
    if (result.exceptionDetails) fail("element_action_failed", result.exceptionDetails.text);
    return result.result.value as T;
  } finally {
    await send(tabId, "Runtime.releaseObject", { objectId });
  }
}
