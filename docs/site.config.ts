/**
 * Where the docs site is published. The organization Pages site serves it from
 * the domain root, so `DOCS_BASE_PATH` defaults to an empty string. `SITE_ORIGIN`
 * gives absolute URLs to metadata, Markdown copies and `llms.txt`.
 */
export const basePath = normalizeBasePath(process.env["DOCS_BASE_PATH"] ?? "");
export const siteOrigin = normalizeOrigin(
  process.env["SITE_ORIGIN"] ?? "https://oh-my-webbridge.github.io",
);

function normalizeBasePath(value: string): string {
  const base = value.replace(/\/+$/u, "");
  if (base !== "" && !/^(\/[\w.-]+)+$/u.test(base)) {
    throw new Error(
      `DOCS_BASE_PATH must be empty or an absolute path such as "/docs", got "${value}".`,
    );
  }
  return base;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value.replace(/\/+$/u, "").toLowerCase()) {
    throw new Error(`SITE_ORIGIN must be an origin without a path, got "${value}".`);
  }
  return url.origin;
}
