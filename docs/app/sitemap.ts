import type { MetadataRoute } from "next";
import { htmlLang, i18n } from "@/lib/i18n";
import { absoluteUrl, pagePath } from "@/lib/shared";
import { source } from "@/lib/source";

export const dynamic = "force-static";

/** Every page in every language; each entry lists its other language versions. */
export default function sitemap(): MetadataRoute.Sitemap {
  return source.getLanguages().flatMap(({ pages }) =>
    pages.map((page) => ({
      url: absoluteUrl(pagePath(page.url)),
      lastModified: page.data.lastModified,
      alternates: {
        languages: Object.fromEntries(
          i18n.languages.flatMap((language) => {
            const twin = source.getPage(page.slugs, language);
            return twin === undefined
              ? []
              : [[htmlLang[language], absoluteUrl(pagePath(twin.url))]];
          }),
        ),
      },
    })),
  );
}
