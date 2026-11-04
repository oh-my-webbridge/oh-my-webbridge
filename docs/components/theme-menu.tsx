"use client";

import { Menu } from "@base-ui/react/menu";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { iconButton } from "./icon-button";
import { menuItem, menuPopup, menuPositioner } from "./menu-popup";
import type { Locale } from "@/lib/i18n";
import { fill, siteText } from "@/lib/layout.shared";

const subscribe = () => () => {};
const mountedOnClient = () => true;
const mountedOnServer = () => false;

/** A radio menu for light, dark or system theme; the trigger shows the current choice. */
export function ThemeMenu({ locale }: { locale: Locale }) {
  const text = siteText[locale];
  const { theme, setTheme } = useTheme();
  const isMounted = useSyncExternalStore(subscribe, mountedOnClient, mountedOnServer);
  const options = [
    { value: "light", label: text.themeLight, icon: Sun },
    { value: "dark", label: text.themeDark, icon: Moon },
    { value: "system", label: text.themeSystem, icon: Monitor },
  ] as const;
  const selected = options.find((option) => isMounted && option.value === theme) ?? options[2];
  const label = fill(text.themeCurrent, { theme: selected.label });

  return (
    <Menu.Root>
      <Menu.Trigger className={iconButton} aria-label={label} title={label}>
        <selected.icon aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={menuPositioner} align="end" sideOffset={6}>
          <Menu.Popup className={menuPopup}>
            <Menu.RadioGroup
              value={selected.value}
              onValueChange={(value: string) => setTheme(value)}
              aria-label={text.theme}
            >
              {options.map((option) => (
                <Menu.RadioItem key={option.value} value={option.value} className={menuItem}>
                  <option.icon aria-hidden="true" />
                  {option.label}
                  <span className="pointer-events-none absolute right-2 flex items-center">
                    <Menu.RadioItemIndicator>
                      <Check aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                  </span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
