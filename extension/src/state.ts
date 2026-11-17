import type { Preset } from "./presets.js";
import { expired, fail, type Args, type Budget } from "./protocol.js";

export type Session = {
  tabs: number[];
  borrowed: number[];
  current?: number;
  group?: number;
  title: string;
  settings?: Args;
  preset?: Preset;
};
const sessions = new Map<string, Session>();
let saving = Promise.resolve();
let revision = 0;
let written = 0;
let loaded: Promise<void> | undefined;
// Restores persisted sessions once per background instance. `release` receives
// every persisted task and borrowed tab so the browser backend can drop state
// inherited from the previous instance (Chrome detaches its debugger sessions);
// commands wait for it, so none runs on inherited state. Page CDP clients ended
// with the previous instance's daemon connection, so their sessions are dropped
// once their tabs are released and are not reported in hello.
export function initSessions(release: (tabIds: number[]) => Promise<void>): Promise<void> {
  if (loaded) fail("internal", "session state is already initialized");
  loaded = restore(release);
  return loaded;
}
async function restore(release: (tabIds: number[]) => Promise<void>): Promise<void> {
  const stored: { sessions?: Record<string, Session> } =
    await chrome.storage.session.get("sessions");
  for (const [name, session] of Object.entries(stored.sessions ?? {})) sessions.set(name, session);
  await release([...sessions.values()].flatMap((s) => [...s.tabs, ...s.borrowed]));
  if (takePageClients().length) await persist();
  else for (const listener of listeners) listener();
}
async function ready(): Promise<void> {
  if (!loaded) fail("internal", "session state is not initialized");
  await loaded;
}
// Session names reported to the daemon in hello; getSession keeps at most 128.
export async function sessionNames(): Promise<string[]> {
  await ready();
  return [...sessions.keys()];
}

// The daemon opens a cdp-<id> session for each page CDP client
// (/devtools/page/{tab}) and ends it with cdp_detach when the client
// disconnects. It cannot send cdp_detach once its connection to this worker
// has ended, so these sessions last only as long as that connection.
export function pageClient(name: string): boolean {
  return /^cdp-[a-f0-9]{32}$/u.test(name);
}
// Removes the page CDP client sessions and returns them.
export function takePageClients(): Session[] {
  const taken: Session[] = [];
  for (const [name, s] of sessions)
    if (pageClient(name)) {
      sessions.delete(name);
      taken.push(s);
    }
  return taken;
}

