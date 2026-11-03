import { Request, type FiltersEngine, type WebRequestType } from "@ghostery/adblocker";
import { engine, forgetEngine, releaseEngineWhenIdle, type Preset } from "../filters.js";
import { hasSiteAccess, refreshSiteAccess, siteAccessHint } from "./access.js";
import { documentBlocked } from "./navigation.js";

type BeforeRequest = (
  details: chrome.webRequest.OnBeforeRequestDetails,
) => chrome.webRequest.BlockingResponse | undefined;
type HeadersReceived = (
  details: chrome.webRequest.OnHeadersReceivedDetails,
) => chrome.webRequest.BlockingResponse | undefined;
type State = {
  config: Preset;
  blocked: number;
  allowed: number;
  fallback: string[];
  environment: "off" | "unavailable";
  // Undefined while the lists are unavailable: requests then fail open.
  engine?: FiltersEngine;
  request?: BeforeRequest;
  headers?: HeadersReceived;
};
const states = new Map<number, State>();
// Every request type Firefox reports; anything else matches as "other".
const webRequestTypes: WebRequestType[] = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "imageset",
  "font",
  "object",
  "object_subrequest",
  "xmlhttprequest",
  "xslt",
  "ping",
  "beacon",
  "xml_dtd",
  "media",
  "websocket",
  "csp_report",
  "web_manifest",
  "speculative",
  "json",
  "other",
];
function fallback(s: State, message: string): void {
  if (!s.fallback.includes(message) && s.fallback.length < 8)
    s.fallback.push(message.slice(0, 300));
}
function releaseWhenIdle(): void {
  releaseEngineWhenIdle(() => [...states.values()].some((s) => s.config.name !== "none"));
}
function zenBlocks(config: Preset, type: string): boolean {
  return (
    config.name === "zen" &&
    (((type === "image" || type === "imageset") && config.images) ||
      (type === "font" && config.fonts) ||
      (type === "stylesheet" && config.css) ||
      (type === "script" && config.javascript))
  );
}
// Matching is synchronous once the engine is loaded, so the blocking listener
// answers each request directly and nothing waits in an extension-side queue.
function decide(s: State, details: chrome.webRequest.OnBeforeRequestDetails): boolean {
  if (zenBlocks(s.config, details.type)) return true;
  if (!s.engine) return false;
  try {
    return s.engine.match(
      Request.fromRawDetails({
        url: details.url,
        // Firefox reports the loading document as documentUrl for subresources
        // and frames; a top-level document is its own source.
        sourceUrl:
          details.type === "main_frame" ? details.url : (details.documentUrl ?? details.url),
        type: webRequestTypes.find((type) => type === details.type) ?? "other",
      }),
    ).match;
  } catch (error) {
    fallback(s, `request matching failed open; ${String(error)}`);
    return false;
  }
}
function uninstall(s: State | undefined): void {
  if (s?.request) chrome.webRequest.onBeforeRequest.removeListener(s.request);
  if (s?.headers) chrome.webRequest.onHeadersReceived.removeListener(s.headers);
}
function install(tabId: number, s: State): void {
  s.request = (details) => {
    // Firefox lets requests through regardless while site access is withdrawn.
    if (hasSiteAccess() && decide(s, details)) {
      s.blocked++;
      if (details.type === "main_frame") documentBlocked(details);
      return { cancel: true };
    }
    s.allowed++;
    return undefined;
  };
  chrome.webRequest.onBeforeRequest.addListener(s.request, { urls: ["<all_urls>"], tabId }, [
    "blocking",
  ]);
  if (s.config.name === "zen" && s.config.javascript) {
    // Inline scripts and event handler attributes never reach webRequest; a
    // response CSP stops them in every document of the task tab.
    s.headers = (details) => ({
      responseHeaders: [
        ...(details.responseHeaders ?? []),
        { name: "Content-Security-Policy", value: "script-src 'none'" },
      ],
    });
    chrome.webRequest.onHeadersReceived.addListener(
      s.headers,
      { urls: ["<all_urls>"], tabId, types: ["main_frame", "sub_frame"] },
      ["blocking", "responseHeaders"],
    );
  }
}
const withoutSiteAccess = `request filtering needs access to all websites; ${siteAccessHint}`;
export function presetStatus(tabId: number): object {
  const s = states.get(tabId);
  if (!s) return { name: "none", network: false, environmentState: "off", fallback: [] };
  // The listeners stay installed and filter again once access returns.
  const filtering = !!s.request && hasSiteAccess();
  return {
    ...s.config,
    blocked: s.blocked,
    allowed: s.allowed,
    network: filtering,
    environmentState: s.environment,
    fallback: s.request && !filtering ? [...s.fallback, withoutSiteAccess] : [...s.fallback],
  };
}
// True when the tab already filters with the same settings, so a navigation
// can keep its listeners.
export function presetCurrent(tabId: number, config: Preset): boolean {
  const s = states.get(tabId);
  return (
    !!s &&
    !config.environment &&
    (Object.keys(config) as (keyof Preset)[]).every((key) => s.config[key] === config[key])
  );
}
export async function configurePreset(tabId: number, config: Preset): Promise<object> {
  const s: State = {
    config,
    blocked: 0,
    allowed: 0,
    fallback: [],
    environment: config.environment ? "unavailable" : "off",
  };
  uninstall(states.get(tabId));
  // Invalidate the previous configuration before waiting for the lists.
  states.set(tabId, s);
  if (config.environment)
    fallback(
      s,
      "environment is not available in Firefox: per-tab document-start scripts need the user scripts API",
    );
  if (config.name !== "none") {
    try {
      s.engine = await engine();
    } catch (error) {
      fallback(s, `network lists unavailable; ${String(error)}`);
      forgetEngine();
    }
    await refreshSiteAccess();
    // A newer configuration or a closed tab replaced this one meanwhile.
    if (states.get(tabId) !== s) return presetStatus(tabId);
    install(tabId, s);
  }
  releaseWhenIdle();
  return presetStatus(tabId);
}
export function forgetPreset(tabId: number): void {
  uninstall(states.get(tabId));
  states.delete(tabId);
  releaseWhenIdle();
}
