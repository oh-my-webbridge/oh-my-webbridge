import { build } from "esbuild";

// A listener list with the addListener/removeListener surface of WebExtension events.
export function event() {
  const listeners = [];
  return {
    listeners,
    addListener(fn, filter, extra) {
      listeners.push({ fn, filter, extra });
    },
    removeListener(fn) {
      const index = listeners.findIndex((l) => l.fn === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(...args) {
      return [...listeners].map((l) => l.fn(...args));
    },
  };
}

// Bundles TypeScript module source for the browser and imports it as a fresh
// module instance.
export async function bundle(contents, name) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${name}`
  );
}

// Fake Firefox WebExtension APIs. Tabs commit navigations immediately unless
// options.commit is false; documents run page.js through options.page.
// A created tab loads its about:blank document after create returns, as in
// Firefox; with options.blank false, tests emit that load through state.top.
// Firefox attaches webNavigation listeners in the parent process once it has
// loaded the API there, asynchronously on first use: listeners miss events
// until then, and webNavigation calls answer after it. The load happens on a
// timer after first use, or when the test calls state.loadWebNavigation with
// options.webNavigation "manual".
export function firefoxApi(options = {}) {
  const state = {
    sessions: structuredClone(options.sessions ?? {}),
    tabs: new Map(),
    nextTab: 7,
    // Firefox grants the manifest's <all_urls> at installation.
    permissions: new Set(options.permissions ?? ["<all_urls>"]),
    // documentId -> frame location; page.js installs per document.
    documents: new Map([["doc-main", { frameId: 0 }]]),
    installed: new Set(),
    executed: [],
    userScripts: [],
    captures: [],
    groups: [],
    updates: [],
    removed: [],
    navigations: [],
    downloads: [],
    cancelled: [],
    cookies: options.cookies ?? [],
    cookieQueries: [],
    cookieWrites: [],
    cookieRemovals: [],
    page: options.page ?? (async (op) => ({ ok: true, value: { op } })),
  };
  // Firefox reports the cookie store of every tab; a container tab has its own.
  for (const tab of options.tabs ?? [])
    state.tabs.set(tab.id, { status: "complete", cookieStoreId: "firefox-default", ...tab });
  const api = Promise.withResolvers();
  const unattached = [];
  let loading = false;
  state.webNavigationLoaded = false;
  state.loadWebNavigation = () => {
    state.webNavigationLoaded = true;
    for (const [target, ...listener] of unattached.splice(0)) target.addListener(...listener);
    api.resolve();
  };
  const firstUse = () => {
    if (loading || options.webNavigation === "manual") return;
    loading = true;
    setTimeout(() => state.loadWebNavigation());
  };
  function parentEvent() {
    const target = event();
    return {
      ...target,
      addListener(...listener) {
        if (state.webNavigationLoaded) return target.addListener(...listener);
        unattached.push([target, ...listener]);
        firstUse();
      },
      removeListener(fn) {
        const index = unattached.findIndex(([, listener]) => listener === fn);
        if (index >= 0) unattached.splice(index, 1);
        target.removeListener(fn);
      },
    };
  }
  const webNavigation = {
    onCommitted: parentEvent(),
    onErrorOccurred: parentEvent(),
    onHistoryStateUpdated: parentEvent(),
    onReferenceFragmentUpdated: parentEvent(),
    onBeforeNavigate: parentEvent(),
    onCompleted: parentEvent(),
    getAllFrames: async () => {
      firstUse();
      await api.promise;
      return options.frames ?? [{ frameId: 0, parentFrameId: -1, url: "https://example.test/" }];
    },
    getFrame: async ({ frameId, documentId }) => {
      firstUse();
      await api.promise;
      if (documentId !== undefined) return null;
      return (options.frames ?? []).find((frame) => frame.frameId === frameId) ?? null;
    },
  };
  // Top-level events in the order Firefox reports a same-process load.
  // With options.commit false, tests emit them through state.top.
  state.top = {
    before: (tabId, url) => webNavigation.onBeforeNavigate.emit({ tabId, frameId: 0, url }),
    commit: (tabId, url) => {
      const tab = state.tabs.get(tabId);
      tab.status = "loading";
      tab.url = url;
      webNavigation.onCommitted.emit({ tabId, frameId: 0, url });
      chrome.tabs.onUpdated.emit(tabId, { status: "loading", url }, { ...tab });
    },
    complete: (tabId, url) => {
      const tab = state.tabs.get(tabId);
      webNavigation.onCompleted.emit({ tabId, frameId: 0, url });
      tab.status = "complete";
      chrome.tabs.onUpdated.emit(tabId, { status: "complete" }, { ...tab });
    },
    // A load moving to another content process fails with NS_BINDING_ABORTED
    // and starts again there.
    abort: (tabId, url) =>
      webNavigation.onErrorOccurred.emit({
        tabId,
        frameId: 0,
        url,
        error: "Error code 2152398850",
      }),
    // The page answers 204 or 205: the load fails with NS_BINDING_ABORTED, the
    // tab keeps its document, and webRequest reports the response afterwards.
    noContent: (tabId, url, statusCode = 204) => {
      state.top.abort(tabId, url);
      const tab = state.tabs.get(tabId);
      tab.status = "complete";
      chrome.tabs.onUpdated.emit(tabId, { status: "complete" }, { ...tab });
      chrome.webRequest.onHeadersReceived.emit({
        tabId,
        frameId: 0,
        type: "main_frame",
        url,
        statusCode,
      });
    },
  };
  function navigate(tabId, url) {
    const tab = state.tabs.get(tabId);
    tab.status = "loading";
    state.navigations.push({ tabId, url });
    if (options.commit === false) return;
    queueMicrotask(() => {
      state.top.before(tabId, url);
      state.top.commit(tabId, url);
      state.top.complete(tabId, url);
    });
  }
  function createTab(tab) {
    state.tabs.set(tab.id, tab);
    if (options.blank === false) return;
    setTimeout(() => {
      state.top.before(tab.id, "about:blank");
      state.top.commit(tab.id, "about:blank");
      state.top.complete(tab.id, "about:blank");
    });
  }
  function documentFor(target) {
    if (target.documentIds) {
      const id = target.documentIds[0];
      if (!state.documents.has(id)) throw new Error(`Invalid documentId: ${id}`);
      return id;
    }
    const frameId = target.frameIds?.[0] ?? 0;
    if (frameId === 0) return "doc-main";
    for (const [id, doc] of state.documents) if (doc.frameId === frameId) return id;
    throw new Error(`Invalid frame IDs: [${frameId}].`);
  }
  const chrome = {
    storage: {
      session: {
        get: async () => ({ sessions: structuredClone(state.sessions) }),
        set: async (value) => {
          if (value.sessions) state.sessions = structuredClone(value.sessions);
        },
      },
      local: { get: async () => ({ paused: true }) },
      onChanged: event(),
    },
    action: { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} },
    i18n: { getUILanguage: () => "en" },
    alarms: { create: async () => {}, onAlarm: event() },
    runtime: {
      getURL: (path) => path,
      getBrowserInfo: async () => ({
        name: "Firefox",
        vendor: "Mozilla",
        version: "159.0",
        buildID: "20261022150525",
      }),
      onStartup: event(),
      onInstalled: event(),
    },
    permissions: {
      contains: async ({ permissions = [], origins = [] }) =>
        [...permissions, ...origins].every((p) => state.permissions.has(p)),
      onAdded: event(),
      onRemoved: event(),
    },
    tabs: {
      get: async (tabId) => {
        const tab = state.tabs.get(tabId);
        if (!tab) throw new Error(`Invalid tab ID: ${tabId}`);
        return { ...tab };
      },
      query: async () => [...state.tabs.values()].map((tab) => ({ ...tab })),
      create: async ({ url }) => {
        const tab = {
          id: state.nextTab++,
          url,
          status: "complete",
          active: false,
          cookieStoreId: "firefox-default",
        };
        createTab(tab);
        return { ...tab };
      },
      update: async (tabId, { url }) => {
        state.updates.push({ tabId, url });
        navigate(tabId, url);
        return { ...state.tabs.get(tabId) };
      },
      remove: async (tabId) => {
        state.removed.push(tabId);
        state.tabs.delete(tabId);
      },
      reload: async (tabId) => navigate(tabId, state.tabs.get(tabId).url),
      goBack: async (tabId) => {
        if (options.history?.back) navigate(tabId, options.history.back);
      },
      goForward: async (tabId) => {
        if (options.history?.forward) navigate(tabId, options.history.forward);
      },
      group: async ({ tabIds, groupId }) => {
        state.groups.push({ tabIds, groupId });
        return groupId ?? 1793637578864036;
      },
      captureTab: async (tabId, captureOptions) => {
        state.captures.push({ tabId, ...captureOptions });
        return `data:image/${captureOptions.format};base64,SU1BR0U=`;
      },
      onRemoved: event(),
      onUpdated: event(),
    },
    tabGroups: { update: async () => {}, onRemoved: event() },
    windows: {
      create: async () => {
        const tab = {
          id: state.nextTab++,
          url: "about:blank",
          status: "complete",
          cookieStoreId: "firefox-default",
        };
        createTab(tab);
        return { id: 3, focused: true, tabs: [{ ...tab }] };
      },
    },
    webNavigation,
    webRequest: {
      onBeforeRequest: event(),
      onBeforeRedirect: event(),
      onBeforeSendHeaders: event(),
      onHeadersReceived: event(),
      getSecurityInfo: async () => undefined,
      onCompleted: event(),
      onErrorOccurred: event(),
      filterResponseData: (requestId) => {
        const filter = { requestId, written: [], closed: false, disconnected: false };
        filter.write = (data) => filter.written.push(new Uint8Array(data));
        filter.close = () => {
          filter.closed = true;
        };
        filter.disconnect = () => {
          filter.disconnected = true;
        };
        (state.filters ??= []).push(filter);
        return filter;
      },
    },
    scripting: {
      executeScript: async (injection) => {
        const documentId = documentFor(injection.target);
        state.executed.push({
          target: injection.target,
          files: injection.files,
          args: injection.args,
          injectImmediately: injection.injectImmediately,
        });
        const frameId = state.documents.get(documentId).frameId;
        if (injection.files) {
          state.installed.add(documentId);
          return [{ frameId, documentId }];
        }
        globalThis.__omwPage = state.installed.has(documentId)
          ? (op, args) => state.page(op, args, documentId)
          : undefined;
        try {
          return [{ frameId, documentId, result: await injection.func(...(injection.args ?? [])) }];
        } finally {
          delete globalThis.__omwPage;
        }
      },
    },
    userScripts: {
      execute: async (injection) => {
        state.userScripts.push(injection);
        return [
          { frameId: 0, documentId: documentFor(injection.target), result: options.evaluate },
        ];
      },
    },
    cookies: {
      getAll: async (details) => {
        state.cookieQueries.push(details);
        return structuredClone(state.cookies);
      },
      set: async (details) => {
        state.cookieWrites.push(details);
      },
      remove: async (details) => {
        state.cookieRemovals.push(details);
      },
    },
    // options.downloadItems answers search, a completed download by default;
    // options.cancel runs for each cancel and may reject like Firefox.
    downloads: {
      download: async (details) => {
        state.downloads.push(details);
        return 41;
      },
      search: async ({ id }) =>
        options.downloadItems?.(id) ?? [
          {
            id,
            state: "complete",
            filename: "/Users/test/Downloads/file.txt",
            fileSize: 4,
            mime: "text/plain",
          },
        ],
      cancel: async (id) => {
        state.cancelled.push(id);
        await options.cancel?.(id);
      },
    },
  };
  return { chrome, state };
}
