import {
  format,
  resolveLanguage,
  type Language,
  type LanguageChoice,
  type MessageKey,
} from "@ext/i18n.ts";
import { createContext, use, useEffect, useMemo } from "react";
import type * as React from "react";
import { usePreferences } from "@/lib/extension";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;
type I18n = { language: Language; choice: LanguageChoice; t: Translate };

const I18nContext = createContext<I18n | undefined>(undefined);

// Renders the page in the language chosen in settings, or in the browser
// language. The page stays empty until the stored choice is read, so it never
// shows a second language first.
export function I18nProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const choice = usePreferences()?.language;
  const value = useMemo((): I18n | undefined => {
    if (choice === undefined) return undefined;
    const language = resolveLanguage(choice);
    return { language, choice, t: (key, values) => format(language, key, values) };
  }, [choice]);
  useEffect(() => {
    if (value) document.documentElement.lang = value.language;
  }, [value]);
  if (!value) return null;
  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18n {
  const value = use(I18nContext);
  if (!value) throw new Error("useI18n needs an I18nProvider");
  return value;
}
