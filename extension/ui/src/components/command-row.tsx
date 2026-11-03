import type * as React from "react";
import { CopyButton } from "@/components/copy-button";
import { t } from "@/lib/i18n";

export function CommandRow({ command }: { command: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card py-1 ps-3 pe-1">
      <span aria-hidden className="select-none font-mono text-muted-foreground text-xs">
        $
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] leading-[18px]">
        {command}
      </code>
      <CopyButton label={t("copyCommand")} value={command} />
    </div>
  );
}
