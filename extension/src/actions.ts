import {
  configurePreset,
  clearPreset,
  forgetPreset,
  presetConfig,
  presetCurrent,
  presetStatus,
} from "./presets.js";
import {
  attach,
  clearRefs,
  countNodes,
  detach,
  detached,
  enablePageEvents,
  evaluate,
  node,
  onNode,
  pageEventsDisabled,
  send,
  sendRoot,
  rawEventTabs,
} from "./cdp.js";
import { actionTarget, releaseLayer } from "./activity.js";
import { feature, forgetObservations } from "./features.js";
import { forgetFrames, resetScope, runtimeDisabled, sessionEnded, topDocument } from "./frames.js";
import { snowflake } from "./id.js";
import { forget as forgetNetwork, network } from "./network.js";
import { fail, stringArg, type Args, type Command, type JsonObject } from "./protocol.js";
import { quadRect } from "./layer.js";
import { snapshot } from "./snapshot.js";
import {
  assertOwner,
  claim,
  getSession,
  persist,
  release,
  takePageClients,
  webTab,
  type Session,
} from "./state.js";

type Budget = { signal: AbortSignal; check: () => void };
const streams = new Map<string, { tabId: number; session: string; handle: string }>();
function forgetStreams(tabId: number): void {
  for (const [key, stream] of streams) if (stream.tabId === tabId) streams.delete(key);
}
// Drops what the worker keeps for a tab's debugger session: preset, streams,
// frame selection, network and console recordings, element references and the
// raw event subscription. Chrome reports a session it ends through
// chrome.debugger.onDetach, but not a detach the extension requests, so a
// released tab needs the same cleanup before another session uses it.
export function forgetTab(tabId: number): void {
  forgetPreset(tabId);
  forgetStreams(tabId);
  forgetFrames(tabId);
  forgetObservations(tabId);
  clearRefs(tabId);
  forgetNetwork(tabId);
  rawEventTabs.delete(tabId);
}
// Chrome ended the tab's debugger session: the user cancelled the debugging
// bar, DevTools took the tab, or the tab closed. The worker forgets the tab's
// state, and a frame selection, or the pending report of a lost one, is
// reported to the next command, which attaches a new session.
export function debuggerDetached(tabId: number): void {
  const selected = !topDocument(tabId);
  forgetTab(tabId);
  if (selected) sessionEnded(tabId);
}
// Chrome rejects a detach once the tab is gone ("No tab with given id 5.") or
// the debugger is no longer attached ("Debugger is not attached to the tab
// with id: 5."). Neither leaves a debugger session to end; other failures
// propagate.
async function detachIfAttached(tabId: number, label: string): Promise<void> {
  try {
    await detach(tabId);
  } catch (error) {
    const { message } = error as Error;
    if (
      !/^(No tab with given id|Debugger is not attached to the tab with id:) \d+\.$/u.test(message)
    )
      throw error;
    detached(tabId);
    console.warn(`${label} tab ${tabId}: ${message}`);
  }
}
// Releases the tabs of page CDP clients after the daemon connection that serves
// them has closed, since the daemon can no longer send their cdp_detach. The
// sessions are removed before the first await, so clients of the next
// connection can attach to the same tabs.
export async function releasePageClients(): Promise<void> {
  const tabs = takePageClients().flatMap((s) => [...s.tabs, ...s.borrowed]);
  if (!tabs.length) return;
  for (const tabId of tabs) forgetTab(tabId);
  try {
    await Promise.all(tabs.map((tabId) => detachIfAttached(tabId, "release page CDP client")));
  } finally {
    await persist();
  }
}

