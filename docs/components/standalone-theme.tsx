import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";

/**
 * Theme for documents without the docs layout (the language entry page and the not-found page):
 * the same Fumadocs theme provider as the docs pages, which follows the system by default. These
 * pages have no search.
 */
export function StandaloneTheme({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{ enabled: false }}
      theme={{ defaultTheme: "system", enableSystem: true, disableTransitionOnChange: true }}
    >
      {children}
    </RootProvider>
  );
}
