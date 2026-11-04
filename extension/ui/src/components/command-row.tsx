import type * as React from "react";
import { CopyButton } from "@/components/copy-button";
import { useI18n } from "@/lib/i18n";

// The command well: a command to run in a terminal, with a copy button.
export function CommandRow({ command }: { command: string }): React.ReactElement {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 rounded-lg bg-well py-1.5 ps-3.5 pe-1.5 text-well-foreground">
      <span aria-hidden className="select-none type-code opacity-56">
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap type-code [scrollbar-width:none]">
        {command}
      </code>
      <CopyButton
        className="text-well-foreground hover:bg-(--well-hover) data-pressed:bg-(--well-hover)"
        label={t("copyCommand")}
        value={command}
      />
    </div>
  );
}
