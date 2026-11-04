import { FlagCn, FlagHk, FlagMo, FlagTw, FlagUs } from "@sankyu/react-circle-flags";
import type { Locale } from "@/lib/i18n";

const flags = { en: FlagUs, "zh-tw": FlagTw, "zh-cn": FlagCn, "zh-hk": FlagHk, "zh-mo": FlagMo };

/**
 * The round flag of a docs language. The language name next to it is the label, so the flag is
 * hidden from assistive technology.
 */
export function Flag({ locale, className }: { locale: Locale; className?: string }) {
  const Component = flags[locale];
  return (
    <Component
      aria-hidden="true"
      className={className ?? "size-4 shrink-0"}
      width={16}
      height={16}
      title=""
    />
  );
}
