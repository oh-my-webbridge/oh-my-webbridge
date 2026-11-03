import { BookOpenIcon, PauseIcon, PlayIcon, SettingsIcon } from "lucide-react";
import type * as React from "react";
import { BrandMark } from "@/components/brand-mark";
import { PromptExamples } from "@/components/prompt-examples";
import { ConnectionLabel, StatusLabel } from "@/components/status-label";
import { Button } from "@/components/ui/button";
import { useActiveTab, useConnection, useControls, openPage } from "@/lib/extension";
import { t } from "@/lib/i18n";

const docs = "https://oh-my-webbridge.github.io";

function CurrentPage(): React.ReactElement | null {
  const tab = useActiveTab();
  const controls = useControls();
  if (!tab?.id || !controls) return null;
  const control = controls[tab.id];
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border bg-card px-3 py-2.5">
      <span className="text-muted-foreground text-sm">{t("thisPage")}</span>
      {control ? (
        <StatusLabel tone="live">
          {t(control.busy ? "pageWorking" : "pageControlled", control.session)}
        </StatusLabel>
      ) : (
        <StatusLabel tone="muted">{t("pageNotControlled")}</StatusLabel>
      )}
    </div>
  );
}

export function Popup(): React.ReactElement {
  const connection = useConnection();
  if (!connection) return <div className="h-24 w-[360px]" />;
  const { state } = connection;
  const needsSetup = state === "unpaired" || state === "offline" || state === "rejected";
  return (
    <main className="flex w-[360px] flex-col gap-3 p-4">
      <header className="flex items-center gap-2.5">
        <BrandMark />
        <h1 className="font-semibold text-[15px] leading-5 tracking-[-0.008em]">
          {t("extensionName")}
        </h1>
        <ConnectionLabel className="ms-auto" state={state} />
      </header>
      {needsSetup ? (
        <>
          <p className="text-muted-foreground text-sm">{t(`popupHint_${state}`)}</p>
          <Button className="w-full" onClick={() => openPage("app.html")}>
            {t("openSetup")}
          </Button>
        </>
      ) : (
        <>
          <CurrentPage />
          <PromptExamples />
          <footer className="-mx-1 flex items-center gap-1">
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
              <SettingsIcon aria-hidden />
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
