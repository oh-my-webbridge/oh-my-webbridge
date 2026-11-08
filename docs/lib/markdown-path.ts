/** The file name that ends every Markdown copy path, served by `app/md/[lang]/[...slug]/route.ts`. */
export const MARKDOWN_FILE = "content.md";

/** The Markdown copy of a page without `basePath`; `segments` are the locale and the page slugs. */
export function markdownPath(segments: readonly string[]): string {
  return `/md/${[...segments, MARKDOWN_FILE].join("/")}`;
}
