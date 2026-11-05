import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { LanguageList } from "@/components/language-list";
import { siteText } from "@/lib/layout.shared";
import { absoluteUrl, basePath, siteName } from "@/lib/shared";

export const metadata: Metadata = {
  title: `${siteName} ${siteText.en.byline}`,
  description: siteText.en.description,
  alternates: { canonical: absoluteUrl("/en/") },
};

/**
 * Sends the reader to the docs in the first browser language, with the same mapping as
 * `matchLocale` in lib/i18n.ts. The list stays for readers without scripts.
 */
const redirect = `(() => {
  const parts = (navigator.languages[0] ?? navigator.language ?? '').toLowerCase().split('-');
  let locale = 'en';
  if (parts[0] === 'zh') {
    if (parts.includes('hk')) locale = 'zh-hk';
    else if (parts.includes('mo')) locale = 'zh-mo';
    else if (parts.includes('tw') || parts.includes('hant')) locale = 'zh-tw';
    else locale = 'zh-cn';
  }
  location.replace('${basePath}/' + locale + '/');
})();`;

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-md grow flex-col justify-center gap-6 px-6 py-16">
      <script dangerouslySetInnerHTML={{ __html: redirect }} />
      <div className="flex items-center gap-3">
        <BrandMark className="size-10" />
        <h1 className="text-h1">{siteName}</h1>
      </div>
      <LanguageList label={siteText.en.chooseLanguage} />
    </main>
  );
}
