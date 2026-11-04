"use client";

import { Menu } from "@base-ui/react/menu";
import { Check } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Flag } from "./flag";
import { iconButton } from "./icon-button";
import { menuItem, menuPopup, menuPositioner } from "./menu-popup";
import { htmlLang, i18n, languageNames, type Locale } from "@/lib/i18n";
import { fill, siteText } from "@/lib/layout.shared";

/** The same page in another language: the first path segment is the language. */
function switchLocalePath(pathname: string, target: Locale): string {
  const [, ...rest] = pathname.split("/").filter((segment) => segment.length > 0);
  return `/${[target, ...rest].join("/")}`;
}

/** The language menu of the site header: the current flag opens a list of all docs languages. */
export function LanguageMenu({ locale }: { locale: Locale }) {
  const text = siteText[locale];
  const pathname = usePathname();
  const label = fill(text.languageCurrent, { language: languageNames[locale] });
  return (
    <Menu.Root>
      <Menu.Trigger className={iconButton} aria-label={label} title={label}>
        <Flag locale={locale} className="size-[18px] shrink-0" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={menuPositioner} align="end" sideOffset={6}>
          <Menu.Popup className={`${menuPopup} min-w-52`} aria-label={text.language}>
            {i18n.languages.map((language) => (
              <Menu.LinkItem
                key={language}
                className={menuItem}
                render={
                  <Link
                    href={switchLocalePath(pathname, language)}
                    hrefLang={htmlLang[language]}
                    lang={htmlLang[language]}
                    aria-current={language === locale ? "page" : undefined}
                  />
                }
              >
                <Flag locale={language} />
                {languageNames[language]}
                {language === locale && (
                  <Check aria-hidden="true" className="absolute right-2 text-fd-primary" />
                )}
              </Menu.LinkItem>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
