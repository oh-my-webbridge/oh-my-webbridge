import { fail } from "../protocol.js";
import type { Budget } from "../bridge.js";

// A cancelled wait reports that the browser may already have acted, like the
// request deadline check in bridge.ts.
function outcomeUnknown(): never {
  fail("outcome_unknown", "request deadline reached; observe before retrying");
}
export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  const stop = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => stop.resolve(false), ms);
  const abort = (): void => stop.resolve(true);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const aborted = await stop.promise;
  clearTimeout(timer);
  signal.removeEventListener("abort", abort);
  if (aborted) outcomeUnknown();
}
// Waits for promise unless the request is cancelled first. A cancelled wait
// logs what it had seen, for diagnosis.
async function until<T>(promise: Promise<T>, budget: Budget, seen: () => string): Promise<T> {
  budget.check();
  const abort = Promise.withResolvers<void>();
  budget.signal.addEventListener("abort", () => abort.resolve(), { once: true });
  const result = await Promise.race([
    (async () => ({ value: await promise }))(),
    (async () => {
      await abort.promise;
      return undefined;
    })(),
  ]);
  if (result) return result.value;
  console.warn(seen());
  outcomeUnknown();
}

type TopEvent =
  | { kind: "before" | "commit" | "complete" | "sameDocument"; url: string }
  // The top-level request that started at url ended without a document.
  | { kind: "noContent" | "blocked"; url: string }
  | { kind: "status"; status: string; url?: string };
type Watcher = (tabId: number, event: TopEvent) => void;
const watchers = new Set<Watcher>();
function dispatch(tabId: number, event: TopEvent): void {
  for (const watcher of watchers) watcher(tabId, event);
}
type FrameEvent = { tabId: number; frameId: number; url: string };
function topFrame(kind: "before" | "commit" | "complete" | "sameDocument") {
  return (details: FrameEvent): void => {
    if (details.frameId === 0) dispatch(details.tabId, { kind, url: details.url });
  };
}
// Firefox attaches an extension's listener in the parent process only once
// it has loaded the API there: ExtensionParent's recvAddListener awaits
// CanOfAPIs.asyncFindAPIPath, which compiles ext-webNavigation.js
// asynchronously on first use, while a call to an API already in use, such
// as tabs.create, runs at once. Events in between never reach the listener.
// The listeners are therefore registered once, here, and listening settles
// with the reply to a webNavigation call sent after them: the parent answers
// it only after loading the API, which attaches the listeners as well.
chrome.webNavigation.onBeforeNavigate.addListener(topFrame("before"));
chrome.webNavigation.onCommitted.addListener(topFrame("commit"));
chrome.webNavigation.onCompleted.addListener(topFrame("complete"));
chrome.webNavigation.onHistoryStateUpdated.addListener(topFrame("sameDocument"));
chrome.webNavigation.onReferenceFragmentUpdated.addListener(topFrame("sameDocument"));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status) dispatch(tabId, { kind: "status", status: change.status, url: change.url });
});
// webNavigation reports a navigation by the URL its request started with,
// and a redirect keeps the request's requestId: the first URL of each
// redirected top-level request ties its later events to that navigation.
const documents: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"], types: ["main_frame"] };
const redirected = new Map<string, string>();
type Request = { tabId: number; requestId: string; url: string };
function startUrl(details: Request): string {
  return redirected.get(details.requestId) ?? details.url;
}
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => void redirected.set(details.requestId, startUrl(details)),
  documents,
);
chrome.webRequest.onCompleted.addListener(
  (details) => void redirected.delete(details.requestId),
  documents,
);
chrome.webRequest.onErrorOccurred.addListener(
  (details) => void redirected.delete(details.requestId),
  documents,
);
// Firefox never makes a document of a 204 or 205 response: nsDocumentOpenInfo
// cancels the load with NS_BINDING_ABORTED and the tab keeps its document.
// webNavigation then reports only that error, which a load moving to another
// content process reports as well, so the response status tells the two apart.
chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (details.tabId >= 0 && (details.statusCode === 204 || details.statusCode === 205))
    dispatch(details.tabId, { kind: "noContent", url: startUrl(details) });
  return undefined;
}, documents);
// A preset cancelled the top-level request of a tab. Firefox then keeps the
// tab's document and webNavigation reports neither a commit nor an error.
export function documentBlocked(details: Request): void {
  if (details.tabId >= 0) dispatch(details.tabId, { kind: "blocked", url: startUrl(details) });
}
const listening = (async () => {
  await Promise.all([
    chrome.webNavigation.getFrame({ documentId: "00000000-0000-0000-0000-000000000000" }),
    chrome.webRequest.getSecurityInfo("0"),
  ]);
})();
function describe(event: TopEvent): string {
  return event.kind === "status"
    ? `status ${event.status}${event.url ? ` ${event.url}` : ""}`
    : `${event.kind} ${event.url}`;
}

