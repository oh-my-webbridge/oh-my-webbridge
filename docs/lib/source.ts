import { llms, loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";
import { absoluteUrl, pagePath } from "./shared";

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/",
});

export type DocsPage = (typeof source)["$inferPage"];

/** The same pages with absolute URLs, for `llms.txt` and Markdown copies read off-site. */
const publicSource = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/",
  url: (slugs) => absoluteUrl(pagePath(`/${slugs.join("/")}`)),
});

export const docsLlms = llms(publicSource, {
  renderPage: async (page) =>
    `# ${page.data.title} (${page.url})\n\n${await page.data.getText("processed")}`,
});

export function publicPage(page: DocsPage) {
  const match = publicSource.getPage(page.slugs);
  if (!match) throw new Error(`No public page for /${page.slugs.join("/")}`);
  return match;
}
