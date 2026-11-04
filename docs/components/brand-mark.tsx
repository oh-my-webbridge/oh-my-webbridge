import { assetPath } from "@/lib/shared";

export function BrandMark({ className }: { className?: string }) {
  return <img alt="" aria-hidden className={className} src={assetPath("/mark.svg")} />;
}
