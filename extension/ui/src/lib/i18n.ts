// Interface text comes from extension/_locales; chrome.i18n follows the
// browser language.
export function t(key: string, substitutions?: string | string[]): string {
  const message = chrome.i18n.getMessage(key, substitutions);
  if (!message) throw new Error(`missing message: ${key}`);
  return message;
}
