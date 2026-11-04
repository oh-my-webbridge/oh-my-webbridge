import { i18n } from "@/lib/i18n";
import { docsLlms } from "@/lib/source";

export const dynamic = "force-static";

/** The index of every language in turn; each starts with the title of its page tree. */
export function GET() {
  const body = i18n.languages.map((lang) => docsLlms.index(lang)).join("\n\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
