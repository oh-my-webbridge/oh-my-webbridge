import { Request, type RequestType } from "@ghostery/adblocker";
import { type JsonObject } from "./protocol.js";
import { frameTargets } from "./frames.js";
import { engine, forgetEngine, releaseEngineWhenIdle, type Preset } from "./filters.js";

export { presetConfig, type Preset } from "./filters.js";
type Target = { ready: boolean; installation: Promise<void>; cleanup?: Promise<void> };
type Frame = { url: string; parentId?: string };
type FrameTree = { frame: Frame & { id: string }; childFrames?: FrameTree[] };
type State = {
  config: Preset;
  blocked: number;
  allowed: number;
  fallback: string[];
  sessions: Map<string, Target>;
  initializing: boolean;
  scripts: Map<string, string[]>;
  sourceUrl: string;
  network: boolean;
  pending: number;
  frames: Map<string, Frame>;
  environment: "off" | "active" | "unavailable";
};
const states = new Map<number, State>();
const transitions = new Map<number, Promise<void>>();
function transition(tabId: number, operation: () => Promise<void>): Promise<void> {
  const next = (transitions.get(tabId) ?? Promise.resolve()).then(operation);
  // Keep serialization independent of the previous caller's error handling.
  // The caller still receives the original rejection through next.
  const settled = next.then(
    () => {},
    () => {},
  );
  transitions.set(tabId, settled);
  void settled.then(() => {
    if (transitions.get(tabId) === settled) transitions.delete(tabId);
  });
  return next;
}
function updateNetwork(s: State): void {
  s.network = [...s.sessions.values()].some((target) => target.ready);
}
function releaseWhenIdle(): void {
  releaseEngineWhenIdle(() => [...states.values()].some((s) => s.config.name !== "none"));
}
function command(
  tabId: number,
  method: string,
  params: JsonObject = {},
  sessionId = "",
): Promise<object | undefined> {
  return chrome.debugger.sendCommand(
    { tabId, ...(sessionId ? { sessionId } : {}) },
    method,
    params,
  );
}
function fallback(s: State, error: object | string): void {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  if (!s.fallback.includes(message) && s.fallback.length < 8)
    s.fallback.push(message.slice(0, 300));
}
export function presetStatus(tabId: number): object {
  const s = states.get(tabId);
  return s
    ? {
        ...s.config,
        blocked: s.blocked,
        allowed: s.allowed,
        network: s.network,
        environmentState: s.environment,
        fallback: [...s.fallback],
      }
    : { name: "none", network: false, environmentState: "off", fallback: [] };
}
// True when a navigation can keep the tab's live preset: the same settings are
// installed and intercepting on the root target, and no transition is running.
// Reconfiguration sends commands that the current document must answer, which
// an unresponsive page never does. Environment scripts depend on the target
// host, so they always need reconfiguration.
export function presetCurrent(tabId: number, config: Preset): boolean {
  const s = states.get(tabId);
  return (
    !!s &&
    !config.environment &&
    !transitions.has(tabId) &&
    s.sessions.get("")?.ready === true &&
    (Object.keys(config) as (keyof Preset)[]).every((key) => s.config[key] === config[key])
  );
}
export async function configurePreset(tabId: number, config: Preset, url: string): Promise<object> {
  const previous = states.get(tabId);
  const s: State = {
    config,
    blocked: 0,
    allowed: 0,
    fallback: [],
    sessions: new Map(),
    initializing: true,
    scripts: new Map(),
    sourceUrl: url,
    network: false,
    pending: 0,
    frames: new Map(),
    environment: "off",
  };
  // Invalidate old installations before waiting for their CDP responses.
  states.set(tabId, s);
  try {
    await transition(tabId, async () => {
      await teardown(tabId, previous);
      if (states.get(tabId) !== s) return;
      // Closing/detaching the tab during this read must invalidate the setup.
      await chrome.tabs.get(tabId);
      if (states.get(tabId) !== s) return;
      if (config.name !== "none") {
        try {
          await engine();
        } catch (error) {
          fallback(s, `network lists unavailable; ${String(error)}`);
          forgetEngine();
        }
      }
      if (states.get(tabId) !== s) return;
      s.initializing = false;
      await configureTarget(tabId, s, "");
      await Promise.all(frameTargets(tabId).map((id) => configureTarget(tabId, s, id)));
    });
  } catch (error) {
    if (states.get(tabId) === s) states.delete(tabId);
    releaseWhenIdle();
    throw error;
  }
  // A switch to none may leave no filtered tab; the timer re-checks all tabs.
  releaseWhenIdle();
  return presetStatus(tabId);
}
async function configureTarget(tabId: number, s: State, sessionId: string): Promise<void> {
  if (states.get(tabId) !== s || s.initializing || s.config.name === "none") return;
  const existing = s.sessions.get(sessionId);
  if (existing) return existing.installation;
  if (s.sessions.size >= 128) {
    fallback(s, "128 intercepted targets per tab reached; additional frames fail open");
    return;
  }
  // Reserve capacity synchronously, including installations still in flight.
  const target: Target = { ready: false, installation: Promise.resolve() };
  s.sessions.set(sessionId, target);
  target.installation = installTarget(tabId, s, sessionId, target);
  return target.installation;
}
async function installTarget(
  tabId: number,
  s: State,
  sessionId: string,
  target: Target,
): Promise<void> {
  const current = (): boolean => states.get(tabId) === s && s.sessions.get(sessionId) === target;
  try {
    await command(tabId, "Page.enable", {}, sessionId);
    if (!current()) return;
    const observed = new Map(s.frames);
    const { frameTree } = (await command(tabId, "Page.getFrameTree", {}, sessionId)) as {
      frameTree: FrameTree;
    };
    if (!current()) return;
    seedFrames(s, frameTree, observed);
    await command(
      tabId,
      "Emulation.setScriptExecutionDisabled",
      { value: s.config.name === "zen" && s.config.javascript },
      sessionId,
    );
    if (!current()) return;
    await environment(tabId, s, s.sourceUrl, sessionId);
    if (!current()) return;
    await command(
      tabId,
      "Fetch.enable",
      { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
      sessionId,
    );
    if (!current()) return;
    target.ready = true;
    updateNetwork(s);
  } catch (error) {
    if (!current()) return;
    fallback(s, `interception unavailable; ${String(error)}`);
    await command(tabId, "Fetch.disable", {}, sessionId).catch(() => {});
    await command(tabId, "Emulation.setScriptExecutionDisabled", { value: false }, sessionId).catch(
      () => {},
    );
    if (s.sessions.get(sessionId) === target) s.sessions.delete(sessionId);
    updateNetwork(s);
  }
}
function seedFrames(s: State, tree: FrameTree, observed: ReadonlyMap<string, Frame>): void {
  const { id, url, parentId } = tree.frame;
  // A navigation event received during the query is newer than the snapshot,
  // whose subtree below that frame then describes a replaced document.
  if (s.frames.get(id) !== observed.get(id)) return;
  if (s.frames.size >= 1024 && !s.frames.has(id)) return;
  s.frames.set(id, { url, parentId });
  for (const child of tree.childFrames ?? []) {
    if (s.frames.size >= 1024) break;
    seedFrames(s, child, observed);
  }
}
// Chrome does not report Page.frameDetached for the frames of a document that
// is replaced, so a frame committing a document drops the frames below it.
// Child-target frames share the table and are linked through parentId.
function forgetDescendants(s: State, frameId: string): void {
  const children = new Map<string, string[]>();
  for (const [id, frame] of s.frames) {
    if (!frame.parentId) continue;
    const siblings = children.get(frame.parentId);
    if (siblings) siblings.push(id);
    else children.set(frame.parentId, [id]);
  }
  const queue = [...(children.get(frameId) ?? [])];
  for (const id of queue) if (s.frames.delete(id)) queue.push(...(children.get(id) ?? []));
}
async function environment(tabId: number, s: State, url: string, sessionId: string): Promise<void> {
  if (!s.config.environment || (s.config.name === "zen" && s.config.javascript)) return;
  try {
    const request = Request.fromRawDetails({ url, sourceUrl: url, type: "main_frame" });
    const filters = (await engine()).getCosmeticsFilters({
      url,
      hostname: request.hostname,
      domain: request.domain,
      getBaseRules: true,
      getInjectionRules: true,
      getExtendedRules: false,
      getRulesFromDOM: false,
      getRulesFromHostname: true,
    });
    if (states.get(tabId) !== s || !s.sessions.has(sessionId)) return;
    // Every registered identifier stays recorded until removed, so teardown
    // also covers registrations left by a failure part-way through.
    const scripts = s.scripts.get(sessionId) ?? [];
    s.scripts.set(sessionId, scripts);
    while (scripts.length) {
      await command(
        tabId,
        "Page.removeScriptToEvaluateOnNewDocument",
        { identifier: scripts[0]! },
        sessionId,
      );
      scripts.shift();
    }
    if (states.get(tabId) !== s || !s.sessions.has(sessionId)) return;
    // Domain guard prevents root-domain cosmetics leaking into cross-site frames.
    // All executable scriptlets come from the bundled, hash-pinned resources.
    const guard = `if(location.hostname!==${JSON.stringify(request.hostname)})return;`;
    // One registration and scope per scriptlet: bundled helpers declared by
    // several scriptlets cannot collide, and a scriptlet that fails to parse or
    // throws affects only itself. The stylesheet is registered on its own.
    const sources = filters.scripts.map((script) => `(()=>{${guard}try{${script}}catch{}})()`);
    if (filters.styles)
      sources.push(
        `(()=>{${guard}const css=${JSON.stringify(filters.styles)};const apply=()=>{if(!document.documentElement)return;const style=document.createElement('style');style.textContent=css;document.documentElement.append(style);observer.disconnect()};const observer=new MutationObserver(apply);observer.observe(document,{childList:true,subtree:true});apply()})()`,
      );
    for (const source of sources) {
      const { identifier } = (await command(
        tabId,
        "Page.addScriptToEvaluateOnNewDocument",
        { source },
        sessionId,
      )) as { identifier: string };
      // A detached target can finish registration after its detach event.
      if (!s.sessions.has(sessionId)) {
        await command(
          tabId,
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier },
          sessionId,
        ).catch(() => {});
        return;
      }
      scripts.push(identifier);
      // A newer preset's teardown removes what has been recorded so far.
      if (states.get(tabId) !== s) return;
    }
    s.environment = "active";
  } catch (error) {
    s.environment = "unavailable";
    fallback(s, `environment unavailable; network filtering retained; ${String(error)}`);
  }
}
async function failOpen(tabId: number, s: State, sessionId: string, reason: string): Promise<void> {
  if (states.get(tabId) !== s) return;
  const target = s.sessions.get(sessionId);
  if (!target) return;
  if (target.cleanup) return target.cleanup;
  fallback(s, reason);
  target.ready = false;
  updateNetwork(s);
  target.cleanup = transition(tabId, async () => {
    if (states.get(tabId) !== s || s.sessions.get(sessionId) !== target) return;
    await target.installation;
    if (states.get(tabId) !== s || s.sessions.get(sessionId) !== target) return;
    // Disabling Fetch releases paused requests; the browser process answers it.
    // Restoring site JavaScript needs the target's renderer, which a busy frame
    // does not answer, so only Fetch.disable holds the preset queue. Both
    // commands go out before a newer preset sends its own, and Chrome applies
    // one session's commands in the order they are sent.
    const disabling = command(tabId, "Fetch.disable", {}, sessionId).catch(() => {});
    void command(tabId, "Emulation.setScriptExecutionDisabled", { value: false }, sessionId).catch(
      (error: Error) => {
        if (states.get(tabId) === s)
          fallback(s, `site JavaScript not restored after fail-open; ${String(error)}`);
      },
    );
    await disabling;
    if (s.sessions.get(sessionId) === target) s.sessions.delete(sessionId);
    updateNetwork(s);
  });
  return target.cleanup;
}
const types: Record<string, RequestType> = {
  Document: "main_frame",
  Stylesheet: "stylesheet",
  Image: "image",
  Font: "font",
  Script: "script",
  XHR: "xmlhttprequest",
  Fetch: "xmlhttprequest",
  Media: "media",
  Ping: "ping",
  WebSocket: "websocket",
};
export async function presetEvent(
  tabId: number,
  method: string,
  params: JsonObject,
  sessionId = "",
): Promise<void> {
  const s = states.get(tabId);
  if (s && method === "Page.frameAttached" && s.frames.size < 1024) {
    s.frames.set(params.frameId as string, { url: "", parentId: params.parentFrameId as string });
  }
  if (s && method === "Page.frameNavigated") {
    const frame = params.frame as { id: string; url: string; parentId?: string };
    const main = !sessionId && !frame.parentId;
    // A new top-level document also drops entries orphaned by earlier detaches.
    if (main) s.frames.clear();
    else forgetDescendants(s, frame.id);
    if (s.frames.size < 1024 || s.frames.has(frame.id))
      s.frames.set(frame.id, { url: frame.url, parentId: frame.parentId });
    if (main) s.sourceUrl = frame.url;
  }
  if (s && method === "Page.frameDetached") {
    forgetDescendants(s, params.frameId as string);
    s.frames.delete(params.frameId as string);
  }
  if (s && method === "Target.detachedFromTarget") {
    const id = params.sessionId as string;
    s.sessions.delete(id);
    s.scripts.delete(id);
    updateNetwork(s);
    return;
  }
  if (method === "Target.attachedToTarget") {
    if (s) await configureTarget(tabId, s, params.sessionId as string);
    return;
  }
  if (method !== "Fetch.requestPaused" || !s || s.config.name === "none") return;
  const requestId = params.requestId as string;
  const target = s.sessions.get(sessionId);
  if (!target || target.cleanup) {
    await command(tabId, "Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
    return;
  }
  if (s.pending >= 128) {
    // The target's cleanup waits in the preset queue, which a reconfiguration
    // installing a busy frame can hold, so this request is released now. A
    // failure is ignored: the cleanup's Fetch.disable also releases it.
    void command(tabId, "Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
    await failOpen(tabId, s, sessionId, "interception capacity exceeded; target failed open");
    return;
  }
  s.pending++;
  try {
    const request = params.request as { url: string };
    const type = params.resourceType as string;
    const c = s.config;
    const zen =
      c.name === "zen" &&
      ((type === "Image" && c.images) ||
        (type === "Font" && c.fonts) ||
        (type === "Stylesheet" && c.css) ||
        (type === "Script" && c.javascript));
    let match = false;
    try {
      match = (await engine()).match(
        Request.fromRawDetails({
          url: request.url,
          sourceUrl:
            type === "Document"
              ? s.frames.get(s.frames.get(params.frameId as string)?.parentId ?? "")?.url ||
                s.sourceUrl
              : s.frames.get(params.frameId as string)?.url || s.sourceUrl,
          type:
            type === "Document" && (sessionId || s.frames.get(params.frameId as string)?.parentId)
              ? "sub_frame"
              : (types[type] ?? "other"),
        }),
      ).match;
    } catch (error) {
      fallback(s, `lists unavailable; fail-open network; ${String(error)}`);
    }
    if (states.get(tabId) !== s || s.sessions.get(sessionId) !== target || target.cleanup) return;
    if (zen || match) {
      s.blocked++;
      await command(
        tabId,
        "Fetch.failRequest",
        { requestId, errorReason: "BlockedByClient" },
        sessionId,
      );
    } else {
      s.allowed++;
      await command(tabId, "Fetch.continueRequest", { requestId }, sessionId);
    }
  } catch (error) {
    await failOpen(tabId, s, sessionId, `request interception failed open; ${String(error)}`);
  } finally {
    s.pending--;
  }
}
export async function clearPreset(tabId: number): Promise<void> {
  const s = states.get(tabId);
  states.delete(tabId);
  releaseWhenIdle();
  await transition(tabId, () => teardown(tabId, s));
}
// Chrome handles Fetch in the browser process, so Fetch.disable takes effect
// and releases paused requests even when the target's page is busy. Both
// commands go out together; a target that does not answer, or fails, holds up
// only its own release.
async function release(tabId: number, sessionId: string): Promise<void> {
  await Promise.all([
    command(tabId, "Fetch.disable", {}, sessionId).catch(() => {}),
    command(tabId, "Emulation.setScriptExecutionDisabled", { value: false }, sessionId).catch(
      () => {},
    ),
  ]);
}
async function teardown(tabId: number, s?: State): Promise<void> {
  if (!s) return;
  const targets = [...s.sessions];
  const installing = targets.filter(([, target]) => !target.ready);
  // Release every target first: an installation waiting on a busy frame must
  // not keep the other targets' interception, including the root's, active.
  await Promise.all(targets.map(([sessionId]) => release(tabId, sessionId)));
  // A Fetch.enable or script registration still in flight lands after that
  // release. Repeat it once those installations end, and finish cleanup before
  // a newer generation installs its settings.
  await Promise.all(installing.map(([, target]) => target.installation));
  await Promise.all(installing.map(([sessionId]) => release(tabId, sessionId)));
  await Promise.all(
    [...s.scripts].map(async ([sessionId, identifiers]) => {
      for (const identifier of identifiers)
        await command(
          tabId,
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier },
          sessionId,
        ).catch(() => {});
    }),
  );
}
export function forgetPreset(tabId: number): void {
  states.delete(tabId);
  releaseWhenIdle();
}
