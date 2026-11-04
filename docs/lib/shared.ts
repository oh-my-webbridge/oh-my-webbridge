import { requiredEnv } from "./env";

/** Deployment prefix without a trailing slash, set by `site.config.ts` through `next.config.mjs`. */
export const basePath = requiredEnv("NEXT_PUBLIC_BASE_PATH", process.env["NEXT_PUBLIC_BASE_PATH"]);
export const siteOrigin = requiredEnv(
  "NEXT_PUBLIC_SITE_ORIGIN",
  process.env["NEXT_PUBLIC_SITE_ORIGIN"],
);
export const siteName = "oh-my-webbridge";

export { repository, repositoryUrl } from "./repository";

interface PageRef {
  slugs: string[];
  locale?: string | undefined;
}

function localePath(page: PageRef): string[] {
  if (page.locale === undefined) throw new Error(`Page /${page.slugs.join("/")} has no locale.`);
  return [page.locale, ...page.slugs];
}

/** The Markdown copy of a page, for "Copy Markdown" and LLM tools. Next.js adds no prefix to route handlers. */
export function pageMarkdownPath(page: PageRef): string {
  return `/md/${[...localePath(page), "content.md"].join("/")}`;
}

/** The Open Graph image of a page, rendered at build time. */
export function pageImagePath(page: PageRef): string {
  return `/og/${[...localePath(page), "image.png"].join("/")}`;
}

/**
 * Content links carry the public path (`/en/…` after `basePath`), so links in the Markdown copies
 * work off-site. Route links take the path without `basePath`; Next.js adds it back.
 */
export function routeHref(href: string): string {
  return basePath !== "" && href.startsWith(`${basePath}/`) ? href.slice(basePath.length) : href;
}

/** Pages are exported as directory indexes (`trailingSlash`), so paths end with a slash. */
export function pagePath(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Absolute URL on the published site, for metadata and Markdown output. */
export function absoluteUrl(path: string): string {
  return `${siteOrigin}${basePath}${path}`;
}

/** URL of a file under `public/`; string URLs in `<img>` and `<video>` do not get `basePath`. */
export function assetPath(path: string): string {
  return `${basePath}${path}`;
}
