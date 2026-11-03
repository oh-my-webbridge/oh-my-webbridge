import { CheckIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { cn } from "@/lib/utils";

export type StepState = "done" | "current" | "upcoming";

const spring = { type: "spring", bounce: 0, duration: 0.35 } as const;

// An ordered list: the current step shows its body, finished steps collapse
// to a checked title, later steps show only their title.
export function Steps({ children }: { children: React.ReactNode }): React.ReactElement {
  return <ol className="flex flex-col">{children}</ol>;
}

export function Step({
  index,
  title,
  state,
  summary,
  last = false,
  children,
}: {
  index: number;
  title: string;
  state: StepState;
  // One line shown under a finished step's title.
  summary?: string;
  last?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const reduced = useReducedMotion();
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className="relative flex gap-4 pb-8 last:pb-0"
    >
      {!last && (
        <span
          aria-hidden
          className={cn(
            "absolute start-[13px] top-9 bottom-1 w-px transition-colors",
            state === "done" ? "bg-primary/40" : "bg-border",
          )}
        />
      )}
      <span
        className={cn(
          "relative flex size-7 shrink-0 items-center justify-center rounded-full font-semibold text-xs tabular-nums transition-colors",
          state === "done" && "bg-primary text-primary-foreground",
          state === "current" && "bg-primary/10 text-primary ring-1 ring-primary/40",
          state === "upcoming" && "bg-muted text-muted-foreground",
        )}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {state === "done" ? (
            <motion.span
              animate={{ opacity: 1, scale: 1 }}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
              key="done"
              transition={spring}
            >
              <CheckIcon aria-hidden className="size-4" />
            </motion.span>
          ) : (
            <motion.span animate={{ opacity: 1 }} initial={{ opacity: 0 }} key="index">
              {index}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h2
          className={cn(
            "font-semibold text-[15px] leading-5 tracking-[-0.008em]",
            state === "upcoming" && "text-muted-foreground",
          )}
        >
          {title}
        </h2>
        {state === "done" && summary && (
          <p className="mt-1 text-muted-foreground text-xs">{summary}</p>
        )}
        <AnimatePresence initial={false}>
          {state === "current" && (
            <motion.div
              animate={{ height: "auto", opacity: 1 }}
              className="overflow-hidden"
              exit={{ height: 0, opacity: 0 }}
              initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={spring}
            >
              <div className="flex flex-col gap-3 pt-3">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </li>
  );
}
