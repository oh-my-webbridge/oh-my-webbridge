// Interface text for the background and the extension pages. The catalogs in
// extension/locales are bundled; en and zh-TW are written by hand and
// scripts/i18n.mjs generates zh-CN, zh-HK and zh-MO from zh-TW with OpenCC.
// The pages and the background use the language chosen in settings, or the
// browser language when the choice is "auto".
import en from "../locales/en.json" with { type: "json" };
import zhCN from "../locales/zh-CN.json" with { type: "json" };
import zhHK from "../locales/zh-HK.json" with { type: "json" };
import zhMO from "../locales/zh-MO.json" with { type: "json" };
import zhTW from "../locales/zh-TW.json" with { type: "json" };

export type MessageKey = keyof typeof en;
type Catalog = Record<MessageKey, string>;

export const languages = ["en", "zh-TW", "zh-CN", "zh-HK", "zh-MO"] as const;
export type Language = (typeof languages)[number];
export type LanguageChoice = Language | "auto";

const catalogs: Record<Language, Catalog> = {
  en,
  "zh-TW": zhTW satisfies Catalog,
  "zh-CN": zhCN satisfies Catalog,
  "zh-HK": zhHK satisfies Catalog,
  "zh-MO": zhMO satisfies Catalog,
};

// Each language name is written in that language, for the language menus.
export const languageNames: Record<Language, string> = {
  en: "English",
  "zh-TW": "繁體中文（台灣）",
  "zh-CN": "简体中文",
  "zh-HK": "繁體中文（香港）",
  "zh-MO": "繁體中文（澳門）",
};

export const isLanguage = (value: string): value is Language =>
  languages.some((language) => language === value);

// Maps a BCP 47 tag such as "zh-Hant-HK" or "en-GB" to a catalog. Chinese
// without a region or script is Simplified Chinese.
export function matchLanguage(tag: string): Language {
  const parts = tag.toLowerCase().replaceAll("_", "-").split("-");
  if (parts[0] !== "zh") return "en";
  if (parts.includes("hk")) return "zh-HK";
  if (parts.includes("mo")) return "zh-MO";
  if (parts.includes("tw") || parts.includes("hant")) return "zh-TW";
  return "zh-CN";
}

export const resolveLanguage = (choice: LanguageChoice): Language =>
  choice === "auto" ? matchLanguage(chrome.i18n.getUILanguage()) : choice;

// Fills {name} placeholders. A missing value is an error, not an empty string.
export function format(
  language: Language,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  return catalogs[language][key].replaceAll(/\{(\w+)\}/gu, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${key}: missing value for {${name}}`);
    return String(value);
  });
}
