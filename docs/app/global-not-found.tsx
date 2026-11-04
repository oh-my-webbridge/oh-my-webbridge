import "./globals.css";
import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { LanguageList } from "@/components/language-list";
import { StandaloneTheme } from "@/components/standalone-theme";
import { siteText } from "@/lib/layout.shared";
import { siteName } from "@/lib/shared";

export const metadata: Metadata = {
  title: `404 · ${siteName}`,
};

/** GitHub Pages returns this file for every missing path, so it speaks English and Chinese and links every language. */
export default function GlobalNotFound() {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col bg-fd-background font-sans text-fd-foreground">
        <StandaloneTheme>
          <main className="mx-auto flex w-full max-w-md grow flex-col justify-center gap-6 px-6 py-16">
            <BrandMark className="size-10" />
            <div className="flex flex-col gap-2">
              <p className="text-meta text-fd-muted-foreground">404</p>
              <h1 className="text-h1">
                {siteText.en.notFoundTitle} ·{" "}
                <span lang="zh-TW">{siteText["zh-tw"].notFoundTitle}</span>
              </h1>
              <p className="text-body text-fd-muted-foreground">{siteText.en.notFoundBody}</p>
              <p lang="zh-TW" className="text-body text-fd-muted-foreground">
                {siteText["zh-tw"].notFoundBody}
              </p>
            </div>
            <LanguageList label={siteText.en.backToDocs} />
          </main>
        </StandaloneTheme>
      </body>
    </html>
  );
}
