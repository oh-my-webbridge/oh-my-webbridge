import { releaseLayer } from "../activity.js";
import type { Budget } from "../bridge.js";
import { presetConfig, type Preset } from "../filters.js";
import {
  fail,
  fault,
  stringArg,
  type Args,
  type Command,
  type Json,
  type JsonObject,
} from "../protocol.js";
import {
  assertOwner,
  claim,
  getSession,
  persist,
  release,
  webTab,
  type Session,
} from "../state.js";
import { requireSiteAccess } from "./access.js";
import { cookies } from "./cookies.js";
import { forgetHeaders, setExtraHeaders } from "./headers.js";
import { callPage, clearRefs, evaluate, resetScope, scopeOf, selectFrame } from "./inject.js";
import { createBlank, load, pause, reload, traverse } from "./navigation.js";
import { forgetNetwork, network } from "./network.js";
import type { PageArgs, PageFile } from "./page-api.js";
import { configurePreset, forgetPreset, presetCurrent, presetStatus } from "./presets.js";

// Actions Firefox extensions cannot perform, with the reason reported to callers.
const unavailable: Record<string, string> = {
  save_as_pdf: "tabs.saveAsPDF opens a save dialog and returns no PDF bytes",
  dialog: "extensions cannot answer alert, confirm or prompt dialogs",
  drag: "extension pointer events are untrusted and do not start HTML drag and drop",
  mouse: "extension pointer events are untrusted; low-level mouse input needs browser input",
  console: "extensions cannot observe page console messages",
  cdp: "Firefox has no Chrome DevTools Protocol",
  cdp_attach: "Firefox has no Chrome DevTools Protocol",
  cdp_detach: "Firefox has no Chrome DevTools Protocol",
  list_targets: "Firefox has no Chrome DevTools Protocol targets",
  artifact_read: "Firefox actions return no artifact streams",
  artifact_close: "Firefox actions return no artifact streams",
};
// Element actions that page.js performs in the selected frame.
const pageActions = new Set([
  "read_page",
  "find",
  "locate",
  "get",
  "is",
  "focus",
  "check",
  "uncheck",
  "select_option",
  "storage",
  "fill",
  "key_type",
  "send_keys",
  "click",
  "dblclick",
  "mouse_click",
  "hover",
  "scroll",
]);
const emulation = [
  "width",
  "height",
  "deviceScaleFactor",
  "mobile",
  "colorScheme",
  "latitude",
  "longitude",
  "offline",
] as const;
function unsupported(what: string, reason: string): never {
  fail("unsupported", `${what} is not available in Firefox: ${reason}`);
}
function record(value: Json, op: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("browser_error", `${op}: page returned ${JSON.stringify(value)}`);
  return value;
}
function numberOf(value: JsonObject, key: string, op: string): number {
  const found = value[key];
  if (typeof found !== "number" || !Number.isFinite(found))
    fail("browser_error", `${op}: page returned no numeric ${key}`);
  return found;
}
function pageArgs(args: Args): PageArgs {
  const { files: _files, ...rest } = args;
  return rest;
}
// The daemon replaces upload paths with file contents for Firefox.
function uploads(files: Args["files"]): PageFile[] {
  if (!Array.isArray(files) || !files.length)
    fail("invalid_args", "files must be a non-empty list");
  const result: PageFile[] = [];
  for (const file of files) {
    if (typeof file === "string")
      fail("invalid_args", `Firefox receives file contents from the daemon, not the path ${file}`);
    result.push(file);
  }
  return result;
}
export function forgetTab(tabId: number): void {
  forgetPreset(tabId);
  forgetNetwork(tabId);
  forgetHeaders(tabId);
  resetScope(tabId);
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
// URL of the selected frame's document, or of the tab. The selected document
// reports its own URL, so once it is replaced or removed the call fails with
// frame_unavailable and later commands use the main frame, as page actions do.
async function frameUrl(tabId: number): Promise<string> {
  if (!scopeOf(tabId)) return stringArg((await chrome.tabs.get(tabId)).url, "tab url");
  const { value } = record(await callPage(tabId, "get", { property: "url" }), "frame url");
  if (typeof value !== "string") fail("browser_error", "frame url: the page returned no URL");
  return value;
}
// Resolves the frame that selector names, in the selected frame or, once that
// frame navigated or was removed, in the main frame.
async function frameOf(tabId: number, selector: string): Promise<number> {
  const find = async () =>
    numberOf(record(await callPage(tabId, "frame", { selector }), "frame"), "frameId", "frame");
  try {
    return await find();
  } catch (error) {
    if (fault(error as Error).code !== "frame_unavailable" || scopeOf(tabId)) throw error;
    return find();
  }
}
// Clears the element references of the selected frame before another frame
// is selected. A frame that is already gone took its references with it.
async function leaveFrame(tabId: number): Promise<void> {
  try {
    await clearRefs(tabId);
  } catch (error) {
    if (fault(error as Error).code !== "frame_unavailable") throw error;
  }
  resetScope(tabId);
}
// Takes a new task tab, filters it and loads url in it once the tab's own
// about:blank document has loaded.
async function open(
  name: string,
  s: Session,
  tabId: number,
  blank: (budget: Budget) => Promise<void>,
  url: string,
  config: Preset,
  budget: Budget,
): Promise<void> {
  budget.check();
  claim(name, s, tabId, false);
  await persist();
  budget.check();
  await configurePreset(tabId, config);
  if (s.settings?.data) setExtraHeaders(tabId, s.settings.data);
  await blank(budget);
  budget.check();
  // Session settings change only once the request has started navigating.
  await load(tabId, url, budget, () => {
    s.preset = config;
  });
}

export async function execute(command: Command, budget: Budget): Promise<object> {
  budget.check();
  const { action, session: name } = command;
  const args = command.args ?? {};
  const reason = unavailable[action];
  if (reason) unsupported(action, reason);
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
      await chrome.tabs.get(tabId);
      budget.check();
      await configurePreset(tabId, config);
    }
    budget.check();
    s.preset = config;
    await persist();
    return {
      config,
      tabs: s.tabs.map((tabId) => ({ tabId, ...presetStatus(tabId) })),
      appliesOn: "immediate",
      borrowedTabsExcluded: true,
    };
  }
  if (action === "switch_tab") {
    const tabId = args.tabId;
    if (!tabId) fail("invalid_args", "tabId required");
    assertOwner(name, tabId);
    const tab = await chrome.tabs.get(tabId);
    if (tab.discarded) {
      await reload(tabId, budget);
    }
    s.current = tabId;
    await persist();
    return { tabId, revived: !!tab.discarded };
  }
  if (action === "window_new") {
    if (s.tabs.length + s.borrowed.length >= 32) fail("busy", "32 tabs per session maximum");
    const url = validURL(args.url ?? "about:blank");
    const config = presetConfig(args, s.preset);
    // Firefox focuses the new window; windows.create ignores focused:false.
    const blank = await createBlank(
      () => chrome.windows.create({ url: "about:blank", focused: false }),
      (created) => created?.tabs?.[0]?.id,
      ["window_failed", "new window has no tab"],
      budget,
    );
    const { tabId } = blank;
    try {
      await open(name, s, tabId, blank.loaded, url, config, budget);
      s.group = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(s.group, { title: s.title, collapsed: true });
      await persist();
      return { tabId, windowId: blank.created?.id };
    } catch (error) {
      await chrome.tabs
        .remove(tabId)
        .catch((cause: Error) => console.warn("clean up new window", cause.message));
      throw error;
    } finally {
      blank.dispose();
    }
  }
  if (action === "navigate") {
    const url = validURL(args.url ?? "about:blank");
    const config = presetConfig(args, s.preset);
    let tabId: number;
    if (args.newTab || !s.current) {
      if (s.tabs.length + s.borrowed.length >= 32) fail("busy", "32 tabs per session maximum");
      const blank = await createBlank(
        () => chrome.tabs.create({ url: "about:blank", active: false }),
        (created) => created.id,
        ["browser_error", "new tab has no id"],
        budget,
      );
      tabId = blank.tabId;
      try {
        await open(name, s, tabId, blank.loaded, url, config, budget);
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
        budget.check();
        if (!presetCurrent(tabId, config)) await configurePreset(tabId, config);
      } else if (args.preset || args.zen || args.environment !== undefined) {
        fail("borrowed_tab", "presets apply only to task-owned tabs; open a new task tab");
      }
      resetScope(tabId);
      budget.check();
      await load(tabId, url, budget, () => {
        if (owned) s.preset = config;
      });
    }
    budget.check();
    await persist();
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
    for (const tabId of owned) {
      budget.check();
      await chrome.tabs.remove(tabId);
    }
    // Borrowed tabs stay open; only the session's recording, headers and
    // activity layer end.
    for (const tabId of s.borrowed) {
      await releaseLayer(tabId);
      forgetTab(tabId);
    }
    await release(name);
    return { success: true, closed: owned.length };
  }
  const tabId = await tabFor(name, s, args);
  if (pageActions.has(action)) return record(await callPage(tabId, action, pageArgs(args)), action);
  switch (action) {
    case "close_tab": {
      if (!s.tabs.includes(tabId))
        fail("borrowed_tab", "borrowed tabs are never closed; use close_session to release");
      await chrome.tabs.remove(tabId);
      return { success: true, closed: true };
    }
    case "snapshot": {
      const tab = await chrome.tabs.get(tabId);
      return {
        url: tab.url,
        title: tab.title,
        ...record(await callPage(tabId, "snapshot", pageArgs(args)), action),
      };
    }
    case "evaluate":
      if (args.contextId !== undefined)
        unsupported("evaluate contextId", "select the frame with the frame action instead");
      return { type: "value", value: await evaluate(tabId, stringArg(args.code, "code")) };
    case "wait": {
      for (;;) {
        budget.check();
        const matched =
          !args.selector && args.expression
            ? !!(await evaluate(tabId, args.expression))
            : record(await callPage(tabId, "wait", pageArgs(args)), action).matched === true;
        if (matched !== (args.state === "hidden")) return { success: true };
        await pause(75, budget.signal);
      }
    }
    case "keyboard": {
      if (args.cmd === "insertText") {
        if (typeof args.text !== "string") fail("invalid_args", "text must be a string");
        if (args.text) await callPage(tabId, "key_type", { text: args.text });
        return { success: true };
      }
      if (args.cmd === "down" || args.cmd === "up")
        unsupported(
          `keyboard ${args.cmd}`,
          "extension key events are untrusted and have no default action",
        );
      fail("invalid_args", "keyboard cmd must be down/up/insertText");
    }
    case "history": {
      const cmd = args.cmd ?? "list";
      if (cmd === "reload") {
        resetScope(tabId);
        await chrome.tabs.reload(tabId);
        return { success: true };
      }
      if (cmd === "list")
        unsupported("history list", "extensions cannot read a tab's session history entries");
      if (cmd !== "back" && cmd !== "forward")
        fail("invalid_args", "history cmd must be list/back/forward/reload");
      resetScope(tabId);
      return { success: true, url: await traverse(tabId, cmd, budget) };
    }
    case "emulate": {
      const fields = emulation.filter((key) => args[key] !== undefined);
      if (fields.length)
        unsupported(
          `emulate ${fields.join(", ")}`,
          "Firefox extensions can only add request headers (data)",
        );
      if (args.data) {
        setExtraHeaders(tabId, args.data);
        const previous = s.settings;
        s.settings = { ...previous, data: args.data };
        try {
          await persist();
        } catch (error) {
          s.settings = previous;
          throw error;
        }
      }
      return { success: true };
    }
    case "dialog_status": {
      // Firefox only marks that a tab shows a modal dialog, without its kind or text.
      const tab = await chrome.tabs.get(tabId);
      return { dialog: tab.attention ? { url: tab.url } : null };
    }
    case "frame": {
      if (args.selector === "main" || args.cmd === "main") {
        await leaveFrame(tabId);
        return { frame: "main" };
      }
      const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
      if (args.cmd === "list")
        return {
          frames: frames.map((f) => ({
            id: String(f.frameId),
            ...(f.parentFrameId >= 0 ? { parentId: String(f.parentFrameId) } : {}),
            url: f.url,
          })),
        };
      let frameId: number | undefined;
      if (args.selector) frameId = await frameOf(tabId, args.selector);
      else if (args.frameId !== undefined)
        frameId = frames.find((f) => String(f.frameId) === args.frameId)?.frameId;
      else if (args.name) {
        const name = CSS.escape(args.name);
        frameId = await frameOf(tabId, `iframe[name="${name}"], frame[name="${name}"]`);
      } else if (args.url) frameId = frames.find((f) => f.url === args.url)?.frameId;
      if (frameId === undefined) fail("frame_missing", "select frame by selector/frameId/name/url");
      await leaveFrame(tabId);
      await selectFrame(tabId, frameId);
      return { frameId: String(frameId) };
    }
    case "cookies":
      // Without site access cookies.getAll answers with an empty list.
      await requireSiteAccess(action);
      return cookies(await frameUrl(tabId), args);
    case "download": {
      const url = new URL(stringArg(args.url, "url"), await frameUrl(tabId));
      if (!["http:", "https:"].includes(url.protocol))
        fail("invalid_args", "download URL must use HTTP(S)");
      const id = await chrome.downloads.download({
        url: url.href,
        saveAs: false,
        ...(args.filename ? { filename: args.filename } : {}),
      });
      try {
        for (;;) {
          budget.check();
          const item = (await chrome.downloads.search({ id }))[0];
          if (!item) fail("download_missing", "download disappeared");
          if (item.state === "complete")
            return { path: item.filename, sizeBytes: item.fileSize, mimeType: item.mime, id };
          if (item.state === "interrupted") fail("download_failed", item.error ?? "interrupted");
          await pause(50, budget.signal);
        }
      } catch (error) {
        await chrome.downloads.cancel(id);
        throw error;
      }
    }
    case "network":
      return network(tabId, args.cmd, args.filter, args.requestId);
    case "upload":
      return record(
        await callPage(tabId, "upload", {
          selector: stringArg(args.selector, "selector"),
          files: uploads(args.files),
        }),
        action,
      );
    case "screenshot": {
      const format = args.format ?? "png";
      if (!["png", "jpeg"].includes(format)) fail("invalid_args", "format must be png or jpeg");
      if (
        args.quality !== undefined &&
        (!Number.isInteger(args.quality) || args.quality < 0 || args.quality > 100)
      )
        fail("invalid_args", "quality must be 0–100");
      await requireSiteAccess(action);
      // captureTab takes a rectangle of the top-level document, and page.js
      // measures in the document it runs in.
      if ((args.selector || args.fullPage) && scopeOf(tabId))
        unsupported(
          "screenshot of an element or full page in a selected frame",
          "select the main frame first",
        );
      let rect: chrome.tabs.CaptureTabOptions["rect"];
      if (args.selector || args.fullPage) {
        const box = record(
          await callPage(tabId, "rect", {
            ...(args.selector ? { selector: args.selector } : {}),
            ...(args.fullPage ? { fullPage: true } : {}),
          }),
          action,
        );
        rect = {
          x: numberOf(box, "x", action),
          y: numberOf(box, "y", action),
          width: numberOf(box, "width", action),
          height: numberOf(box, "height", action),
        };
      }
      // Without a rectangle, captureTab takes the visible viewport.
      const image = await chrome.tabs.captureTab(tabId, {
        format,
        ...(format === "jpeg" && args.quality !== undefined ? { quality: args.quality } : {}),
        ...(rect ? { rect } : {}),
      });
      return { data: image.slice(image.indexOf(",") + 1), format, mimeType: `image/${format}` };
    }
    default:
      fail("invalid_args", `unsupported action: ${action}`);
  }
}
