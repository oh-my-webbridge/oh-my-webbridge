import { i18n } from "@/lib/i18n";
import { llmsIndex } from "@/lib/source";

export const dynamic = "force-static";

/** The index of the default language; its language guide links the index of every language. */
export function GET() {
  return new Response(llmsIndex(i18n.defaultLanguage), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
