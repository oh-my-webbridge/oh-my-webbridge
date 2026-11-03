import { requiredEnv } from "./env";

export const basePath = requiredEnv("NEXT_PUBLIC_BASE_PATH", process.env["NEXT_PUBLIC_BASE_PATH"]);
export const siteOrigin = requiredEnv(
  "NEXT_PUBLIC_SITE_ORIGIN",
  process.env["NEXT_PUBLIC_SITE_ORIGIN"],
);
export const siteName = "oh-my-webbridge";
export const repository = {
  owner: "oh-my-webbridge",
  name: "oh-my-webbridge",
  branch: "main",
  contentDir: "docs/content/docs",
} as const;
export const repositoryUrl = `https://github.com/${repository.owner}/${repository.name}`;

/** The Markdown copy of a page, for "Copy Markdown" and LLM tools. */
export function pageMarkdownPath(slugs: string[]): string {
  return `/md/${[...slugs, "content.md"].join("/")}`;
}

/** Pages are exported as directory indexes (`trailingSlash`), so paths end with a slash. */
export function pagePath(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Absolute URL on the published site. */
export function absoluteUrl(path: string): string {
  return `${siteOrigin}${basePath}${path}`;
}

/** URL of a file under `public/`; string URLs in `<img>` and `<video>` do not get `basePath`. */
export function assetPath(path: string): string {
  return `${basePath}${path}`;
}
