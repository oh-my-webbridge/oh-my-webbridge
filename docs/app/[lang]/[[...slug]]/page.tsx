import { ViewOptionsPopover } from "fumadocs-extras/page-actions";
import { GitChangelog } from "fumadocs-page-history/ui";
import {
  DocsBody,
  DocsPage,
  MarkdownCopyButton,
  PageLastUpdate,
} from "fumadocs-ui/layouts/docs/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { htmlLang, i18n, isLocale, type Locale } from "@/lib/i18n";
import { siteText } from "@/lib/layout.shared";
import { PAGE_HISTORY_IDS, pageHistoryToc, readPageHistory } from "@/lib/page-history";
import {
  absoluteUrl,
  pageImagePath,
  pageMarkdownPath,
  pagePath,
  repository,
  repositoryUrl,
  siteName,
} from "@/lib/shared";
import { type DocsPage as Page, source } from "@/lib/source";

export const dynamicParams = false;

/** The page action menu has English, Simplified and Traditional Chinese text. */
const pageActionLocale = {
  en: "en",
  "zh-tw": "zh-TW",
  "zh-cn": "zh-CN",
  "zh-hk": "zh-TW",
  "zh-mo": "zh-TW",
} as const satisfies Record<Locale, "en" | "zh-CN" | "zh-TW">;

export function generateStaticParams() {
  return source.generateParams("slug", "lang");
}

interface PageProps {
  params: Promise<{ lang: string; slug?: string[] }>;
}

async function resolvePage({ params }: PageProps): Promise<{ page: Page; locale: Locale }> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const page = source.getPage(slug, lang);
  if (!page) notFound();
  return { page, locale: lang };
}

export default async function DocPage(props: PageProps) {
  const { page, locale } = await resolvePage(props);
  const MDX = page.data.body;
  const markdownUrl = pageMarkdownPath(page);
  const commits = await readPageHistory(page.path);
  return (
    <DocsPage
      toc={commits.length > 0 ? [...page.data.toc, ...pageHistoryToc] : page.data.toc}
      full={page.data.full}
      // The table of contents is the section navigation of the page, named by its heading.
      tableOfContent={{
        style: "clerk",
        container: { role: "navigation", "aria-labelledby": "toc-title" },
      }}
      // The sidebar page tree shows the hierarchy.
      breadcrumb={{ enabled: false }}
      className="sm:px-6 md:px-8 md:pt-8 xl:pt-8"
    >
      {/* The Fumadocs title and description components carry their own sizes, so plain elements take the type roles. */}
      <h1 className="text-h1">{page.data.title}</h1>
      {page.data.description !== undefined && (
        <p className="text-body text-fd-muted-foreground">{page.data.description}</p>
      )}
      <div className="flex flex-row flex-wrap items-center gap-2 border-b pb-6">
        {/* Both page actions link through Next.js, which adds basePath; they take unprefixed paths. */}
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`${repositoryUrl}/blob/${repository.branch}/${repository.contentDir}/${page.path}`}
          // The prompt sent to an AI chat links the published page, also in a local preview.
          pageUrl={absoluteUrl(pagePath(page.url))}
          locale={pageActionLocale[locale]}
        />
      </div>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
      {commits.length > 0 ? (
        <GitChangelog
          commits={commits}
          locale={htmlLang[locale]}
          repository={{ url: repositoryUrl }}
          id={PAGE_HISTORY_IDS.history}
          contributorsId={PAGE_HISTORY_IDS.contributors}
          className="omw-page-history"
        />
      ) : (
        page.data.lastModified && <PageLastUpdate date={page.data.lastModified} />
      )}
    </DocsPage>
  );
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { page, locale } = await resolvePage(props);
  const section = siteText[locale].byline;
  const image = absoluteUrl(pageImagePath(page));
  const url = absoluteUrl(pagePath(page.url));
  const languages = Object.fromEntries(
    i18n.languages.map((language) => [
      htmlLang[language],
      absoluteUrl(pagePath(source.getPage(page.slugs, language)?.url ?? page.url)),
    ]),
  );
  return {
    title:
      page.slugs.length === 0
        ? `${siteName} ${section}`
        : `${page.data.title} · ${siteName} ${section}`,
    description: page.data.description,
    alternates: { canonical: url, languages },
    openGraph: {
      type: "article",
      siteName: `${siteName} ${section}`,
      title: page.data.title,
      description: page.data.description,
      url,
      locale: htmlLang[locale],
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", images: [image] },
  };
}
