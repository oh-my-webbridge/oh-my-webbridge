import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/lib/i18n";
import { readPage, type PageSignals } from "@/lib/page-signals";
import { suggest, type SuggestionName } from "@/lib/suggestions";
import { cn } from "@/lib/utils";

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

// A prompt to paste into an agent, with suggestions ranked for the active tab.
// Choosing a suggestion fills the prompt; editing the prompt keeps the text.
export function PromptComposer({ tab }: { tab: chrome.tabs.Tab }): React.ReactElement | null {
  const { t, language } = useI18n();
  const signals = usePageSignals(tab.id);
  const [chosen, setChosen] = useState<SuggestionName>();
  const [draft, setDraft] = useState<string>();
  // Counts fills; each one replays the spark on the prompt.
  const [fills, setFills] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  if (signals === "unread") return null;
  const suggestions = suggest({ url: tab.url ?? "", title: tab.title ?? "", signals, language });
  const first = suggestions[0]!;
  const current = draft === undefined ? (chosen ?? first.name) : undefined;
  const text = current ? t(`example_${current}_prompt`) : (draft ?? "");
  const choose = (name: SuggestionName): void => {
    setChosen(name);
    setDraft(undefined);
    setFills((count) => count + 1);
    const element = field.current;
    if (element)
      element.animate([{ opacity: 0.25 }, { opacity: 1 }], {
        duration: 220,
        easing: getComputedStyle(element).getPropertyValue("--ease-spark"),
      });
  };
  // The page matched a suggestion when the popup opened: the first fill sparks too.
  const spark = fills > 0 || first.fit;
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Textarea
          aria-label={t("prompt")}
          className="text-sm [&_textarea]:max-h-40 [&_textarea]:pb-9 [&_textarea]:leading-5"
          onChange={(event) => setDraft(event.currentTarget.value)}
          ref={field}
          rows={4}
          value={text}
        />
        <CopyButton className="absolute end-1.5 bottom-1.5" label={t("copyPrompt")} value={text} />
        {spark && <span aria-hidden className="prompt-spark" key={fills} />}
      </div>
      <div aria-label={t("examples")} className="flex flex-wrap gap-1.5" role="group">
        {suggestions.map(({ name, fit }, index) => (
          <Button
            aria-pressed={current === name}
            className={cn(
              "font-normal",
              current === name && "border-primary/40 bg-primary/7 dark:bg-primary/12",
            )}
            key={name}
            onClick={() => choose(name)}
            size="xs"
            title={fit ? t("suggestedForPage") : undefined}
            variant="outline"
          >
            {fit && (
              <span
                aria-hidden
                className="spark-star spark-in size-2.5 shrink-0"
                style={{ "--spark-index": index } as React.CSSProperties}
              />
            )}
            {t(`example_${name}`)}
            {fit && <span className="sr-only">{t("suggestedForPage")}</span>}
          </Button>
        ))}
      </div>
    </div>
  );
}
