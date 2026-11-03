import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: { postprocess: { includeProcessedMarkdown: true } },
});

export default defineConfig({
  mdxOptions: {
    // Remote images keep their size attributes; the build does not fetch them.
    remarkImageOptions: { external: false },
    rehypeCodeOptions: { themes: { light: "github-light-default", dark: "github-dark-default" } },
  },
});
