import Link from "next/link";
import { Flag } from "./flag";
import { htmlLang, i18n, languageNames } from "@/lib/i18n";

/** Every docs language as a row with its flag, for the standalone pages. */
export function LanguageList({ label, path = "" }: { label: string; path?: string }) {
  return (
    <nav
      aria-label={label}
      className="flex flex-col overflow-hidden rounded-(--radius-card) border bg-fd-card"
    >
      {i18n.languages.map((language) => (
        <Link
          key={language}
          href={`/${language}${path}`}
          hrefLang={htmlLang[language]}
          lang={htmlLang[language]}
          className="flex items-center gap-3 border-t px-4 py-3 text-card-title first:border-t-0 transition-colors hover:bg-fd-accent"
        >
          <Flag locale={language} className="size-5 shrink-0" />
          {languageNames[language]}
        </Link>
      ))}
    </nav>
  );
}
