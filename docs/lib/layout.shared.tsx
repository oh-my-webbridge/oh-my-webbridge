import { zhCN } from "@fumadocs/language/zh-cn";
import { zhTW } from "@fumadocs/language/zh-tw";
import { gitChangelogTranslations } from "fumadocs-page-history/i18n";
import { uiTranslations } from "fumadocs-ui/i18n";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import historyZhCN from "../messages/history.zh-cn.json" with { type: "json" };
import historyZhHK from "../messages/history.zh-hk.json" with { type: "json" };
import historyZhMO from "../messages/history.zh-mo.json" with { type: "json" };
import historyZhTW from "../messages/history.zh-tw.json" with { type: "json" };
import en from "../messages/site.en.json" with { type: "json" };
import zhCNText from "../messages/site.zh-cn.json" with { type: "json" };
import zhHKText from "../messages/site.zh-hk.json" with { type: "json" };
import zhMOText from "../messages/site.zh-mo.json" with { type: "json" };
import zhTWText from "../messages/site.zh-tw.json" with { type: "json" };
import { i18n, languageNames, type Locale } from "./i18n";

const history = (name: string, value: Record<string, string>) => ({ name, value });

/**
 * Fumadocs and page-history interface text. The Chinese variants of the page-history text come
 * from `messages/history.zh-tw.json` through `scripts/i18n.mjs`.
 */
export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .extend(gitChangelogTranslations())
  .preset("zh-tw", zhTW())
  .preset("zh-cn", zhCN())
  .preset("zh-hk", zhTW())
  .preset("zh-mo", zhTW())
  .preset("zh-tw", history("zh-TW", historyZhTW))
  .preset("zh-cn", history("zh-CN", historyZhCN))
  .preset("zh-hk", history("zh-HK", historyZhHK))
  .preset("zh-mo", history("zh-MO", historyZhMO))
  .add(
    Object.fromEntries(
      i18n.languages.map((language) => [language, { displayName: languageNames[language] }]),
    ),
  );

type SiteText = typeof en;

/** Site shell text outside the Fumadocs translations, from `messages/site.*.json`. */
export const siteText: Record<Locale, SiteText> = {
  en,
  "zh-tw": zhTWText satisfies SiteText,
  "zh-cn": zhCNText satisfies SiteText,
  "zh-hk": zhHKText satisfies SiteText,
  "zh-mo": zhMOText satisfies SiteText,
};

/** Fills `{name}` placeholders in site text. */
export function fill(text: string, values: Record<string, string | number>): string {
  return text.replaceAll(/\{(\w+)\}/gu, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`"${text}" needs a value for {${name}}`);
    return String(value);
  });
}

/**
 * The brand, language, theme and repository live in the site header; the sidebar keeps search and
 * the page tree. Navigation stays enabled because Fumadocs renders `slots.header` only then; below
 * 768px that slot holds `DocsBar`, which opens the page tree and search. `NoSidebarTitle` empties
 * the sidebar title.
 */
export const layoutOptions: BaseLayoutProps = {
  nav: { enabled: true },
  i18n: false,
  themeSwitch: { enabled: false },
};
