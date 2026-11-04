import { CheckIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type StepState = "done" | "current" | "upcoming";

const spring = { type: "spring", bounce: 0, duration: 0.35 } as const;

// One surface with a row for each step. The current step shows its body,
// finished steps collapse to a checked title, later steps show their title.
export function Steps({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <ol className="overflow-hidden rounded-[14px] border bg-card bg-clip-padding">{children}</ol>
  );
}

export function Step({
  index,
  title,
  state,
  summary,
  busy = false,
  children,
}: {
  index: number;
  title: string;
  state: StepState;
  // One line shown under a finished step's title.
  summary?: string;
  // The step waits for a result that the extension observes.
  busy?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const reduced = useReducedMotion();
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className="flex gap-4 border-t px-5 py-4 first:border-t-0"
    >
      <span
        className={cn(
          "relative flex size-7 shrink-0 items-center justify-center rounded-full font-semibold text-xs tabular-nums transition-colors",
          state === "done" && "bg-success text-card",
          state === "current" && "bg-primary text-primary-foreground",
          state === "upcoming" && "border border-input text-muted-foreground",
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
              <CheckIcon aria-hidden className="size-4" strokeWidth={2.5} />
            </motion.span>
          ) : state === "current" && busy ? (
            <motion.span animate={{ opacity: 1 }} initial={{ opacity: 0 }} key="busy">
              <Spinner className="size-4" />
            </motion.span>
          ) : (
            <motion.span animate={{ opacity: 1 }} initial={{ opacity: 0 }} key="index">
              {index}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h2 className={cn("type-title", state === "upcoming" && "text-muted-foreground")}>
          {title}
        </h2>
        {state === "done" && summary && (
          <p className="mt-0.5 text-muted-foreground text-sm">{summary}</p>
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
              <div className="flex flex-col gap-3 pt-3 pb-1">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </li>
  );
}
