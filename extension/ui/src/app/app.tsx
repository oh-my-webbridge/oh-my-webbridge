import { useEffect, useState } from "react";
import type * as React from "react";
import { Settings } from "@/app/settings";
import { Setup } from "@/app/setup";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { ToastProvider } from "@/components/ui/toast";
import { t } from "@/lib/i18n";

type View = "setup" | "settings";
const viewOf = (hash: string): View => (hash === "#settings" ? "settings" : "setup");

export function App(): React.ReactElement {
  const [view, setView] = useState<View>(() => viewOf(location.hash));
  useEffect(() => {
    const changed = (): void => setView(viewOf(location.hash));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    document.title = `${t(view === "settings" ? "settings" : "setupTitle")} · ${t("extensionName")}`;
  }, [view]);
  return (
    <ToastProvider>
      <div className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col px-6 pt-8 pb-16 sm:pt-[72px]">
        <header className="mb-10 flex items-start gap-4">
          <BrandMark className="size-16" />
          <div className="min-w-0 flex-1 pt-1">
            <h1 className="font-bold text-[34px] leading-10 tracking-[-0.022em]">
              {t(view === "settings" ? "settings" : "setupTitle")}
            </h1>
            <p className="mt-1 text-muted-foreground text-sm">
              {t(view === "settings" ? "settingsSubtitle" : "setupSubtitle")}
            </p>
          </div>
          <Button
            className="mt-2"
            render={<a href={view === "settings" ? "#setup" : "#settings"} />}
            size="sm"
            variant="ghost"
          >
            {t(view === "settings" ? "setupTitle" : "settings")}
          </Button>
        </header>
        {view === "settings" ? <Settings /> : <Setup />}
      </div>
    </ToastProvider>
  );
}
