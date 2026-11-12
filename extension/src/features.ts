import { evaluate, node, onNode, send, sendRoot, clearRefs, countNodes } from "./cdp.js";
import {
  childSession,
  clearLost,
  frameContext,
  frameTargets,
  resetScope,
  selectScope,
} from "./frames.js";
import { fail, pause, stringArg, type Args, type Budget, type JsonObject } from "./protocol.js";

const logs = new Map<number, { level: string; text: string; timestamp: number }[]>();
const dialogs = new Map<number, JsonObject>();
export function observe(tabId: number, method: string, params: JsonObject): void {
  if (method === "Page.javascriptDialogOpening") dialogs.set(tabId, params);
  if (method === "Page.javascriptDialogClosed") dialogs.delete(tabId);
  const buffer = logs.get(tabId);
  if (!buffer) return;
  if (method === "Runtime.consoleAPICalled") {
    const args = params.args as { value?: string | number | boolean; description?: string }[];
    buffer.push({
      level: typeof params.type === "string" ? params.type : "log",
      text: args
        .map((v) => JSON.stringify(v.value ?? v.description ?? ""))
        .join(" ")
        .slice(0, 8192),
      timestamp: Date.now(),
    });
  } else if (method === "Runtime.exceptionThrown")
    buffer.push({
      level: "error",
      text: JSON.stringify(params.exceptionDetails).slice(0, 8192),
      timestamp: Date.now(),
    });
  if (buffer.length > 200) buffer.splice(0, buffer.length - 200);
}
export function forgetObservations(tabId: number): void {
  logs.delete(tabId);
  dialogs.delete(tabId);
}
async function tick(budget: Budget): Promise<void> {
  budget.check();
  await pause(50, budget.signal);
}
export async function feature(
  action: string,
  tabId: number,
  args: Args,
  budget: Budget,
): Promise<object | undefined> {
  const selector = args.selector;
  switch (action) {
    case "get": {
      const property = args.property ?? "text";
      if (property === "title" || property === "url")
        return {
          value: await evaluate(tabId, property === "title" ? "document.title" : "location.href"),
        };
      if (property === "count")
        return {
          value: await countNodes(tabId, stringArg(selector, "selector")),
        };
      const value = await onNode(
        tabId,
        stringArg(selector, "selector"),
        `function(property,attribute){switch(property){case'text':return this.innerText??this.textContent;case'html':return this.innerHTML;case'value':return this.value??null;case'attr':return this.getAttribute(attribute);case'box':{const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}case'styles':return Object.fromEntries(Array.from(getComputedStyle(this)).map(k=>[k,getComputedStyle(this).getPropertyValue(k)]));default:throw Error('unsupported get property')}}`,
        [property, args.attribute ?? ""],
      );
      return { value };
    }
    case "is": {
      const property = args.property ?? "visible";
      if (!["visible", "enabled", "checked", "editable"].includes(property))
        fail("invalid_args", "unsupported state property");
      return {
        value: await onNode(
          tabId,
          stringArg(selector, "selector"),
          `function(p){if(p==='visible')return !!this.getClientRects().length&&getComputedStyle(this).visibility!=='hidden';if(p==='enabled')return !this.matches(':disabled,[aria-disabled=true]');if(p==='checked')return !!this.checked||this.getAttribute('aria-checked')==='true';return this.isContentEditable||(!this.readOnly&&!this.disabled&&('value'in this));}`,
          [property],
        ),
      };
    }
    case "focus":
      await send(tabId, "DOM.focus", await node(tabId, stringArg(selector, "selector")));
      return { success: true };
    case "check":
    case "uncheck": {
      const expected = action === "check";
      const state = await onNode<{ checked: boolean; kind: string }>(
        tabId,
        stringArg(selector, "selector"),
        "function(){return {checked:!!this.checked,kind:this.type}} ",
      );
      if (!["checkbox", "radio"].includes(state.kind) || (!expected && state.kind === "radio"))
        fail("invalid_args", "expected checkbox (radio supports check only)");
      if (state.checked !== expected) {
        await send(tabId, "DOM.focus", await node(tabId, selector!));
        await send(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: " ",
          code: "Space",
          windowsVirtualKeyCode: 32,
          text: " ",
        });
        await send(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: " ",
          code: "Space",
          windowsVirtualKeyCode: 32,
        });
      }
      if (
        (await onNode<boolean>(tabId, selector!, "function(){return !!this.checked}")) !== expected
      )
        fail("state_mismatch", "control did not reach requested checked state");
      return { success: true, checked: expected };
    }
    case "history": {
      resetScope(tabId);
      clearRefs(tabId);
      if (args.cmd === "reload") {
        await sendRoot(tabId, "Page.reload", { ignoreCache: false });
        return { success: true };
      }
      const history = await sendRoot<{
        currentIndex: number;
        entries: { id: number; url: string; title: string }[];
      }>(tabId, "Page.getNavigationHistory");
      const entry =
        history.entries[
          history.currentIndex + (args.cmd === "back" ? -1 : args.cmd === "forward" ? 1 : 0)
        ];
      if (args.cmd === "list" || !args.cmd) return history;
      if (!["back", "forward"].includes(args.cmd))
        fail("invalid_args", "history cmd must be list/back/forward/reload");
      if (!entry) fail("history_missing", "no navigation entry in that direction");
      await sendRoot(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
      return { success: true, url: entry.url };
    }
    case "keyboard": {
      if (args.cmd === "insertText") {
        if (typeof args.text !== "string") fail("invalid_args", "text must be a string");
        await send(tabId, "Input.insertText", { text: args.text });
        return { success: true };
      }
      if (!["down", "up"].includes(args.cmd ?? ""))
        fail("invalid_args", "keyboard cmd must be down/up/insertText");
      const key = stringArg(args.key ?? args.keys, "key");
      const codes: Record<string, number> = {
        Enter: 13,
        Tab: 9,
        Escape: 27,
        Backspace: 8,
        Delete: 46,
        ArrowLeft: 37,
        ArrowRight: 39,
        ArrowUp: 38,
        ArrowDown: 40,
        Shift: 16,
        Control: 17,
        Alt: 18,
        Meta: 91,
      };
      await send(tabId, "Input.dispatchKeyEvent", {
        type: args.cmd === "down" ? "keyDown" : "keyUp",
        key,
        windowsVirtualKeyCode: codes[key] ?? key.toUpperCase().charCodeAt(0),
      });
      return { success: true };
    }
    case "mouse": {
      if (!["move", "down", "up", "wheel"].includes(args.cmd ?? ""))
        fail("invalid_args", "mouse cmd must be move/down/up/wheel");
      await sendRoot(tabId, "Input.dispatchMouseEvent", {
        type:
          args.cmd === "move"
            ? "mouseMoved"
            : args.cmd === "down"
              ? "mousePressed"
              : args.cmd === "up"
                ? "mouseReleased"
                : "mouseWheel",
        x: args.x ?? 0,
        y: args.y ?? 0,
        button: args.cmd === "move" ? "none" : (args.button ?? "left"),
        clickCount: args.cmd === "down" || args.cmd === "up" ? 1 : 0,
        ...(args.cmd === "wheel" ? { deltaY: args.amount ?? 100, deltaX: 0 } : {}),
      });
      return { success: true };
    }
    case "emulate": {
      if (args.width !== undefined || args.height !== undefined) {
        if (
          !args.width ||
          !args.height ||
          args.width > 16384 ||
          args.height > 16384 ||
          args.width < 1 ||
          args.height < 1
        )
          fail("invalid_args", "width/height must be 1–16384");
        await sendRoot(tabId, "Emulation.setDeviceMetricsOverride", {
          width: args.width,
          height: args.height,
          deviceScaleFactor: args.deviceScaleFactor ?? 1,
          mobile: args.mobile ?? false,
        });
      }
      if (args.colorScheme)
        await sendRoot(tabId, "Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: args.colorScheme }],
        });
      if (args.latitude !== undefined && args.longitude !== undefined)
        await sendRoot(tabId, "Emulation.setGeolocationOverride", {
          latitude: args.latitude,
          longitude: args.longitude,
          accuracy: 1,
        });
      if (args.offline !== undefined) {
        const conditions = {
          offline: args.offline,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        };
        await sendRoot(tabId, "Network.emulateNetworkConditionsByRule", {
          matchedNetworkConditions: [{ urlPattern: "", ...conditions }],
        });
        await sendRoot(tabId, "Network.overrideNetworkState", conditions);
      }
      if (args.data) {
        const entries = Object.entries(args.data);
        if (
          entries.length > 128 ||
          entries.some(
            ([key, value]) =>
              /[\r\n]/u.test(key) || typeof value !== "string" || /[\r\n]/u.test(value),
          ) ||
          JSON.stringify(args.data).length > 32768
        )
          fail(
            "invalid_args",
            "headers must be at most 128 string values / 32 KiB without CR or LF",
          );
        await sendRoot(tabId, "Network.setExtraHTTPHeaders", { headers: args.data });
      }
      return { success: true };
    }
    case "cookies": {
      const url = await evaluate<string>(tabId, "location.href");
      if (args.cmd === "set") {
        return send(tabId, "Network.setCookie", { ...args.data, url });
      }
      const result = await send<{
        cookies: { name: string; value: string; domain: string; path: string }[];
      }>(tabId, "Network.getCookies", { urls: [url] });
      if (args.cmd === "clear") {
        for (const cookie of result.cookies)
          await send(tabId, "Network.deleteCookies", {
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path,
          });
        return { success: true };
      }
      if (args.cmd === "delete") {
        await send(tabId, "Network.deleteCookies", { name: stringArg(args.name, "name"), url });
        return { success: true };
      }
      if (args.cmd && args.cmd !== "list")
        fail("invalid_args", "cookies cmd must be list/set/delete/clear");
      return result;
    }
    case "storage": {
      const result = await evaluate(
        tabId,
        `(() => {
        const storage = ${args.kind === "session" ? "sessionStorage" : "localStorage"};
        const cmd = ${JSON.stringify(args.cmd ?? "list")};
        const name = ${JSON.stringify(args.name ?? "")};
        if (cmd === "set") storage.setItem(name, ${JSON.stringify(args.value ?? "")});
        else if (cmd === "remove") storage.removeItem(name);
        else if (cmd === "clear") storage.clear();
        else if (!['list','get'].includes(cmd)) throw Error('storage cmd must be list/get/set/remove/clear');
        return {origin: location.origin, kind: ${JSON.stringify(args.kind ?? "local")}, value: cmd === 'get' ? storage.getItem(name) : Object.fromEntries(Array.from({length:storage.length},(_,i)=>{const key=storage.key(i);return [key,storage.getItem(key)]}))};
      })()`,
      );
      return result as object;
    }
    case "console": {
      if (args.cmd === "start") {
        logs.set(tabId, []);
        await sendRoot(tabId, "Runtime.enable");
        return { recording: true };
      }
      if (args.cmd === "stop") {
        logs.delete(tabId);
        return { recording: false };
      }
      if (args.cmd === "clear") logs.set(tabId, []);
      return { entries: logs.get(tabId) ?? [] };
    }
    case "dialog_status":
      return { dialog: dialogs.get(tabId) ?? null };
    case "frame": {
      if (args.selector === "main" || args.cmd === "main") {
        resetScope(tabId);
        clearRefs(tabId);
        return { frame: "main" };
      }
      type Frame = { frame: { id: string; name?: string; url: string }; childFrames?: Frame[] };
      const root = await sendRoot<{ frameTree: Frame }>(tabId, "Page.getFrameTree");
      const frames: Frame[] = [];
      const visit = (f: Frame): void => {
        frames.push(f);
        for (const child of f.childFrames ?? []) visit(child);
      };
      visit(root.frameTree);
      for (const sessionId of frameTargets(tabId)) {
        const child = await sendRoot<{ frameTree: Frame }>(
          tabId,
          "Page.getFrameTree",
          {},
          sessionId,
        );
        visit(child.frameTree);
      }
      const unique = new Map(frames.map((f) => [f.frame.id, f]));
      frames.splice(0, frames.length, ...unique.values());
      if (args.cmd === "list") return { frames: frames.map((f) => f.frame) };
      // A selector is resolved in the selected frame, or in the main frame once
      // the selected one is lost.
      clearLost(tabId);
      let frameId = args.frameId;
      if (args.selector) {
        const found = await send<{ node: { frameId?: string } }>(tabId, "DOM.describeNode", {
          ...(await node(tabId, args.selector)),
          depth: 1,
          pierce: true,
        });
        frameId = found.node.frameId;
      }
      frameId ??= frames.find(
        (f) => (args.name && f.frame.name === args.name) || (args.url && f.frame.url === args.url),
      )?.frame.id;
      if (!frameId) fail("frame_missing", "select frame by selector/frameId/name/url");
      const sessionId = childSession(tabId, frameId);
      await sendRoot(tabId, "Runtime.enable", {}, sessionId);
      let context = frameContext(tabId, frameId);
      for (let attempt = 0; !context && attempt < 20; attempt++) {
        await tick(budget);
        context = frameContext(tabId, frameId);
      }
      if (!context)
        fail("frame_unavailable", "frame has no default execution context; retry after it loads");
      selectScope(tabId, context);
      clearRefs(tabId);
      return { ...context };
    }
    case "download": {
      const url = new URL(
        stringArg(args.url, "url"),
        await evaluate<string>(tabId, "location.href"),
      );
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
          await tick(budget);
        }
      } catch (error) {
        await chrome.downloads.cancel(id);
        throw error;
      }
    }
  }
  return undefined;
}
