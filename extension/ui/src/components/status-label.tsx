import type { ConnectionState } from "@ext/status.ts";
import { AnimatePresence, motion } from "motion/react";
import type * as React from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type Tone = "success" | "live" | "muted" | "danger";

const dot: Record<Tone, string> = {
  success: "bg-success",
  live: "bg-warning shadow-[0_0_0_3px] shadow-warning/24",
  muted: "bg-muted-foreground/48",
  danger: "bg-destructive",
};

export const connectionTone: Record<ConnectionState, Tone> = {
  connected: "success",
  connecting: "muted",
  paused: "muted",
  unpaired: "muted",
  offline: "danger",
  rejected: "danger",
};

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
    <span className={cn("inline-flex items-center gap-2 text-sm", className)} role="status">
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
  return (
    <StatusLabel className={className} tone={connectionTone[state]}>
      {t(`state_${state}`)}
    </StatusLabel>
  );
}
