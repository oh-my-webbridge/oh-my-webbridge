import "../globals.css";
import type { ReactNode } from "react";
import { StandaloneTheme } from "@/components/standalone-theme";

/** The language entry page at the site root has its own document; each language is a root layout. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col bg-fd-background font-sans text-fd-foreground">
        <StandaloneTheme>{children}</StandaloneTheme>
      </body>
    </html>
  );
}
