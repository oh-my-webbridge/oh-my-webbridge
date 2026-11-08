import { llms, loader } from "fumadocs-core/source";
import { renderLanguageTips, renderLlmsIndex, renderMarkdownUrl } from "fumadocs-extras/llms";
import { defineDocs } from "fumadocs-mdx/macro";
import { i18n, isLocale, languageNames, type Locale } from "./i18n";
import { resolveIcon } from "./icons";
import { sentenceGap, siteText } from "./layout.shared";
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

/**
 * The `llms.txt` of a language: the title of its page tree, the site description, a `<tips>` block
 * in English that links the index of every language, then the pages.
 */
export function llmsIndex(lang: Locale): string {
  return renderLlmsIndex(publicSource, docsLlms, {
    lang,
    description: siteText[lang].description,
    sections: [
      renderLanguageTips({
        language: lang,
        languages: languageNames,
        indexUrl: (language) => absoluteUrl(llmsIndexPath(language)),
      }),
    ],
  });
}

/** The public-URL twin of a site page, for the Markdown routes. */
export function publicPage(page: DocsPage): (typeof publicSource)["$inferPage"] {
  const twin = publicSource.getPage(page.slugs, page.locale);
  if (!twin) throw new Error(`No public twin for ${page.url}`);
  return twin;
}
