import type { ConnectionState } from "@ext/status.ts";
import { BookOpenIcon, PauseIcon, PlayIcon, Settings2Icon } from "lucide-react";
import type * as React from "react";
import { BrandMark } from "@/components/brand-mark";
import { PromptComposer } from "@/components/prompt-composer";
import { ConnectionLabel, StatusLabel } from "@/components/status-label";
import { Button } from "@/components/ui/button";
import { openPage, useActiveTab, useConnection, useControls } from "@/lib/extension";
import { useI18n } from "@/lib/i18n";

const docs = "https://oh-my-webbridge.github.io";

const setupHints = {
  unpaired: "popupHint_unpaired",
  offline: "popupHint_offline",
  rejected: "popupHint_rejected",
} as const satisfies Partial<Record<ConnectionState, string>>;

const needsSetup = (state: ConnectionState): state is keyof typeof setupHints =>
  state in setupHints;

function CurrentTab({ tab }: { tab: chrome.tabs.Tab }): React.ReactElement | null {
  const { t } = useI18n();
  const controls = useControls();
  if (!tab.id || !controls) return null;
  const control = controls[tab.id];
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border bg-card px-3.5">
      <span className="font-medium text-sm">{t("thisTab")}</span>
      {control ? (
        <StatusLabel tone="live">
          {t(control.busy ? "tabWorking" : "tabControlled", { session: control.session })}
        </StatusLabel>
      ) : (
        <StatusLabel tone="muted">{t("tabNotControlled")}</StatusLabel>
      )}
    </div>
  );
}

export function Popup(): React.ReactElement {
  const { t } = useI18n();
  const connection = useConnection();
  const tab = useActiveTab();
  if (!connection) return <div className="h-24 w-[360px]" />;
  const { state } = connection;
  return (
    <main className="flex max-h-[560px] w-[360px] flex-col">
      <header className="flex items-center gap-2.5 border-b px-4 py-3">
        <BrandMark className="size-6" />
        <h1 className="font-semibold text-[15px] leading-5">{t("extensionName")}</h1>
        <ConnectionLabel className="ms-auto" state={state} />
      </header>
      {needsSetup(state) ? (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm">{t(setupHints[state])}</p>
          <Button className="w-full" onClick={() => openPage("app.html")}>
            {t("openSetup")}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 overflow-y-auto p-4">
            {tab && (
              <>
                <CurrentTab tab={tab} />
                <PromptComposer tab={tab} />
              </>
            )}
          </div>
          <footer className="flex items-center gap-1 border-t px-3 py-2">
            <Button
              onClick={() => void chrome.storage.local.set({ paused: state !== "paused" })}
              size="sm"
              variant="ghost"
            >
              {state === "paused" ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
              {t(state === "paused" ? "resume" : "pause")}
            </Button>
            <Button
              className="ms-auto"
              onClick={() => openPage("app.html#settings")}
              size="sm"
              variant="ghost"
            >
              <Settings2Icon aria-hidden />
              {t("settings")}
            </Button>
            <Button
              aria-label={t("documentation")}
              render={<a href={docs} rel="noreferrer" target="_blank" />}
              size="icon-sm"
              variant="ghost"
            >
              <BookOpenIcon aria-hidden />
            </Button>
          </footer>
        </>
      )}
    </main>
  );
}
