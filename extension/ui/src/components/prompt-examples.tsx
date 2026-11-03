import type * as React from "react";
import { CopyButton } from "@/components/copy-button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { t } from "@/lib/i18n";

const examples = ["summarize", "form", "research", "extract"] as const;

// Prompts to paste into an agent that has the oh-my-webbridge skill.
export function PromptExamples(): React.ReactElement {
  return (
    <Tabs defaultValue="summarize">
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
            <div className="flex items-start gap-2 rounded-xl border bg-card p-3">
              <p className="min-w-0 flex-1 text-sm leading-5">{prompt}</p>
              <CopyButton label={t("copyPrompt")} value={prompt} />
            </div>
          </TabsPanel>
        );
      })}
    </Tabs>
  );
}
