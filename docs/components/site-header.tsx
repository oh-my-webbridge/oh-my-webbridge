import { GitBranch } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "./brand-mark";
import { iconButton } from "./icon-button";
import { LanguageMenu } from "./language-menu";
import { ThemeMenu } from "./theme-menu";
import type { Locale } from "@/lib/i18n";
import { siteText } from "@/lib/layout.shared";
import { repositoryUrl, siteName } from "@/lib/shared";

/** The site header from design.md: the brand on the left; repository, language and theme on the right. */
export function SiteHeader({ locale }: { locale: Locale }) {
  const text = siteText[locale];
  return (
    <header className="sticky top-0 z-40 h-(--omw-header-height) border-b bg-fd-background/75 backdrop-blur-lg backdrop-saturate-150">
      <div className="mx-auto flex h-full max-w-(--fd-layout-width) items-center justify-between gap-4 px-4 sm:px-6">
        {/* The visible text names the link; the spaces keep the words apart for screen readers. */}
        <Link
          href={`/${locale}`}
          className="flex min-w-0 items-center gap-2.5 rounded-(--radius) max-md:min-h-11"
        >
          <BrandMark className="size-7 shrink-0" />
          <span className="truncate font-semibold tracking-(--omw-tracking-heading)">
            {siteName}
          </span>{" "}
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-fd-border" />{" "}
          <span className="shrink-0 text-sm text-fd-muted-foreground">{text.byline}</span>
        </Link>
        <nav className="flex items-center gap-1" aria-label={text.byline}>
          <a
            href={repositoryUrl}
            className={`${iconButton} sm:w-auto sm:px-2.5`}
            aria-label={text.repository}
            title={text.repository}
            target="_blank"
            rel="noreferrer"
          >
            <GitBranch aria-hidden="true" />
            <span className="hidden text-sm font-medium sm:inline">GitHub</span>
          </a>
          <LanguageMenu locale={locale} />
          <ThemeMenu locale={locale} />
        </nav>
      </div>
    </header>
  );
}
