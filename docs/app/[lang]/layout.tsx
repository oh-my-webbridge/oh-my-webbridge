import "../globals.css";
import { i18nProvider } from "fumadocs-ui/i18n";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { DocsBar, NoSidebarTitle } from "@/components/docs-bar";
import DocsSearchDialog from "@/components/search";
import { SiteHeader } from "@/components/site-header";
import { htmlLang, i18n, isLocale } from "@/lib/i18n";
import { layoutOptions, siteText, translations } from "@/lib/layout.shared";
import { absoluteUrl } from "@/lib/shared";
import { source } from "@/lib/source";

export const dynamicParams = false;

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

interface LayoutProps {
  params: Promise<{ lang: string }>;
  children: ReactNode;
}

export async function generateMetadata({ params }: LayoutProps): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  return {
    metadataBase: new URL(absoluteUrl("/")),
    description: siteText[lang].description,
  };
}

export default async function Layout({ params, children }: LayoutProps) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  return (
    <html lang={htmlLang[lang]} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        <RootProvider
          i18n={i18nProvider(translations, lang)}
          search={{ SearchDialog: DocsSearchDialog }}
          theme={{ defaultTheme: "system", enableSystem: true, disableTransitionOnChange: true }}
        >
          <SiteHeader locale={lang} />
          <DocsLayout
            {...layoutOptions}
            tree={source.getPageTree(lang)}
            slots={{ header: DocsBar, navTitle: NoSidebarTitle }}
            sidebar={{ collapsible: false }}
          >
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