// The current tab of an existing session, without creating the session.
export function currentTab(name: string): number | undefined {
  return sessions.get(name)?.current;
}
export async function getSession(name: string): Promise<Session> {
  await ready();
  if (!/^[\p{L}\p{N}_.-]{1,96}$/u.test(name)) fail("invalid_args", "invalid session name");
  let session = sessions.get(name);
  if (!session) {
    if (sessions.size >= 128) fail("busy", "128 sessions already exist; close a session first");
    session = { tabs: [], borrowed: [], title: name };
    sessions.set(name, session);
  }
  return session;
}
const listeners = new Set<() => void>();
// Runs after every change that persist records; the toolbar icon and the
// activity layer follow the controlled tabs this way.
export function onSessionsChanged(listener: () => void): void {
  listeners.add(listener);
}
// Tabs that a session owns or borrowed.
export function controlledTabs(): Map<number, { session: string; borrowed: boolean }> {
  const tabs = new Map<number, { session: string; borrowed: boolean }>();
  for (const [name, s] of sessions) {
    for (const tabId of s.tabs) tabs.set(tabId, { session: name, borrowed: false });
    for (const tabId of s.borrowed) tabs.set(tabId, { session: name, borrowed: true });
  }
  return tabs;
}
export function persist(): Promise<void> {
  for (const listener of listeners) listener();
  const version = ++revision;
  const previous = saving;
  const next = (async () => {
    await previous;
    if (written >= version) return;
    // Clone only at the write boundary. Bursts share the newest snapshot rather
    // than retaining one complete session graph per queued persistence call.
    const snapshot = structuredClone(Object.fromEntries(sessions));
    const captured = revision;
    await chrome.storage.session.set({ sessions: snapshot });
    written = captured;
  })();
  saving = next.catch((error: Error) => console.error("session persistence failed", error.message));
  return next;
}
export function owner(tabId: number): string | undefined {
  for (const [name, s] of sessions)
    if (s.tabs.includes(tabId) || s.borrowed.includes(tabId)) return name;
}
export function assertOwner(name: string, tabId: number): void {
  if (owner(tabId) !== name) fail("tab_busy", `tab ${tabId} is not owned by session ${name}`);
}
export function claim(name: string, s: Session, tabId: number, borrowed: boolean): void {
  const existing = owner(tabId);
  if (existing && existing !== name) fail("tab_busy", `tab ${tabId} belongs to ${existing}`);
  if (s.tabs.length + s.borrowed.length >= 32 && existing !== name)
    fail("busy", "32 tabs per session maximum");
  const list = borrowed ? s.borrowed : s.tabs;
  if (!list.includes(tabId) && !s.tabs.includes(tabId)) list.push(tabId);
  s.current = tabId;
}
export async function release(name: string): Promise<void> {
  sessions.delete(name);
  await persist();
}
// A tab closed outside close_tab, by the user, the page or its window, leaves
// its session. A session whose current tab it was has no current tab, so the
// next page action names its tab or fails with no_tab.
export async function removed(tabId: number): Promise<void> {
  await ready();
  for (const s of sessions.values()) {
    s.tabs = s.tabs.filter((id) => id !== tabId);
    if (!s.tabs.length) s.group = undefined;
    s.borrowed = s.borrowed.filter((id) => id !== tabId);
    if (s.current === tabId) s.current = undefined;
  }
  await persist();
}
// The session lets go of tabId through close_tab or the end of a page CDP
// client. When it was the current tab, the session continues in its last other
// task tab, else its last other borrowed tab. close_tab calls this before it
// closes the tab, since removed() can run before chrome.tabs.remove resolves.
export function leaveTab(s: Session, tabId: number): void {
  if (s.current !== tabId) return;
  const others = (ids: number[]): number[] => ids.filter((id) => id !== tabId);
  s.current = others(s.tabs).at(-1) ?? others(s.borrowed).at(-1);
}
// A command addressed a tab that no longer exists.
export function closedTab(tabId: number): never {
  fail("tab_missing", `tab ${tabId} was closed`);
}
export async function removedGroup(groupId: number): Promise<void> {
  await ready();
  for (const s of sessions.values()) if (s.group === groupId) s.group = undefined;
  await persist();
}
// The committed URL, or the pending one while the tab has not committed a
// document: Chrome then reports url as an empty string.
export function tabURL(tab: chrome.tabs.Tab): string {
  return tab.url || tab.pendingUrl || "";
}
export function webTab(tab: chrome.tabs.Tab): boolean {
  const url = tabURL(tab);
  return !tab.incognito && (/^https?:\/\//u.test(url) || url === "about:blank");
}

// Borrow exactly the page the user identified, without activating its window.
export async function borrowTab(
  name: string,
  session: Session,
  args: Args,
  browser: "chrome" | "firefox",
  budget: Budget,
): Promise<object> {
  if ((args.url === undefined) === (args.tabId === undefined))
    fail("invalid_args", "borrow_tab requires either an exact URL or a tabId");
  let tab: chrome.tabs.Tab;
  if (args.tabId !== undefined) {
    if (!Number.isSafeInteger(args.tabId) || args.tabId < 0)
      fail("invalid_args", "tabId must be a non-negative integer");
    tab = await chrome.tabs.get(args.tabId);
  } else {
    if (typeof args.url !== "string" || !URL.canParse(args.url) || !/^https?:\/\//u.test(args.url))
      fail("invalid_args", "url must be a complete HTTP(S) URL");
    const address = new URL(args.url);
    const candidates = await chrome.tabs.query({
      url: `${address.protocol}//${address.hostname}/*`,
    });
    const matches = candidates.filter((t) => !t.incognito && tabURL(t) === address.href);
    if (!matches[0]) fail("tab_missing", "no tab matches the exact URL");
    if (matches.length > 1) fail("ambiguous_tab", "multiple tabs match this URL; specify a tabId");
    tab = matches[0];
  }
  const url = tabURL(tab);
  if (!tab.id || tab.incognito || !/^https?:\/\//u.test(url))
    fail("restricted_tab", "borrowing requires a non-private HTTP(S) page");
  const address = new URL(url);
  if (
    (browser === "chrome" &&
      (address.hostname === "chromewebstore.google.com" ||
        (address.hostname === "chrome.google.com" && address.pathname.startsWith("/webstore")))) ||
    (browser === "firefox" && address.hostname === "addons.mozilla.org")
  )
    fail("restricted_tab", "this browser store page cannot be borrowed");
  budget.check();
  if (sessions.get(name) !== session) expired("the session was closed");
  claim(name, session, tab.id, !session.tabs.includes(tab.id));
  await persist();
  return { success: true, tabId: tab.id, url, borrowed: session.borrowed.includes(tab.id) };
}
