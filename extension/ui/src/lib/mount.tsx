import { StrictMode } from "react";
import type * as React from "react";
import { createRoot } from "react-dom/client";
import "@/styles.css";
import { I18nProvider } from "@/lib/i18n";
import { followSystemTheme } from "@/lib/theme";

export function mount(page: React.ReactElement): void {
  followSystemTheme();
  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>{page}</I18nProvider>
    </StrictMode>,
  );
}
