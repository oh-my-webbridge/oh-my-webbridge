// State that the background publishes for the toolbar icon, the popup and the
// app page. The background owns every write; the pages only read it, except
// for the token and preferences in chrome.storage.local.
import type { LanguageChoice } from "./i18n.js";

export const daemonOrigin = "http://127.0.0.1:17373";

// unpaired: no token is saved. offline: the daemon does not answer.
// rejected: the daemon answers but refuses this connection, for example a wrong
// token or another profile of the same browser holding the connection.
export type ConnectionState =
  | "unpaired"
  | "paused"
  | "connecting"
  | "offline"
  | "rejected"
  | "connected";
export type Connection = { state: ConnectionState; since: number };

// A tab that a session owns or borrowed. `busy` is true while an action runs.
export type Control = { session: string; borrowed: boolean; busy: boolean };
export type Controls = Record<string, Control>;

export type Preferences = { activityLayer: boolean; language: LanguageChoice };
export const defaultPreferences: Preferences = { activityLayer: true, language: "auto" };

export type Settings = { token?: string; paused?: boolean; preferences?: Partial<Preferences> };

export async function readConnection(): Promise<Connection> {
  const { connection } = (await chrome.storage.session.get("connection")) as {
    connection?: Connection;
  };
  return connection ?? { state: "connecting", since: Date.now() };
}

export async function readControls(): Promise<Controls> {
  const { controls } = (await chrome.storage.session.get("controls")) as { controls?: Controls };
  return controls ?? {};
}

export async function readPreferences(): Promise<Preferences> {
  const { preferences } = (await chrome.storage.local.get("preferences")) as Settings;
  return { ...defaultPreferences, ...preferences };
}

export const validToken = (token: string | undefined): token is string =>
  /^[a-f0-9]{64}$/u.test(token ?? "");

// Whether the daemon answers on its fixed address. Extension pages and the
// background may call it before they have a token.
export async function daemonRunning(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${daemonOrigin}/ping`, {
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    // A refused connection or timeout means no daemon is listening.
    return false;
  }
}

export type PairResult = { ok: true } | { ok: false; reason: "invalid" | "offline" };

// Redeems a code from `omw pair` and saves the token it returns.
export async function pair(code: string): Promise<PairResult> {
  let response: Response;
  try {
    response = await fetch(`${daemonOrigin}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { ok: false, reason: "offline" };
  }
  if (!response.ok) return { ok: false, reason: "invalid" };
  const { token } = (await response.json()) as { token?: string };
  if (!validToken(token)) throw new Error("the daemon returned a malformed token");
  await chrome.storage.local.set({ token, paused: false });
  return { ok: true };
}
