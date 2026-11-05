import { remarkMdxFiles } from "fumadocs-core/mdx-plugins";
import { defineConfig } from "fumadocs-mdx/config";
import { rehypeCodeLabels } from "./lib/rehype-code-labels.ts";
import { remarkContentLinks } from "./lib/remark-content-links.ts";
import { remarkLabelColumns } from "./lib/remark-label-columns.ts";

// The collection is declared with the macro API in lib/source.ts; this file holds the shared MDX pipeline.
export default defineConfig({
  mdxOptions: {
    // Remote images keep their size attributes; the build does not fetch them.
    remarkImageOptions: { external: false },
    // The comment colors of the GitHub default themes reach 4.5:1 on both code block surfaces.
    rehypeCodeOptions: { themes: { light: "github-light-default", dark: "github-dark-default" } },
    // Content links are rewritten before the Fumadocs plugins, so the Markdown for LLMs also
    // carries page URLs; file trees become components after them and stay as source in Markdown.
    remarkPlugins: (defaults) => [
      remarkContentLinks,
      remarkLabelColumns,
      ...defaults,
      remarkMdxFiles,
    ],
    // Runs after syntax highlighting, which reads the title from the code fence.
    rehypePlugins: (defaults) => [...defaults, rehypeCodeLabels],
  },
});
