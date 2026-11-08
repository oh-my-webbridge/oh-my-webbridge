import { llms, loader } from "fumadocs-core/source";
import { renderMarkdownUrl } from "fumadocs-extras/llms";
import { defineDocs } from "fumadocs-mdx/macro";
import { i18n, isLocale, languageNames, type Locale } from "./i18n";
import { resolveIcon } from "./icons";
import { fill, sentenceGap, siteText } from "./layout.shared";
import { llmsIndexPath } from "./markdown-path";
import { absoluteUrl, pageMarkdownPath, pagePath } from "./shared";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    lastModified: true,
    postprocess: { includeProcessedMarkdown: true },
  },
});

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/",
  i18n,
  icon: resolveIcon,
});

export type DocsPage = (typeof source)["$inferPage"];

/** The same pages with public URLs (origin and `basePath`), for `llms.txt` and Markdown copies read off-site. */
const publicSource = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/",
  i18n,
  url: (slugs, locale) =>
    absoluteUrl(
      pagePath(`/${[locale, ...slugs].filter((segment) => segment !== undefined).join("/")}`),
    ),
});

/** The developer preview notice of the docs pages, as a Markdown quote. */
function previewNotice(locale: string): string {
  if (!isLocale(locale)) throw new Error(`No site text for locale ${locale}`);
  const text = siteText[locale];
  return `> **${text.previewTitle}**
>
> ${text.previewBody}${sentenceGap(text.previewBody)}**${text.previewWarning}**`;
}

/**
 * Markdown for LLMs. A static site cannot answer `Accept: text/markdown` on a page URL, so the
 * `llms.txt` entries link the Markdown copies, as `remarkContentLinks` does for content links. The
 * heading carries the page URL, and the developer preview notice follows it as on the site.
 */
export const docsLlms = llms(publicSource, {
  renderUrl: renderMarkdownUrl(publicSource, (page) => absoluteUrl(pageMarkdownPath(page))),
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${previewNotice(page.locale ?? i18n.defaultLanguage)}

${await page.data.getText("processed")}`,
});

/** The `<tips>` block of an `llms.txt`: the index of every language, in the language of the index. */
function languageTips(lang: Locale): string {
  const text = siteText[lang];
  const pattern = absoluteUrl(llmsIndexPath(`[${text.languageCode}]`));
  return [
    "<tips>",
    fill(text.llmsIndex, { language: languageNames[lang], pattern: `\`${pattern}\`` }),
    "",
    ...i18n.languages.map(
      (language) =>
        `- ${language}: [${languageNames[language]}](${absoluteUrl(llmsIndexPath(language))})`,
    ),
    "",
    text.llmsSamePath,
    "</tips>",
  ].join("\n");
}

/**
 * The `llms.txt` of a language: the title of its page tree, the site description, the language
 * guide, then the page tree as `index()` of `llms()` lists it.
 */
export function llmsIndex(lang: Locale): string {
  const tree = publicSource.getPageTree(lang);
  if (typeof tree.name !== "string") throw new Error(`The page tree of ${lang} has no text title`);
  return [
    `# ${tree.name}`,
    "",
    `> ${siteText[lang].description}`,
    "",
    languageTips(lang),
    "",
    ...tree.children.map((node) => docsLlms.indexNode(node, lang)),
  ].join("\n");
}

/** The public-URL twin of a site page, for the Markdown routes. */
export function publicPage(page: DocsPage): (typeof publicSource)["$inferPage"] {
  const twin = publicSource.getPage(page.slugs, page.locale);
  if (!twin) throw new Error(`No public twin for ${page.url}`);
  return twin;
}
