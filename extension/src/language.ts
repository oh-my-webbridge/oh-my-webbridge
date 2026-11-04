// The interface language of the background: the toolbar title and the action
// labels of the activity layer. The indicator sets it from the stored
// preference whenever the preferences change.
import {
  format,
  resolveLanguage,
  type Language,
  type LanguageChoice,
  type MessageKey,
} from "./i18n.js";

let current: Language | undefined;

export function setLanguage(choice: LanguageChoice): void {
  current = resolveLanguage(choice);
}

export const message = (key: MessageKey, values?: Record<string, string | number>): string =>
  format(current ?? resolveLanguage("auto"), key, values);
