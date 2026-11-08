import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";
import { CopyButton } from "@/components/copy-button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { readPage, type PageSignals } from "@/lib/page-signals";
import { suggest } from "@/lib/suggestions";

// How long one suggestion stays before the next one takes its place.
const holdMs = 6000;

// Reads the signals of a tab once; "unread" until the read settles.
function usePageSignals(tabId: number | undefined): PageSignals | undefined | "unread" {
  const [signals, setSignals] = useState<PageSignals | undefined | "unread">("unread");
  useEffect(() => {
    if (tabId === undefined) return;
    let live = true;
    void readPage(tabId).then((read) => {
      if (live) setSignals(read);
    });
    return () => {
      live = false;
    };
  }, [tabId]);
  return tabId === undefined ? undefined : signals;
}

// The old text leaves upward and the new one arrives from below; with reduced
// motion, both only fade.
function swap(element: HTMLElement, direction: "out" | "in"): Animation {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hidden: Keyframe = still
    ? { opacity: 0 }
    : {
        opacity: 0,
        filter: "blur(4px)",
        transform: `translateY(${direction === "out" ? -4 : 4}px)`,
      };
  const shown: Keyframe = still
    ? { opacity: 1 }
    : { opacity: 1, filter: "blur(0)", transform: "translateY(0)" };
  return element.animate(direction === "out" ? [shown, hidden] : [hidden, shown], {
    duration: direction === "out" ? 150 : 250,
    easing: getComputedStyle(element).getPropertyValue("--ease-spark"),
    fill: direction === "out" ? "forwards" : "none",
  });
}

// One prompt to paste into an agent. It shows the suggestions for the active
// tab in turn, best first, each with a spark. The pointer or focus on the
// prompt holds the current one; editing keeps the text and ends the turns.
export function PromptComposer({ tab }: { tab: chrome.tabs.Tab }): React.ReactElement | null {
  const { t, language } = useI18n();
  const signals = usePageSignals(tab.id);
  const [turn, setTurn] = useState(0);
  const [draft, setDraft] = useState<string>();
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const ready = signals !== "unread";
  const names = ready
    ? suggest({ url: tab.url ?? "", title: tab.title ?? "", signals, language })
    : [];
  const turning = ready && draft === undefined && !pointer && !focus && names.length > 1;

  useEffect(() => {
    if (!turning) return;
    const timer = setTimeout(() => {
      const element = field.current;
      if (element) void swap(element, "out").finished.then(() => setTurn((current) => current + 1));
    }, holdMs);
    return () => clearTimeout(timer);
  }, [turning, turn]);

  // Before the new text paints, drop the faded-out state and bring it in.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    for (const animation of element.getAnimations()) animation.cancel();
    swap(element, "in");
  }, [ready, turn]);

  if (!ready) return null;
  const name = names[turn % names.length]!;
  const text = draft ?? t(`example_${name}_prompt`);
  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false);
      }}
      onFocus={() => setFocus(true)}
      onPointerEnter={() => setPointer(true)}
      onPointerLeave={() => setPointer(false)}
    >
      <Textarea
        aria-label={t("prompt")}
        className="text-sm [&_textarea]:h-36 [&_textarea]:resize-none [&_textarea]:pb-9 [&_textarea]:leading-5 [&_textarea]:[field-sizing:fixed]"
        onChange={(event) => setDraft(event.currentTarget.value)}
        ref={field}
        value={text}
      />
      <CopyButton className="absolute end-1.5 bottom-1.5" label={t("copyPrompt")} value={text} />
      {draft === undefined && <span aria-hidden className="prompt-spark" key={turn} />}
    </div>
  );
}
