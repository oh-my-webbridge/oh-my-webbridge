import { useEffect, useState } from "react";
import type * as React from "react";
import { Settings } from "@/app/settings";
import { Setup } from "@/app/setup";
import { RailPage, type View } from "@/components/rail-page";
import { ToastProvider } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";

const viewOf = (hash: string): View => (hash === "#settings" ? "settings" : "setup");

export function App(): React.ReactElement {
  const { t } = useI18n();
  const [view, setView] = useState<View>(() => viewOf(location.hash));
  useEffect(() => {
    const changed = (): void => setView(viewOf(location.hash));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    document.title = `${t(view === "settings" ? "settingsTitle" : "setupTitle")} · ${t("extensionName")}`;
  }, [view, t]);
  return (
    <ToastProvider>
      <RailPage view={view}>{view === "settings" ? <Settings /> : <Setup />}</RailPage>
    </ToastProvider>
  );
}
