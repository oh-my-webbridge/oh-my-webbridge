import {
  daemonRunning,
  readConnection,
  readControls,
  readPreferences,
  type Connection,
  type Controls,
  type Preferences,
} from "@ext/status.ts";
import { useEffect, useState } from "react";

// Re-reads a value whenever one of the storage keys it depends on changes.
function useStored<T>(
  read: () => Promise<T>,
  keys: string[],
  area: "local" | "session",
): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let live = true;
    const load = (): void => {
      void read().then((next) => {
        if (live) setValue(next);
      });
    };
    const changed = (changes: Record<string, chrome.storage.StorageChange>, name: string): void => {
      if (name === area && keys.some((key) => key in changes)) load();
    };
    load();
    chrome.storage.onChanged.addListener(changed);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(changed);
    };
    // The keys and reader are fixed per call site.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}

export const useConnection = (): Connection | undefined =>
  useStored(readConnection, ["connection"], "session");
export const useControls = (): Controls | undefined =>
  useStored(readControls, ["controls"], "session");
export const usePreferences = (): Preferences | undefined =>
  useStored(readPreferences, ["preferences"], "local");
export const useToken = (): string | undefined =>
  useStored(
    async () => ((await chrome.storage.local.get("token")) as { token?: string }).token ?? "",
    ["token"],
    "local",
  );

// Polls the daemon address while `active`, so a step can complete on its own.
export function useDaemon(active: boolean): boolean | undefined {
  const [running, setRunning] = useState<boolean>();
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      setRunning(
        await daemonRunning(AbortSignal.any([controller.signal, AbortSignal.timeout(2000)])),
      );
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active]);
  return running;
}

// The active tab of the last focused window, read when the page opens.
export function useActiveTab(): chrome.tabs.Tab | undefined {
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  useEffect(() => {
    void chrome.windows
      .getLastFocused({ windowTypes: ["normal"] })
      .then((window) => chrome.tabs.query({ active: true, windowId: window.id }))
      .then(([active]) => setTab(active));
  }, []);
  return tab;
}

// Only Firefox provides runtime.getBrowserInfo.
export const isFirefox = "getBrowserInfo" in chrome.runtime;
export const version = chrome.runtime.getManifest().version;

export async function setPreference<K extends keyof Preferences>(
  key: K,
  value: Preferences[K],
): Promise<void> {
  const current = await readPreferences();
  await chrome.storage.local.set({ preferences: { ...current, [key]: value } });
}

// Opens a page of this extension in a new tab and closes the popup.
export function openPage(path: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
}