async function tabFor(name: string, s: Session, args: Args): Promise<number> {
  const tabId = args.tabId ?? args.tab ?? s.current;
  if (!tabId) fail("no_tab", "navigate or find_tab before using a page action");
  assertOwner(name, tabId);
  const tab = await chrome.tabs.get(tabId);
  if (!webTab(tab)) fail("restricted_tab", "only non-incognito HTTP(S) pages are supported");
  return tabId;
}
function validURL(value: string | undefined): string {
  const url = new URL(stringArg(value, "url"));
  if (!["http:", "https:"].includes(url.protocol) && url.href !== "about:blank")
    fail("invalid_args", "url must use HTTP(S) or about:blank");
  return url.href;
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new Error("request cancelled"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
// Resolves on the tab's next update, on a stopped load in its root session,
// after ms, or on cancellation. On a busy macOS host the worker's timers can
// lag by many seconds while another renderer spins; these events still arrive
// and end the wait.
function tabUpdate(
  tabId: number,
  ms: number,
  signal: AbortSignal,
): { next: Promise<void>; stop: () => void } {
  let stop = (): void => {};
  const next = new Promise<void>((resolve) => {
    const updated = (id: number): void => {
      if (id === tabId) stop();
    };
    const stopped = (source: chrome.debugger.DebuggerSession, method: string): void => {
      if (source.tabId === tabId && !source.sessionId && method === "Page.frameStoppedLoading")
        stop();
    };
    const timer = setTimeout(() => stop(), ms);
    stop = (): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.debugger.onEvent.removeListener(stopped);
      signal.removeEventListener("abort", stop);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(updated);
    chrome.debugger.onEvent.addListener(stopped);
    signal.addEventListener("abort", stop, { once: true });
  });
  return { next, stop };
}
type Navigation = {
  seen: (tab?: chrome.tabs.Tab) => void;
  started: () => boolean;
  stop: () => void;
};
// Navigates a tab and records once Chrome reports the navigation started: the
// tabs.update result carries it as the pending URL, and the root session as
// Page.frameStartedNavigating. Listening starts before the update, so a
// navigation that ends at once is still seen.
async function navigateTo(tabId: number, url: string): Promise<Navigation> {
  // Without Page events the wait still ends on tab state, read on each tab
  // update and poll.
  await enablePageEvents(tabId).catch((error: Error) =>
    console.warn(`page events for tab ${tabId}`, error.message),
  );
  let started = false;
  const seen = (tab?: chrome.tabs.Tab): void => {
    if (tab?.pendingUrl || tab?.status === "loading") started = true;
  };
  const updated = (id: number, _change: object, tab: chrome.tabs.Tab): void => {
    if (id === tabId) seen(tab);
  };
  const navigating = (
    source: chrome.debugger.DebuggerSession,
    method: string,
    params?: { url?: unknown },
  ): void => {
    if (
      source.tabId === tabId &&
      !source.sessionId &&
      method === "Page.frameStartedNavigating" &&
      params?.url === url
    )
      started = true;
  };
  const stop = (): void => {
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.debugger.onEvent.removeListener(navigating);
  };
  chrome.tabs.onUpdated.addListener(updated);
  chrome.debugger.onEvent.addListener(navigating);
  try {
    seen(await chrome.tabs.update(tabId, { url }));
  } catch (error) {
    stop();
    throw error;
  }
  return { seen, started: () => started, stop };
}
// A navigation ends when the tab is complete with no pending URL, once Chrome
// has reported it started or the tab shows a page other than about:blank. A
// download or a 204 No Content response ends it without a new document, so a
// new tab stays on about:blank. Chrome then sends no tab update; the main
// frame's Page.frameStoppedLoading wakes the wait, and the tab state read
// after it is final.
async function waitReady(tabId: number, budget: Budget, navigation?: Navigation): Promise<void> {
  for (;;) {
    budget.check();
    // Listen before reading so an update between the two is not missed.
    const update = tabUpdate(tabId, 50, budget.signal);
    try {
      const tab = await chrome.tabs.get(tabId);
      navigation?.seen(tab);
      if (
        tab.status === "complete" &&
        !tab.pendingUrl &&
        (!navigation || navigation.started() || (!!tab.url && tab.url !== "about:blank"))
      )
        return;
      await update.next;
    } finally {
      update.stop();
    }
  }
}
async function point(
  tabId: number,
  selector: string,
  action: string,
): Promise<{ x: number; y: number }> {
  await sendRoot(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
  try {
    await onNode(
      tabId,
      selector,
      `async function(){
      const before=this.getBoundingClientRect();
      this.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      const after=this.getBoundingClientRect();
      if(before.x!==after.x||before.y!==after.y)
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const r=this.getBoundingClientRect();
      const cx=(Math.max(0,r.left)+Math.min(r.right,innerWidth))/2;
      const cy=(Math.max(0,r.top)+Math.min(r.bottom,innerHeight))/2;
      const hit=this.getRootNode().elementFromPoint?.(cx,cy) ?? document.elementFromPoint(cx,cy);
      if(!r.width||!r.height||!hit||!(hit===this||this.contains(hit))) throw Error('element is hidden or covered');
      return true;
    }`,
    );
    const result = await send<{ quads: number[][] }>(
      tabId,
      "DOM.getContentQuads",
      await node(tabId, selector),
    );
    const quad = result.quads[0];
    if (!quad || quad.length !== 8) fail("element_hidden", "element has no content quad");
    const target = quadRect(tabId, quad);
    if (target) actionTarget(tabId, target, action);
    return {
      x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
      y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
    };
  } finally {
    await sendRoot(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
  }
}
async function mouse(
  tabId: number,
  type: string,
  p: { x: number; y: number },
  button = "left",
  buttons?: number,
): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", {
    type,
    ...p,
    button,
    ...(buttons === undefined ? {} : { buttons }),
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

export async function execute(command: Command, budget: Budget): Promise<object> {
  budget.check();
  const { action, session: name } = command;
  const args = command.args ?? {};
  if (action === "batch") {
    if (
      !args.steps?.length ||
      args.steps.length > 64 ||
      args.steps.some((step) =>
        [
          "batch",
          "close_session",
          "screenshot",
          "save_as_pdf",
          "artifact_read",
          "artifact_close",
        ].includes(step.action),
      )
    )
      fail(
        "invalid_args",
        "batch needs 1–64 non-nested steps; close sessions and create artifacts separately",
      );
    const results: object[] = [];
    for (const step of args.steps) {
      budget.check();
      results.push(await execute({ ...command, action: step.action, args: step.args }, budget));
    }
    return { results };
  }
  if (action === "locate") {
    if (
      ![
        "get",
        "is",
        "click",
        "dblclick",
        "fill",
        "check",
        "uncheck",
        "focus",
        "hover",
        "scroll",
        "key_type",
      ].includes(args.cmd ?? "get")
    )
      fail("invalid_args", "locate cmd must be an element action");
    const by = args.by ?? "css";
    let selector =
      by === "role"
        ? `role=${stringArg(args.value, "value")}${args.name ? `[name=${JSON.stringify(args.name)}]` : ""}`
        : `${by}=${stringArg(args.value, "value")}`;
    if (args.nth !== undefined) {
      if (!Number.isInteger(args.nth)) fail("invalid_args", "nth must be an integer");
      selector += ` >>nth=${args.nth}`;
    }
    return execute(
      {
        ...command,
        action: args.cmd ?? "get",
        args: { ...args, selector, value: args.text, property: args.property ?? "text" },
      },
      budget,
    );
  }
  if (action === "list_targets")
    return (await chrome.tabs.query({}))
      .filter(webTab)
      .map((tab) => ({ tabId: tab.id, url: tab.url, title: tab.title }));
  const s = await getSession(name);
  budget.check();
  if (action === "preset") {
    if (args.cmd !== undefined && args.cmd !== "status")
      fail("invalid_args", "preset cmd must be status or omitted");
    if (args.cmd === "status")
      return s.current ? presetStatus(s.current) : { config: s.preset ?? presetConfig() };
    const config = presetConfig(args, s.preset);
    for (const tabId of s.tabs) {
      budget.check();
      await attach(tabId);
      const tab = await chrome.tabs.get(tabId);
      budget.check();
      await configurePreset(tabId, config, tab.url ?? "about:blank");
    }
    budget.check();
    s.preset = config;
    await persist();
    return {
      config,
      tabs: s.tabs.map((tabId) => ({ tabId, ...presetStatus(tabId) })),
      appliesOn: "immediate; environment on next navigation",
      borrowedTabsExcluded: true,
    };
  }
  if (action === "switch_tab") {
    const tabId = args.tabId;
    if (!tabId) fail("invalid_args", "tabId required");
    assertOwner(name, tabId);
    const tab = await chrome.tabs.get(tabId);
    if (tab.discarded) {
      await chrome.tabs.reload(tabId);
      await waitReady(tabId, budget);
    }
    s.current = tabId;
    await persist();
    return { tabId, revived: !!tab.discarded };
  }
  if (action === "window_new") {
    if (s.tabs.length + s.borrowed.length >= 32) fail("busy", "32 tabs per session maximum");
    const url = validURL(args.url ?? "about:blank");
    const config = presetConfig(args, s.preset);
    const window = await chrome.windows.create({
      url: "about:blank",
      focused: false,
    });
    const tabId = window?.tabs?.[0]?.id;
    if (!tabId) fail("window_failed", "new window has no tab");
    try {
      budget.check();
      claim(name, s, tabId, false);
      // A restarted worker releases debugger sessions only on persisted tabs.
      await persist();
      budget.check();
      await attach(tabId);
      await configurePreset(tabId, config, url);
      if (s.settings) await feature("emulate", tabId, s.settings, budget);
      budget.check();
      const navigation = await navigateTo(tabId, url);
      try {
        // Session settings change only once the request has started navigating.
        s.preset = config;
        await waitReady(tabId, budget, navigation);
      } finally {
        navigation.stop();
      }
      s.group = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(s.group, { title: s.title, collapsed: true });
      await persist();
      await waitReady(tabId, budget);
      return { tabId, windowId: window?.id };
    } catch (error) {
      await chrome.tabs
        .remove(tabId)
        .catch((cause: Error) => console.warn("clean up new window", cause.message));
      throw error;
    }
  }
  if (action === "navigate") {
    const url = validURL(args.url ?? "about:blank");
    const config = presetConfig(args, s.preset);
    let tabId: number;
    let navigation: Navigation | undefined;
    if (args.newTab || !s.current) {
      if (s.tabs.length + s.borrowed.length >= 32) fail("busy", "32 tabs per session maximum");
      const tab = await chrome.tabs.create({
        url: "about:blank",
        active: false,
      });
      tabId = tab.id!;
      try {
        budget.check();
        claim(name, s, tabId, false);
        await persist();
        budget.check();
        // Establish the controller before the background tab can be frozen.
        await attach(tabId);
        await configurePreset(tabId, config, url);
        if (s.settings) await feature("emulate", tabId, s.settings, budget);
        budget.check();
        const opened = await navigateTo(tabId, url);
        try {
          s.preset = config;
          // A newly loading page must not enter an already collapsed group: Chrome
          // can defer its first renderer/navigation while the group is collapsed.
          await waitReady(tabId, budget, opened);
        } finally {
          opened.stop();
        }
        s.group = await chrome.tabs.group({
          tabIds: [tabId],
          ...(s.group === undefined ? {} : { groupId: s.group }),
        });
        s.title = args.group_title ?? s.title;
        await chrome.tabGroups.update(s.group, { title: s.title, collapsed: true });
      } catch (error) {
        await chrome.tabs
          .remove(tabId)
          .catch((cause: Error) => console.warn("clean up new navigation", cause.message));
        throw error;
      }
    } else {
      tabId = await tabFor(name, s, args);
      const owned = s.tabs.includes(tabId);
      if (owned) {
        await attach(tabId);
        budget.check();
        if (!presetCurrent(tabId, config)) await configurePreset(tabId, config, url);
      } else if (args.preset || args.zen || args.environment !== undefined) {
        fail("borrowed_tab", "presets apply only to task-owned tabs; open a new task tab");
      }
      clearRefs(tabId);
      resetScope(tabId);
      budget.check();
      navigation = await navigateTo(tabId, url);
      if (owned) s.preset = config;
    }
    try {
      budget.check();
      await persist();
      // A new tab has finished its navigation above; this waits for it to settle.
      await waitReady(tabId, budget, navigation);
    } finally {
      navigation?.stop();
    }
    return { success: true, tabId, url: (await chrome.tabs.get(tabId)).url };
  }
  if (action === "find_tab") {
    const query = stringArg(args.url, "url");
    const tabs = await chrome.tabs.query(
      args.active ? { active: true, lastFocusedWindow: true } : {},
    );
    const match = tabs.find((tab) => {
      if (
        !tab.id ||
        !webTab(tab) ||
        (!args.active && !s.tabs.includes(tab.id) && !s.borrowed.includes(tab.id))
      )
        return false;
      return tab.url === query || new URL(tab.url!).hostname === query;
    });
    if (!match?.id)
      fail(
        "tab_missing",
        "no matching tab in this session (active:true explicitly borrows the user's active tab)",
      );
    claim(name, s, match.id, !s.tabs.includes(match.id));
    await persist();
    return {
      success: true,
      tabId: match.id,
      url: match.url,
      borrowed: s.borrowed.includes(match.id),
    };
  }
  if (action === "cdp_attach") {
    const tabId = args.tabId;
    const previous = { borrowed: [...s.borrowed], current: s.current };
    let claimed = false;
    try {
      if (!tabId || !webTab(await chrome.tabs.get(tabId)))
        fail("restricted_tab", "normal HTTP(S) tab required");
      claim(name, s, tabId, true);
      claimed = true;
      await attach(tabId);
      // The daemon sends no cdp_detach for an attach that outlives the request
      // deadline or the daemon connection, so that attach must not keep the tab.
      budget.check();
    } catch (error) {
      s.borrowed = previous.borrowed;
      s.current = previous.current;
      // An unclaimed tab may belong to another session and stays attached.
      if (claimed && tabId) {
        await detach(tabId).catch((cause: Error) =>
          console.error(`detach tab ${tabId} after an unfinished page CDP attach`, cause.message),
        );
        forgetTab(tabId);
      }
      // Each page CDP connection has its own session, so a failed attach leaves none.
      if (!s.tabs.length && !s.borrowed.length) await release(name);
      else await persist();
      throw error;
    }
    await persist();
    rawEventTabs.add(tabId);
    return { attached: true };
  }
  if (action === "cdp_detach") {
    // A closed tab has already left the session through tabs.onRemoved; the
    // session still ends once it holds no other tab.
    const tabId = args.tabId ?? args.tab ?? s.current;
    if (tabId && (s.tabs.includes(tabId) || s.borrowed.includes(tabId))) {
      await clearPreset(tabId);
      // Chrome answers Page.close before it removes the tab, so the tab can
      // close while the client's disconnect is handled here.
      await detachIfAttached(tabId, "end page CDP client");
      forgetTab(tabId);
      s.tabs = s.tabs.filter((id) => id !== tabId);
      s.borrowed = s.borrowed.filter((id) => id !== tabId);
      if (s.current === tabId) s.current = s.tabs.at(-1) ?? s.borrowed.at(-1);
      if (!s.tabs.length) s.group = undefined;
    }
    if (s.tabs.length || s.borrowed.length) await persist();
    else await release(name);
    return { detached: true };
  }
  if (action === "list_tabs") {
    const tabs = (await chrome.tabs.query({})).filter(
      (t) => t.id && (s.tabs.includes(t.id) || s.borrowed.includes(t.id)),
    );
    return {
      success: true,
      tabs: tabs.map((t) => ({
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        borrowed: s.borrowed.includes(t.id!),
        groupTitle: s.title,
      })),
    };
  }
  if (action === "close_session") {
    const owned = [...s.tabs];
    for (const [key, stream] of streams)
      if (stream.session === name) {
        streams.delete(key);
        await sendRoot(stream.tabId, "IO.close", { handle: stream.handle });
      }
    for (const tabId of owned) {
      budget.check();
      await chrome.tabs.remove(tabId);
    }
    for (const tabId of s.borrowed) {
      await releaseLayer(tabId);
      await detach(tabId);
      forgetTab(tabId);
    }
    const closed = owned.length;
    await release(name);
    return { success: true, closed };
  }
  if (action === "artifact_read" || action === "artifact_close") {
    const handle = stringArg(args.handle, "handle");
    const stream = streams.get(handle);
    if (!stream || stream.session !== name)
      fail("invalid_args", "stream belongs to another session or is closed");
    assertOwner(name, stream.tabId);
    if (action === "artifact_close") {
      await sendRoot(stream.tabId, "IO.close", { handle: stream.handle });
      streams.delete(handle);
      return { closed: true };
    }
    return sendRoot(stream.tabId, "IO.read", { handle: stream.handle, size: 65536 });
  }
  const tabId = await tabFor(name, s, args);
  const extra = await feature(action, tabId, args, budget);
  if (extra !== undefined) {
    if (action === "emulate") {
      const previous = s.settings;
      const keys = [
        "width",
        "height",
        "deviceScaleFactor",
        "mobile",
        "colorScheme",
        "latitude",
        "longitude",
        "offline",
        "data",
      ] as const;
      const settings = Object.fromEntries(
        keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]),
      ) as Args;
      s.settings = { ...previous, ...settings };
      try {
        await persist();
      } catch (error) {
        s.settings = previous;
        throw error;
      }
    }
    return extra;
  }
  switch (action) {
    case "close_tab": {
      if (!s.tabs.includes(tabId))
        fail("borrowed_tab", "borrowed tabs are never closed; use close_session to release");
      await chrome.tabs.remove(tabId);
      return { success: true, closed: true };
    }
    case "cdp": {
      const method = stringArg(args.method, "method");
      const result = await sendRoot(tabId, method, args.params, args.sessionId);
      if (method === "Page.disable" && !args.sessionId) pageEventsDisabled(tabId);
      if (method === "Runtime.disable") runtimeDisabled(tabId, args.sessionId);
      return result;
    }
    case "evaluate":
      return {
        type: "value",
        value: await evaluate(tabId, stringArg(args.code, "code"), args.contextId),
      };
    case "snapshot":
      return {
        url: (await chrome.tabs.get(tabId)).url,
        title: (await chrome.tabs.get(tabId)).title,
        ...(await snapshot(tabId, args)),
      };
    case "read_page":
      return evaluate(
        tabId,
        "({url:location.href,title:document.title,text:document.body.innerText.slice(0,192000)})",
      );
    case "find": {
      const query = stringArg(args.query, "query").toLocaleLowerCase();
      const snap = await snapshot(tabId, args);
      return {
        matches: snap.tree
          .split("\n")
          .filter((line) => line.toLocaleLowerCase().includes(query))
          .slice(0, 100),
        truncated: snap.truncated,
      };
    }
    case "click":
    case "dblclick":
    case "mouse_click": {
      const p = args.selector
        ? await point(tabId, args.selector, action)
        : { x: args.x!, y: args.y! };
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
        fail("invalid_args", "selector or finite x/y coordinates required");
      budget.check();
      await mouse(tabId, "mousePressed", p, args.button);
      await mouse(tabId, "mouseReleased", p, args.button);
      if (action === "dblclick") {
        await send(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...p,
          button: args.button ?? "left",
          clickCount: 2,
        });
        await send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...p,
          button: args.button ?? "left",
          clickCount: 2,
        });
      }
      return { success: true };
    }
    case "hover": {
      const p = await point(tabId, stringArg(args.selector, "selector"), action);
      budget.check();
      await mouse(tabId, "mouseMoved", p, "none");
      return { success: true };
    }
    case "fill": {
      const selector = stringArg(args.selector, "selector");
      if (typeof args.value !== "string") fail("invalid_args", "value must be a string");
      await onNode(
        tabId,
        selector,
        `function(){this.focus();if(this.isContentEditable){const r=document.createRange();r.selectNodeContents(this);const s=getSelection();s.removeAllRanges();s.addRange(r);}else if(typeof this.select==='function'){this.select();}else{throw Error('element is not editable');}return true;}`,
      );
      budget.check();
      // Chrome emits trusted beforeinput/input; no synthetic JS value setter is needed.
      if (args.value === "") {
        await send(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
        await send(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
        });
      } else await send(tabId, "Input.insertText", { text: args.value });
      return { success: true };
    }
    case "key_type": {
      if (args.selector) await send(tabId, "DOM.focus", await node(tabId, args.selector));
      await send(tabId, "Input.insertText", { text: stringArg(args.text, "text") });
      return { success: true };
    }
    case "send_keys": {
      const key = stringArg(args.keys ?? args.key, "keys");
      const parts = key.split("+");
      const name = parts.at(-1)!;
      const modifiers = parts
        .slice(0, -1)
        .reduce((mask, part) => mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[part] ?? 0), 0);
      const codes: Record<string, number> = {
        Enter: 13,
        Tab: 9,
        Escape: 27,
        Backspace: 8,
        Delete: 46,
        ArrowLeft: 37,
        ArrowUp: 38,
        ArrowRight: 39,
        ArrowDown: 40,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34,
        Space: 32,
      };
      const vk = codes[name] ?? (name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0);
      if (!vk)
        fail(
          "invalid_args",
          "unsupported key name; use cdp Input.dispatchKeyEvent for advanced keys",
        );
      const params: JsonObject = {
        key: name === "Space" ? " " : name,
        windowsVirtualKeyCode: vk,
        modifiers,
      };
      await send(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        ...params,
        ...(name === "Enter" ? { text: "\r" } : {}),
      });
      await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
      return { success: true };
    }
    case "scroll": {
      if (args.selector)
        return onNode(
          tabId,
          args.selector,
          "function(){this.scrollIntoView({block:'center',behavior:'instant'});return {success:true};}",
        );
      const amount = args.amount ?? 600;
      if (!Number.isFinite(amount) || amount < 0 || amount > 100000)
        fail("invalid_args", "amount must be 0–100000");
      const direction = args.direction ?? "down";
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: args.x ?? 200,
        y: args.y ?? 200,
        deltaX: direction === "right" ? amount : direction === "left" ? -amount : 0,
        deltaY: direction === "down" ? amount : direction === "up" ? -amount : 0,
      });
      return { success: true };
    }
    case "select_option":
      return onNode(
        tabId,
        stringArg(args.selector, "selector"),
        `function(value){if(this.tagName!=='SELECT')throw Error('expected select');const o=Array.from(this.options).find(o=>o.value===value||o.text===value);if(!o)throw Error('option not found');this.value=o.value;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return {success:true,value:this.value};}`,
        [stringArg(args.value, "value")],
      );
    case "dialog":
      // A recovery command. Chrome answers the dialogs of every frame, including
      // cross-process ones, only through the tab's top-level session.
      await sendRoot(tabId, "Page.handleJavaScriptDialog", {
        accept: args.accept ?? false,
        ...(args.promptText === undefined ? {} : { promptText: args.promptText }),
      });
      return { success: true };
    case "drag": {
      const from = await point(tabId, stringArg(args.from, "from"), action);
      const to = await point(tabId, stringArg(args.to, "to"), action);
      budget.check();
      await mouse(tabId, "mouseMoved", from, "none");
      await mouse(tabId, "mousePressed", from);
      try {
        for (let step = 1; step <= 10; step++) {
          budget.check();
          await mouse(
            tabId,
            "mouseMoved",
            {
              x: from.x + ((to.x - from.x) * step) / 10,
              y: from.y + ((to.y - from.y) * step) / 10,
            },
            "left",
            1,
          );
        }
      } finally {
        await mouse(tabId, "mouseReleased", to);
      }
      return { success: true };
    }
    case "wait": {
      for (;;) {
        budget.check();
        let matched: boolean;
        if (args.selector) {
          matched = (await countNodes(tabId, args.selector)) > 0;
          if (matched)
            matched = await onNode<boolean>(
              tabId,
              args.selector,
              "function(){return !!this.getClientRects().length&&getComputedStyle(this).visibility!=='hidden'}",
            );
        } else if (args.expression) matched = !!(await evaluate(tabId, args.expression));
        else if (args.load)
          matched = await evaluate<boolean>(
            tabId,
            args.load === "load"
              ? "document.readyState==='complete'"
              : "document.readyState!=='loading'",
          );
        else if (args.text)
          matched = await evaluate<boolean>(
            tabId,
            `document.body.innerText.includes(${JSON.stringify(args.text)})`,
          );
        else if (args.url) {
          const pattern =
            "^" +
            args.url
              .split("*")
              .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
              .join(".*") +
            "$";
          matched = new RegExp(pattern, "u").test(await evaluate<string>(tabId, "location.href"));
        } else fail("invalid_args", "wait requires selector, expression, load, text or url");
        if (matched !== (args.state === "hidden")) return { success: true };
        await pause(75, budget.signal);
      }
    }
    case "network":
      return network(tabId, args.cmd, args.filter, args.requestId);
    case "upload": {
      if (
        !Array.isArray(args.files) ||
        !args.files.length ||
        args.files.some((file) => typeof file !== "string" || !file.startsWith("/"))
      )
        fail("invalid_args", "files must be non-empty absolute paths on Chrome's host");
      // Chrome answers DOM.setFileInputFiles with "Not allowed" unless the
      // extension's "Allow access to file URLs" switch is on, which it is not
      // by default for a store installation.
      if (!(await chrome.extension.isAllowedFileSchemeAccess()))
        fail(
          "file_access_required",
          'turn on "Allow access to file URLs" for oh-my-webbridge in chrome://extensions to upload local files',
        );
      await send(tabId, "DOM.setFileInputFiles", {
        files: args.files,
        ...(await node(tabId, stringArg(args.selector, "selector"))),
      });
      return { success: true, fileCount: args.files.length };
    }
    case "screenshot": {
      const format = args.format ?? "png";
      if (!["png", "jpeg"].includes(format)) fail("invalid_args", "format must be png or jpeg");
      if (
        args.quality !== undefined &&
        (!Number.isInteger(args.quality) || args.quality < 0 || args.quality > 100)
      )
        fail("invalid_args", "quality must be 0–100");
      let clip: JsonObject | undefined;
      if (args.selector)
        clip = await onNode(
          tabId,
          args.selector,
          "function(){const r=this.getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};}",
        );
      else if (args.fullPage) {
        const metrics = await send<{
          cssContentSize: { x: number; y: number; width: number; height: number };
        }>(tabId, "Page.getLayoutMetrics");
        clip = { ...metrics.cssContentSize, scale: 1 };
      }
      if (!clip) {
        const { cssVisualViewport: viewport } = await send<{
          cssVisualViewport: {
            pageX: number;
            pageY: number;
            clientWidth: number;
            clientHeight: number;
          };
        }>(tabId, "Page.getLayoutMetrics");
        clip = {
          x: viewport.pageX,
          y: viewport.pageY,
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          scale: 1,
        };
      }
      // Focus emulation requests rendering without activating a Chrome tab.
      // Release it immediately so idle task pages can be throttled normally.
      await sendRoot(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
      try {
        budget.check();
        const result = await sendRoot<{ data: string }>(tabId, "Page.captureScreenshot", {
          format,
          fromSurface: true,
          captureBeyondViewport: true,
          ...(format === "jpeg" && args.quality !== undefined ? { quality: args.quality } : {}),
          clip,
        });
        return { ...result, format, mimeType: `image/${format}` };
      } finally {
        await sendRoot(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false });
      }
    }
    case "save_as_pdf": {
      const sizes: Record<string, number[]> = {
        letter: [8.5, 11],
        legal: [8.5, 14],
        a4: [8.27, 11.69],
        a3: [11.69, 16.54],
        tabloid: [11, 17],
      };
      const size = sizes[args.paper_format ?? "letter"];
      if (!size) fail("invalid_args", "unsupported paper_format");
      const scale = args.scale ?? 1;
      if (scale < 0.1 || scale > 2) fail("invalid_args", "scale must be 0.1–2");
      const result = await sendRoot<{ stream: string }>(tabId, "Page.printToPDF", {
        transferMode: "ReturnAsStream",
        printBackground: args.print_background ?? true,
        landscape: args.landscape ?? false,
        scale,
        paperWidth: size[0]!,
        paperHeight: size[1]!,
        preferCSSPageSize: true,
      });
      const handle = snowflake();
      streams.set(handle, { tabId, session: name, handle: result.stream });
      return {
        stream: handle,
        mimeType: "application/pdf",
        pageTitle: (await chrome.tabs.get(tabId)).title,
      };
    }
    default:
      fail("invalid_args", `unsupported action: ${action}`);
  }
}
