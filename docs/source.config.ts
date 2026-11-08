import { remarkMdxFiles } from "fumadocs-core/mdx-plugins";
import { type ContentLinksOptions, remarkContentLinks } from "fumadocs-extras/llms";
import { defineConfig } from "fumadocs-mdx/config";
import { i18n } from "./lib/i18n.ts";
import { markdownPath } from "./lib/markdown-path.ts";
import { rehypeCodeLabels } from "./lib/rehype-code-labels.ts";
import { remarkLabelColumns } from "./lib/remark-label-columns.ts";
import { basePath, siteOrigin } from "./site.config.ts";

/** The locale and slugs of a linked page; every path has a language segment. */
function localeSlugs(slugs: string[], locale: string | undefined): string[] {
  if (locale === undefined) throw new Error(`The link to /${slugs.join("/")} has no locale.`);
  return [locale, ...slugs];
}

/**
 * Links between content files. Markdown copies and `llms-full.txt` are read off-site, so their
 * links are absolute URLs of the linked Markdown copies; the site links the pages.
 */
const contentLinks: ContentLinksOptions = {
  dir: "content/docs",
  i18n,
  markdownUrl: (slugs, locale) =>
    `${siteOrigin}${basePath}${markdownPath(localeSlugs(slugs, locale))}`,
  pageUrl: (slugs, locale) =>
    `${basePath}/${localeSlugs(slugs, locale)
      .map((segment) => `${segment}/`)
      .join("")}`,
};

// The collection is declared with the macro API in lib/source.ts; this file holds the shared MDX pipeline.
export default defineConfig({
  mdxOptions: {
    // Remote images keep their size attributes; the build does not fetch them.
    remarkImageOptions: { external: false },
    // The comment colors of the GitHub default themes reach 4.5:1 on both code block surfaces.
    rehypeCodeOptions: { themes: { light: "github-light-default", dark: "github-dark-default" } },
    // Content links are rewritten before the Fumadocs plugins, so the Markdown for LLMs links the
    // Markdown copies; file trees become components after them and stay as source in Markdown.
    remarkPlugins: (defaults) => [
      [remarkContentLinks, contentLinks],
      remarkLabelColumns,
      ...defaults,
      remarkMdxFiles,
    ],
    // Runs after syntax highlighting, which reads the title from the code fence.
    rehypePlugins: (defaults) => [...defaults, rehypeCodeLabels],
  },
});
