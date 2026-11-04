"use client";

import { useI18n } from "fumadocs-ui/contexts/i18n";
import { useDocsLayout } from "fumadocs-ui/layouts/docs";
import { PanelLeft } from "lucide-react";
import { iconButton } from "./icon-button";
import { isLocale } from "@/lib/i18n";
import { siteText } from "@/lib/layout.shared";

/** The brand lives in the site header, so the sidebar shows no title link. */
export function NoSidebarTitle() {
  return null;
}

/**
 * Below 768px the page tree becomes a drawer; this bar under the site header opens it and search.
 * The breakpoint matches the Fumadocs drawer query `(width < 768px)`. It replaces the Fumadocs
 * small-screen header and keeps the layout row offsets.
 */
export function DocsBar() {
  const { locale } = useI18n();
  const { slots } = useDocsLayout();
  if (locale === undefined || !isLocale(locale)) {
    throw new Error(`The docs bar renders outside a docs language: ${String(locale)}`);
  }
  const SidebarTrigger = slots.sidebar?.trigger;
  const SearchTrigger = slots.searchTrigger === false ? undefined : slots.searchTrigger?.sm;
  return (
    <div className="sticky top-(--fd-docs-row-1) z-30 flex h-(--fd-header-height) items-center justify-between border-b bg-fd-background px-2 [grid-area:header] sm:px-4 md:hidden max-md:layout:[--fd-header-height:--spacing(12)]">
      {SidebarTrigger && (
        <SidebarTrigger className={`${iconButton} w-auto px-2 text-sm hover:text-fd-foreground`}>
          <PanelLeft aria-hidden="true" />
          {siteText[locale].pages}
        </SidebarTrigger>
      )}
      {SearchTrigger && <SearchTrigger className={iconButton} />}
    </div>
  );
}
