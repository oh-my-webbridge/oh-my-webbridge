import type { ConnectionState } from "@ext/status.ts";
import { AnimatePresence, motion } from "motion/react";
import type * as React from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type Tone = "success" | "live" | "muted" | "danger";

const dot: Record<Tone, string> = {
  success: "bg-success",
  live: "bg-live shadow-[0_0_0_3px] shadow-live/24",
  muted: "bg-muted-foreground/56",
  danger: "bg-destructive",
};

const text: Record<Tone, string> = {
  success: "",
  live: "text-live-ink",
  muted: "text-muted-foreground",
  danger: "text-destructive",
};

export const connectionTone: Record<ConnectionState, Tone> = {
  connected: "success",
  connecting: "muted",
  paused: "muted",
  unpaired: "muted",
  offline: "danger",
  rejected: "danger",
};

// A colored dot with a text label; the label cross-fades when it changes.
export function StatusLabel({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: string;
  className?: string;
}): React.ReactElement {
  return (
    <span
      className={cn("inline-flex items-center gap-2 font-medium text-sm", text[tone], className)}
      role="status"
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full transition-colors", dot[tone])}
      />
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          initial={{ opacity: 0 }}
          key={children}
          transition={{ duration: 0.18 }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function ConnectionLabel({
  state,
  className,
}: {
  state: ConnectionState;
  className?: string;
}): React.ReactElement {
  const { t } = useI18n();
  return (
    <StatusLabel className={className} tone={connectionTone[state]}>
      {t(`state_${state}`)}
    </StatusLabel>
  );
}