// tabs.create and windows.create return before Firefox loads the new tab's
// about:blank document. A navigation requested before that load runs races
// with it: the blank load can commit after the requested page and replace it.
// Watching starts before the tab exists, so a load that completes before
// create resolves is still seen. Await loaded before navigating the tab, and
// dispose once done with it.
export async function createBlank<T>(
  create: () => Promise<T>,
  tabOf: (created: T) => number | undefined,
  missing: [code: string, message: string],
  budget: Budget,
): Promise<{
  created: T;
  tabId: number;
  loaded: (budget: Budget) => Promise<void>;
  dispose: () => void;
}> {
  await until(listening, budget, () => "navigation events are not attached yet");
  const done = new Set<number>();
  const blank = Promise.withResolvers<void>();
  const seen: string[] = [];
  let tabId: number | undefined;
  const watcher: Watcher = (id, event) => {
    if (id === tabId) seen.push(describe(event));
    if (event.kind !== "complete" || event.url !== "about:blank") return;
    done.add(id);
    if (id === tabId) blank.resolve();
  };
  const dispose = (): void => void watchers.delete(watcher);
  watchers.add(watcher);
  let created: T;
  try {
    created = await create();
    tabId = tabOf(created);
    if (tabId === undefined) fail(...missing);
  } catch (error) {
    dispose();
    throw error;
  }
  if (done.has(tabId)) blank.resolve();
  const id = tabId;
  return {
    created,
    tabId: id,
    loaded: async (budget) => {
      await until(
        blank.promise,
        budget,
        () => `new tab ${id} did not load about:blank: ${seen.join(", ") || "no events"}`,
      );
      dispose();
    },
    dispose,
  };
}
// Follows the next top-level navigation of a tab until it ends:
// - the document it committed has loaded; a failed load commits an error
//   page, whose end only the tab status reports;
// - a history or fragment change kept the current document;
// - the load completed without committing a document, as when the response
//   is an attachment that Firefox downloads;
// - the response was 204 No Content or 205 Reset Content, or a preset
//   cancelled the request.
// Those last events name the URL the request started with, which ties them to
// this navigation and not to one the page starts itself; either kind of event
// can arrive first.
// A cross-site load first fails with NS_BINDING_ABORTED while it moves to
// another content process and then starts again there, and the tab can read
// "complete" in between, so errors and the status before a commit do not end
// the wait. ended resolves with the URL of the new document, or undefined
// when the tab kept its document.
function watchTop(tabId: number): {
  ended: (budget: Budget) => Promise<string | undefined>;
  started: (timeoutMs: number, budget: Budget) => Promise<boolean>;
  dispose: () => void;
} {
  const ended = Promise.withResolvers<string | undefined>();
  const began = Promise.withResolvers<void>();
  const seen: string[] = [];
  let requested: string | undefined;
  let committed: string | undefined;
  // Start URLs of the tab's top-level requests that ended without a document.
  const dropped = new Set<string>();
  const watcher: Watcher = (id, event) => {
    if (id !== tabId) return;
    seen.push(describe(event));
    if (event.kind === "status") {
      if (event.status === "loading") began.resolve();
      if (event.status === "complete" && committed !== undefined)
        ended.resolve(event.url ?? committed);
      return;
    }
    if (event.kind === "noContent" || event.kind === "blocked") {
      dropped.add(event.url);
      if (committed === undefined && event.url === requested) ended.resolve(undefined);
      return;
    }
    began.resolve();
    if (event.kind === "before") {
      requested ??= event.url;
      if (committed === undefined && dropped.has(requested)) ended.resolve(undefined);
    } else if (event.kind === "commit") committed = event.url;
    else if (event.kind === "sameDocument") ended.resolve(event.url);
    else if (committed !== undefined) ended.resolve(committed);
    else if (event.url === requested) ended.resolve(undefined);
  };
  watchers.add(watcher);
  const progress = (): string =>
    `navigation of tab ${tabId} did not finish: ${seen.join(", ") || "no events"}`;
  return {
    ended: (budget) => until(ended.promise, budget, progress),
    // True once a top-level navigation has begun within timeoutMs.
    started: async (timeoutMs, budget) => {
      budget.check();
      return Promise.race([
        (async () => {
          await began.promise;
          return true;
        })(),
        (async () => {
          await pause(timeoutMs, budget.signal);
          return false;
        })(),
      ]);
    },
    dispose: () => void watchers.delete(watcher),
  };
}
// Runs navigation, which starts a top-level navigation of the tab, and waits
// until it ends. Resolves with the tab's URL then.
async function follow(
  tabId: number,
  budget: Budget,
  navigation: (watch: ReturnType<typeof watchTop>) => Promise<void>,
): Promise<string | undefined> {
  await until(listening, budget, () => "navigation events are not attached yet");
  const watch = watchTop(tabId);
  try {
    await navigation(watch);
    return (await watch.ended(budget)) ?? (await chrome.tabs.get(tabId)).url;
  } finally {
    watch.dispose();
  }
}
// Navigates the tab and waits until the navigation has ended.
// onStarted runs once the navigation request has been issued.
export async function load(
  tabId: number,
  url: string,
  budget: Budget,
  onStarted: () => void = () => {},
): Promise<void> {
  await follow(tabId, budget, async () => {
    await chrome.tabs.update(tabId, { url });
    onStarted();
  });
}
// Reloads the tab and waits until the reloaded document has loaded.
export async function reload(tabId: number, budget: Budget): Promise<void> {
  await follow(tabId, budget, async () => {
    await chrome.tabs.reload(tabId);
  });
}
// tabs.goBack/goForward do nothing when there is no entry in that direction,
// so a navigation that has not begun within two seconds means no entry.
export async function traverse(
  tabId: number,
  direction: "back" | "forward",
  budget: Budget,
): Promise<string | undefined> {
  return follow(tabId, budget, async (watch) => {
    await (direction === "back" ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
    if (!(await watch.started(2000, budget)))
      fail("history_missing", "no navigation entry in that direction");
  });
}
