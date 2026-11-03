import { StrictMode } from "react";
import type * as React from "react";
import { createRoot } from "react-dom/client";
import "@/styles.css";
import { followSystemTheme } from "@/lib/theme";

export function mount(page: React.ReactElement): void {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  followSystemTheme();
  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");
  createRoot(root).render(<StrictMode>{page}</StrictMode>);
}
