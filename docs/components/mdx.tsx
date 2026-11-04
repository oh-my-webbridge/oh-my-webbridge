import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Cards } from "fumadocs-ui/components/card";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { Callout } from "./callout";
import { Card } from "./card";
import { Demo } from "./demo";
import { iconComponents } from "@/lib/icons";
import { routeHref } from "@/lib/shared";

const DefaultLink = defaultMdxComponents.a;

type PreProps = ComponentProps<"pre"> & { "data-label"?: string };

/** A code block whose scroll region `rehypeCodeLabels` has named. */
function LabelledPre({ "data-label": label, children, ref: _ref, ...props }: PreProps) {
  if (label === undefined) throw new Error("A code block reached the page without a label.");
  return (
    <CodeBlock {...props} viewportProps={{ "aria-label": label }}>
      <Pre>{children}</Pre>
    </CodeBlock>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...iconComponents,
    a: ({ href, ...props }: ComponentProps<"a">) => (
      <DefaultLink {...props} href={href === undefined ? href : routeHref(href)} />
    ),
    pre: LabelledPre,
    Accordion,
    Accordions,
    Callout,
    Card,
    // design.md: 16px between cards.
    Cards: (props: ComponentProps<typeof Cards>) => <Cards {...props} className="gap-4" />,
    Demo,
    File,
    Files,
    Folder,
    Step,
    Steps,
    // The panel is drawn on the tabs card, not as an inner rounded surface.
    Tab: (props: ComponentProps<typeof Tab>) => (
      <Tab {...props} className="rounded-none bg-transparent" />
    ),
    // The tab list and the panel are one card; the panel holds no nested card.
    Tabs: (props: ComponentProps<typeof Tabs>) => (
      <Tabs {...props} className="rounded-(--radius-card) bg-fd-card [&>[role=tablist]]:border-b" />
    ),
    TypeTable,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
