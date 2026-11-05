import type { Root } from "hast";
import { visit } from "unist-util-visit";
import type { VFile } from "vfile";
import enText from "../messages/site.en.json" with { type: "json" };
import zhCNText from "../messages/site.zh-cn.json" with { type: "json" };
import zhHKText from "../messages/site.zh-hk.json" with { type: "json" };
import zhMOText from "../messages/site.zh-mo.json" with { type: "json" };
import zhTWText from "../messages/site.zh-tw.json" with { type: "json" };
import { localeOf } from "./remark-content-links.ts";

const labels: Record<string, { codeBlock: string; codeBlockTitled: string }> = {
  en: enText,
  "zh-tw": zhTWText,
  "zh-cn": zhCNText,
  "zh-hk": zhHKText,
  "zh-mo": zhMOText,
};

/**
 * Numbers the code blocks of a page. Each code block sits in a focusable scroll region, and the
 * regions of one page need distinct names: the number, followed by the title when the block has one.
 */
export function rehypeCodeLabels() {
  return (tree: Root, file: VFile) => {
    const locale = localeOf(file.path);
    const text = labels[locale];
    if (text === undefined) throw new Error(`${file.path}: no code block label for "${locale}"`);
    let count = 0;
    visit(tree, "element", (node) => {
      if (node.tagName !== "pre") return;
      count += 1;
      const title = node.properties["title"];
      const label =
        typeof title === "string" && title !== ""
          ? text.codeBlockTitled.replace("{index}", String(count)).replace("{title}", title)
          : text.codeBlock.replace("{index}", String(count));
      node.properties["dataLabel"] = label;
    });
  };
}
