import { notFound } from "next/navigation";
import { docsLlms, publicPage, source } from "@/lib/source";

export const dynamic = "force-static";
export const dynamicParams = false;

const fileName = "content.md";

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: [...page.slugs, fileName] }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  if (slug.at(-1) !== fileName) notFound();
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();
  return new Response(await docsLlms.page(publicPage(page)), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
