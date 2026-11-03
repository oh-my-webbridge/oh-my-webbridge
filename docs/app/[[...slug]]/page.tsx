import { DocsBody, DocsPage, MarkdownCopyButton } from "fumadocs-ui/layouts/docs/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import { absoluteUrl, pageMarkdownPath, pagePath, repository, repositoryUrl } from "@/lib/shared";
import { type DocsPage as Page, source } from "@/lib/source";

export const dynamicParams = false;

export function generateStaticParams() {
  return source.generateParams();
}

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

async function resolvePage({ params }: PageProps): Promise<Page> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return page;
}

export default async function DocPage(props: PageProps) {
  const page = await resolvePage(props);
  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full} breadcrumb={{ enabled: false }}>
      <h1 className="font-bold text-3xl tracking-[-0.02em]">{page.data.title}</h1>
      {page.data.description !== undefined && (
        <p className="text-fd-muted-foreground">{page.data.description}</p>
      )}
      <div className="flex flex-row flex-wrap items-center gap-2 border-b pb-6">
        <MarkdownCopyButton markdownUrl={pageMarkdownPath(page.slugs)} />
        <a
          className="text-fd-muted-foreground text-sm hover:text-fd-foreground"
          href={`${repositoryUrl}/blob/${repository.branch}/${repository.contentDir}/${page.path}`}
          rel="noreferrer"
          target="_blank"
        >
          Edit on GitHub
        </a>
      </div>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const page = await resolvePage(props);
  const url = absoluteUrl(pagePath(page.url));
  return {
    title: page.slugs.length === 0 ? { absolute: page.data.title } : page.data.title,
    description: page.data.description,
    alternates: { canonical: url },
    openGraph: { type: "article", title: page.data.title, description: page.data.description, url },
  };
}
