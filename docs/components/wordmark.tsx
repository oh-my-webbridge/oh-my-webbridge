import { assetPath } from "@/lib/shared";

/**
 * The omw wordmark from packages/brand/icons in the version for the current theme. Only the visible
 * image is exposed, so the label is read once.
 */
export function Wordmark({ className, label }: { className?: string; label: string }) {
  return (
    <span className={`flex shrink-0 ${className ?? ""}`}>
      <img alt={label} className="h-full w-auto dark:hidden" src={assetPath("/wordmark.svg")} />
      <img
        alt={label}
        className="hidden h-full w-auto dark:block"
        src={assetPath("/wordmark-dark.svg")}
      />
    </span>
  );
}
