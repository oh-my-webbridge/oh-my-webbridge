import { createMDX } from "fumadocs-mdx/next";
import { join } from "node:path";
import { basePath, siteOrigin } from "./site.config.ts";

const workspaceRoot = join(import.meta.dirname, "..");

/** @type {import('next').NextConfig} */
const config = {
  // GitHub Pages serves static files: pages, Markdown copies and the search index are built ahead of time.
  output: "export",
  // Pages are written as `<path>/index.html`, which GitHub Pages serves for `/<path>/`.
  trailingSlash: true,
  basePath,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_SITE_ORIGIN: siteOrigin,
  },
  // Type checking runs from the repository root with oxlint --type-aware --type-check.
  typescript: { ignoreBuildErrors: true },
};

export default createMDX()(config);
