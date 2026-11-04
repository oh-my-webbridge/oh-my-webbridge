import { defineI18n } from "fumadocs-core/i18n";

/**
 * English is the source language. Traditional Chinese (Taiwan) is translated from it, and
 * `scripts/i18n.mjs` converts that text to the Mainland, Hong Kong and Macau variants. A static
 * export has no server to rewrite paths without a language segment, so every path has one
 * (`/en/…`, `/zh-tw/…`). A page without a translation falls back to English.
 */
export const i18n = defineI18n({
  defaultLanguage: "en",
  languages: ["en", "zh-tw", "zh-cn", "zh-hk", "zh-mo"],
  hideLocale: "never",
  parser: "dot",
});

export type Locale = (typeof i18n.languages)[number];

/** BCP 47 tags for `<html lang>`, `hreflang` and Open Graph. */
export const htmlLang = {
  en: "en",
  "zh-tw": "zh-TW",
  "zh-cn": "zh-CN",
  "zh-hk": "zh-HK",
  "zh-mo": "zh-MO",
} as const satisfies Record<Locale, string>;

/** Each language name in that language, for the language menus. */
export const languageNames = {
  en: "English",
  "zh-tw": "繁體中文（台灣）",
  "zh-cn": "简体中文",
  "zh-hk": "繁體中文（香港）",
  "zh-mo": "繁體中文（澳門）",
} as const satisfies Record<Locale, string>;

export function isLocale(value: string): value is Locale {
  return i18n.languages.some((language) => language === value);
}

/** The docs language for a BCP 47 tag such as `zh-Hant-HK`; Chinese without a region is `zh-cn`. */
export function matchLocale(tag: string): Locale {
  const parts = tag.toLowerCase().replaceAll("_", "-").split("-");
  if (parts[0] !== "zh") return "en";
  if (parts.includes("hk")) return "zh-hk";
  if (parts.includes("mo")) return "zh-mo";
  if (parts.includes("tw") || parts.includes("hant")) return "zh-tw";
  return "zh-cn";
}
