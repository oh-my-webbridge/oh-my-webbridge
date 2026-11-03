import { docsLlms } from "@/lib/source";

export const dynamic = "force-static";

export function GET() {
  return new Response(docsLlms.index(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
