import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}): React.ReactElement {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  };
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      aria-label={copied ? t("copied") : label}
      className={className}
      onClick={() => void copy()}
      size="icon-sm"
      variant="ghost"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
