const repository = "oh-my-webbridge/oh-my-webbridge";
export const latestReleaseEndpoint = `https://api.github.com/repos/${repository}/releases/latest`;
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const releaseOrder = new Intl.Collator("en", { numeric: true });
const interval = 24 * 60 * 60 * 1000;

type ReleaseCache = {
  attemptedAt: number;
  latest?: string;
  unavailable?: boolean;
  resumed?: boolean;
};
export type ReleaseCheck = { checkForReleases?: boolean; releaseCache?: ReleaseCache };

export async function readReleaseCheck(): Promise<ReleaseCheck> {
  return chrome.storage.local.get(["checkForReleases", "releaseCache"]);
}

export function releasePage(version: string): string {
  return `https://github.com/${repository}/releases/tag/v${version}`;
}

export function releaseUpdate(latest: string, extension: string, daemon?: string) {
  const older = (version: string | undefined): boolean =>
    !!version && stableVersion.test(version) && releaseOrder.compare(version, latest) < 0;
  const extensionOlder = older(extension);
  const daemonOlder = older(daemon);
  if (extensionOlder && daemonOlder) return "releaseUpdateBoth";
  if (extensionOlder) return "releaseUpdateExtension";
  if (daemonOlder) return "releaseUpdateDaemon";
  return undefined;
}

async function fetchLatest(signal: AbortSignal): Promise<string> {
  const response = await fetch(latestReleaseEndpoint, {
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const release = (await response.json()) as {
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
  } | null;
  const tag = release?.tag_name;
  if (
    release?.draft !== false ||
    release.prerelease !== false ||
    typeof tag !== "string" ||
    !tag.startsWith("v") ||
    !stableVersion.test(tag.slice(1))
  )
    throw new Error("GitHub returned an invalid stable release tag");
  return tag.slice(1);
}

// Start once in the background. The persisted attempt time also bounds
// requests after an offline error or a service worker restart.
export function startReleaseCheck(): void {
  let active: AbortController | undefined;
  const check = async (resumeIncomplete: boolean): Promise<void> => {
    if (active) return;
    const controller = new AbortController();
    const { signal } = controller;
    active = controller;
    try {
      const { checkForReleases, releaseCache } = await readReleaseCheck();
      const attemptedAt = Date.now();
      if (signal.aborted || checkForReleases === false) return;
      const recent =
        releaseCache &&
        attemptedAt >= releaseCache.attemptedAt &&
        attemptedAt - releaseCache.attemptedAt < interval;
      // Re-enabling can resume an unfinished first lookup once in this window.
      if (
        recent &&
        (!resumeIncomplete ||
          releaseCache.latest ||
          releaseCache.unavailable !== undefined ||
          releaseCache.resumed)
      )
        return;
      const next: ReleaseCache = { ...releaseCache, attemptedAt };
      if (recent) next.resumed = true;
      else delete next.resumed;
      await chrome.storage.local.set({ releaseCache: next });
      if (signal.aborted) return;
      try {
        next.latest = await fetchLatest(signal);
        next.unavailable = false;
      } catch {
        next.unavailable = true;
      }
      if (!signal.aborted) await chrome.storage.local.set({ releaseCache: next });
    } finally {
      if (active === controller) active = undefined;
    }
  };
  const run = (resumeIncomplete = false): void =>
    void check(resumeIncomplete).catch((error: Error) =>
      console.error("save release check", error.message),
    );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.checkForReleases) return;
    if (changes.checkForReleases.newValue !== false)
      run(changes.checkForReleases.oldValue === false);
    else {
      active?.abort();
      active = undefined;
    }
  });
  chrome.alarms.onAlarm.addListener(({ name }) => {
    if (name === "check-release") run();
  });
  void chrome.alarms.create("check-release", { periodInMinutes: 60 });
  run();
}
