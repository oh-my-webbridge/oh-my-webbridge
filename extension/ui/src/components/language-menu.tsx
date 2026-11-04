import { languageNames, languages, type LanguageChoice } from "@ext/i18n.ts";
import { FlagCn, FlagHk, FlagMo, FlagTw, FlagUs } from "@sankyu/react-circle-flags";
import { ChevronsUpDownIcon, GlobeIcon } from "lucide-react";
import type * as React from "react";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { setPreference } from "@/lib/extension";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const flags = { en: FlagUs, "zh-TW": FlagTw, "zh-CN": FlagCn, "zh-HK": FlagHk, "zh-MO": FlagMo };

// A 16px round flag, or a globe for the browser language. The language name
// next to it is the label, so the flag is hidden from assistive technology.
function Flag({ choice }: { choice: LanguageChoice }): React.ReactElement {
  if (choice === "auto") return <GlobeIcon aria-hidden className="size-4 shrink-0" />;
  const Component = flags[choice];
  return <Component aria-hidden className="size-4 shrink-0" height={16} title="" width={16} />;
}

const choices: LanguageChoice[] = ["auto", ...languages];

export function LanguageMenu({ className }: { className?: string }): React.ReactElement {
  const { choice, t } = useI18n();
  const name = (value: LanguageChoice): string =>
    value === "auto" ? t("languageAuto") : languageNames[value];
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${t("language")}: ${name(choice)}`}
        className={cn(
          "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-start text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <Flag choice={choice} />
        <span className="min-w-0 flex-1 truncate">{name(choice)}</span>
        <ChevronsUpDownIcon aria-hidden className="size-3.5 shrink-0 opacity-64" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56" side="top" sideOffset={6}>
        <MenuRadioGroup
          onValueChange={(value: LanguageChoice) => void setPreference("language", value)}
          value={choice}
        >
          {choices.map((value) => (
            <MenuRadioItem key={value} lang={value === "auto" ? undefined : value} value={value}>
              <span className="flex items-center gap-2.5">
                <Flag choice={value} />
                {name(value)}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
