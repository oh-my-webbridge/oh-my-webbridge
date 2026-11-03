import mark from "@oh-my-webbridge/brand/icons/mark.svg";
import type * as React from "react";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }): React.ReactElement {
  return (
    <img
      alt=""
      aria-hidden
      className={cn("size-7 select-none", className)}
      draggable={false}
      src={mark}
    />
  );
}
