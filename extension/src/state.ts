import type { Preset } from "./presets.js";
import { fail, type Args } from "./protocol.js";

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
  loaded = chrome.storage.session
    .get("sessions")
    .then(async (stored: { sessions?: Record<string, Session> }) => {
      for (const [name, session] of Object.entries(stored.sessions ?? {}))
        sessions.set(name, session);
      await release([...sessions.values()].flatMap((s) => [...s.tabs, ...s.borrowed]));
      if (takePageClients().length) await persist();
      else for (const listener of listeners) listener();
    });
  return loaded;
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
  const next = saving.then(async () => {
    if (written >= version) return;
    // Clone only at the write boundary. Bursts share the newest snapshot rather
    // than retaining one complete session graph per queued persistence call.
    const snapshot = structuredClone(Object.fromEntries(sessions));
    const captured = revision;
    await chrome.storage.session.set({ sessions: snapshot });
    written = captured;
  });
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
export async function removed(tabId: number): Promise<void> {
  await ready();
  for (const s of sessions.values()) {
    s.tabs = s.tabs.filter((id) => id !== tabId);
    if (!s.tabs.length) s.group = undefined;
    s.borrowed = s.borrowed.filter((id) => id !== tabId);
    if (s.current === tabId) s.current = s.tabs.at(-1) ?? s.borrowed.at(-1);
  }
  await persist();
}
export async function removedGroup(groupId: number): Promise<void> {
  await ready();
  for (const s of sessions.values()) if (s.group === groupId) s.group = undefined;
  await persist();
}
export function webTab(tab: chrome.tabs.Tab): boolean {
  return (
    !tab.incognito &&
    (/^https?:\/\//u.test(tab.url ?? tab.pendingUrl ?? "") || tab.url === "about:blank")
  );
}
