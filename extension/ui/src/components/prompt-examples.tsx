import type * as React from "react";
import { CopyButton } from "@/components/copy-button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n";

const examples = ["summarize", "form", "research", "extract"] as const;

// Prompts to paste into an agent that has the oh-my-webbridge skill.
export function PromptExamples(): React.ReactElement {
  const { t } = useI18n();
  return (
    <Tabs aria-label={t("examples")} defaultValue="summarize">
      <TabsList className="w-full">
        {examples.map((name) => (
          <TabsTab key={name} value={name}>
            {t(`example_${name}`)}
          </TabsTab>
        ))}
      </TabsList>
      {examples.map((name) => {
        const prompt = t(`example_${name}_prompt`);
        return (
          <TabsPanel key={name} value={name}>
            <div className="flex items-start gap-2 rounded-lg border bg-card py-2.5 ps-3.5 pe-1.5">
              <p className="min-w-0 flex-1 pt-0.5 text-sm leading-5">{prompt}</p>
              <CopyButton label={t("copyPrompt")} value={prompt} />
            </div>
          </TabsPanel>
        );
      })}
    </Tabs>
  );
}
