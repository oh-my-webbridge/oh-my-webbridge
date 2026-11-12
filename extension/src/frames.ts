import { fail, type JsonObject } from "./protocol.js";

export type Scope = { frameId: string; contextId: number; sessionId?: string };
export const scopes = new Map<number, Scope>();
// Tabs whose selected frame went away, with the report for the next command
// that would run in that frame; later commands use the main frame.
const lost = new Map<number, string>();
// Whether commands on tabId run in the top document with no pending report of a
// lost frame selection.
export const topDocument = (tabId: number): boolean => !scopes.has(tabId) && !lost.has(tabId);
// Tabs outside the top document, also kept in session storage: a restarted
// worker detaches the debugger sessions it inherits and reports their frame
// selections as lost (restoreLost).
const framed = new Set<number>();
let saving = Promise.resolve();
async function save(previous: Promise<void>): Promise<void> {
  await previous;
  try {
    await chrome.storage.session.set({ frames: [...framed] });
  } catch (error) {
    console.error("save frame selections", (error as Error).message);
  }
}
function track(tabId: number): void {
  const selected = !topDocument(tabId);
  if (selected === framed.has(tabId)) return;
  if (selected) framed.add(tabId);
  else framed.delete(tabId);
  saving = save(saving);
}
const children = new Map<number, Map<string, string>>();
const contexts = new Map<number, Map<string, Scope>>();
export function frameContext(tabId: number, frameId: string): Scope | undefined {
  return contexts.get(tabId)?.get(frameId);
}
export function frameTargets(tabId: number): string[] {
  return [...(children.get(tabId)?.values() ?? [])];
}
export function childSession(tabId: number, targetId: string): string | undefined {
  return children.get(tabId)?.get(targetId);
}
export function frameEvent(
  tabId: number,
  method: string,
  params: JsonObject,
  sessionId?: string,
): void {
  if (method === "Runtime.executionContextCreated") {
    const context = params.context as {
      id: number;
      auxData?: { frameId?: string; isDefault?: boolean };
    };
    if (context.auxData?.frameId && context.auxData.isDefault) {
      const scope = {
        frameId: context.auxData.frameId,
        contextId: context.id,
        ...(sessionId ? { sessionId } : {}),
      };
      const entries = contexts.get(tabId) ?? new Map<string, Scope>();
      entries.set(scope.frameId, scope);
      contexts.set(tabId, entries);
      // Chrome destroys a replaced document's context before it creates the new
      // one, and reports an existing context again, with its id, when Runtime is
      // enabled again. Another context for the selected frame is a new document.
      const selected = scopes.get(tabId);
      if (
        selected?.frameId === scope.frameId &&
        (selected.contextId !== scope.contextId || selected.sessionId !== scope.sessionId)
      )
        lose(tabId);
    }
  }
  if (
    method === "Runtime.executionContextsCleared" ||
    method === "Runtime.executionContextDestroyed" ||
    method === "Target.detachedFromTarget"
  ) {
    for (const [id, context] of contexts.get(tabId) ?? []) {
      if (
        method === "Runtime.executionContextDestroyed"
          ? context.contextId === params.executionContextId && context.sessionId === sessionId
          : context.sessionId ===
            (method === "Target.detachedFromTarget" ? params.sessionId : sessionId)
      ) {
        contexts.get(tabId)?.delete(id);
        if (scopes.get(tabId)?.frameId === id) lose(tabId);
      }
    }
  }
  if (method === "Target.attachedToTarget") {
    const info = params.targetInfo as { targetId: string };
    const sessions = children.get(tabId) ?? new Map<string, string>();
    if (typeof params.sessionId !== "string")
      fail("invalid_frame", "child sessionId is not a string");
    sessions.set(info.targetId, params.sessionId);
    children.set(tabId, sessions);
  }
  if (method === "Target.detachedFromTarget")
    for (const [target, session] of children.get(tabId) ?? [])
      if (session === params.sessionId) children.get(tabId)?.delete(target);
}
function lose(tabId: number, reason = "the selected frame navigated or was removed"): void {
  scopes.delete(tabId);
  lost.set(tabId, `${reason}; commands now use the main frame; select it again with frame`);
  track(tabId);
}
// Chrome ended the tab's debugger session (chrome.debugger.onDetach) or a
// restarted worker detached it. The next command attaches a new session, whose
// frames and execution contexts this module has not seen.
export function sessionEnded(tabId: number): void {
  lose(tabId, "the debugger session ended");
}
// Runs after a restarted worker detached the debugger sessions of tabIds,
// before any command. A recorded frame selection of these tabs ends as lost;
// the records of other tabs are dropped.
export async function restoreLost(tabIds: number[]): Promise<void> {
  const { frames = [] } = (await chrome.storage.session.get("frames")) as { frames?: number[] };
  for (const tabId of frames) if (tabIds.includes(tabId)) sessionEnded(tabId);
  if (frames.length !== framed.size) saving = save(saving);
}
// Runtime.disable sent through the cdp action stops the context events that
// report a replaced document. The session's contexts are forgotten and a frame
// selected in that session ends as lost; selecting a frame enables Runtime
// again and waits for its context.
export function runtimeDisabled(tabId: number, sessionId?: string): void {
  for (const [id, context] of contexts.get(tabId) ?? [])
    if (context.sessionId === sessionId) contexts.get(tabId)?.delete(id);
  const selected = scopes.get(tabId);
  if (selected && selected.sessionId === sessionId)
    lose(tabId, "Runtime was disabled in the selected frame's session");
}
// The frame that commands run in, undefined for the main frame. A selected
// frame that went away fails this call once.
export function selectedScope(tabId: number): Scope | undefined {
  const report = lost.get(tabId);
  if (report) {
    lost.delete(tabId);
    track(tabId);
    fail("frame_unavailable", report);
  }
  return scopes.get(tabId);
}
// A command sent to the selected frame scope found its flat session or its
// execution context gone before Chrome reported it. The selection ends as lost
// and the report fails the command; a selection that already ended reports
// itself the same way.
export function scopeGone(tabId: number, scope: Scope): void {
  if (scopes.get(tabId) === scope) lose(tabId);
  selectedScope(tabId);
}
// Selecting a frame after the selected one was lost starts from the main frame.
export function clearLost(tabId: number): void {
  lost.delete(tabId);
  track(tabId);
}
export function selectScope(tabId: number, scope: Scope): void {
  lost.delete(tabId);
  scopes.set(tabId, scope);
  track(tabId);
}
// Ends a frame selection, including the report of a lost one.
export function resetScope(tabId: number): void {
  lost.delete(tabId);
  scopes.delete(tabId);
  track(tabId);
}
export function forgetFrames(tabId: number): void {
  resetScope(tabId);
  children.delete(tabId);
  contexts.delete(tabId);
}
