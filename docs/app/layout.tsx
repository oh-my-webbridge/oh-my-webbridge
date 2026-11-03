import "./globals.css";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import DocsSearchDialog from "@/components/search";
import { absoluteUrl, repositoryUrl, siteName } from "@/lib/shared";
import { source } from "@/lib/source";

export const metadata: Metadata = {
  metadataBase: new URL(absoluteUrl("/")),
  title: { default: siteName, template: `%s · ${siteName}` },
  description:
    "A local browser bridge for agents: a Go daemon, Chrome and Firefox MV3 extensions, task sessions and CDP.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        <RootProvider
          search={{ SearchDialog: DocsSearchDialog }}
          theme={{ defaultTheme: "system", enableSystem: true, disableTransitionOnChange: true }}
        >
          <DocsLayout
            tree={source.getPageTree()}
            nav={{
              title: (
                <span className="flex items-center gap-2 font-semibold">
                  <BrandMark className="size-6" />
                  {siteName}
                </span>
              ),
            }}
            githubUrl={repositoryUrl}
          >
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
