import { Callout } from "./callout";
import type { Locale } from "@/lib/i18n";
import { sentenceGap, siteText } from "@/lib/layout.shared";

/** The developer preview notice at the top of every docs page. */
export function PreviewNotice({ locale }: { locale: Locale }) {
  const text = siteText[locale];
  return (
    <Callout type="warning" title={text.previewTitle}>
      {text.previewBody}
      {sentenceGap(text.previewBody)}
      <strong className="text-fd-foreground">{text.previewWarning}</strong>
    </Callout>
  );
}
