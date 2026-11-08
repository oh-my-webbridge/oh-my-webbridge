import { notFound } from "next/navigation";
import { MARKDOWN_FILE } from "@/lib/markdown-path";
import { docsLlms, publicPage, source } from "@/lib/source";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return source
    .getLanguages()
    .flatMap(({ language, pages }) =>
      pages.map((page) => ({ lang: language, slug: [...page.slugs, MARKDOWN_FILE] })),
    );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ lang: string; slug: string[] }> },
) {
  const { lang, slug } = await params;
  if (slug.at(-1) !== MARKDOWN_FILE) notFound();
  const page = source.getPage(slug.slice(0, -1), lang);
  if (!page) notFound();
  return new Response(await docsLlms.page(publicPage(page)), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
