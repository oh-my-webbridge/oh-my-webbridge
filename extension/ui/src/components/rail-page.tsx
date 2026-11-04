import { ArrowUpRightIcon, ListChecksIcon, Settings2Icon } from "lucide-react";
import type * as React from "react";
import { BrandMark } from "@/components/brand-mark";
import { LanguageMenu } from "@/components/language-menu";
import { version } from "@/lib/extension";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type View = "setup" | "settings";

const docs = "https://oh-my-webbridge.github.io";
const railItem =
  "flex h-9 items-center gap-2.5 rounded-lg px-2.5 font-medium text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring [&_svg]:size-4 [&_svg]:shrink-0";

// The full-tab extension view: a side rail with the navigation and one content
// column. Below 768px the rail becomes a top bar.
export function RailPage({
  view,
  children,
}: {
  view: View;
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useI18n();
  const items = [
    { view: "setup", label: t("navSetup"), icon: ListChecksIcon },
    { view: "settings", label: t("navSettings"), icon: Settings2Icon },
  ] as const;
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="sticky top-0 z-10 flex h-14 items-center gap-2 bg-sidebar px-3 text-sidebar-foreground md:h-dvh md:flex-col md:items-stretch md:gap-6 md:px-4 md:py-5">
        <div className="flex items-center gap-2.5 px-1 md:px-1.5">
          <BrandMark className="size-7" />
          <span className="hidden font-semibold text-[15px] text-sidebar-accent-foreground leading-5 md:inline">
            {t("extensionName")}
          </span>
        </div>
        <nav aria-label={t("navMain")} className="flex flex-1 gap-1 md:flex-none md:flex-col">
          {items.map((item) => (
            <a
              aria-current={item.view === view ? "page" : undefined}
              className={cn(
                railItem,
                "aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground",
              )}
              href={`#${item.view}`}
              key={item.view}
            >
              <item.icon aria-hidden />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1 md:mt-auto md:flex-col md:items-stretch">
          <LanguageMenu className="w-auto text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring data-popup-open:bg-sidebar-accent max-md:[&>span]:sr-only md:w-full" />
          <a
            className={cn(railItem, "hidden md:flex")}
            href={docs}
            rel="noreferrer"
            target="_blank"
          >
            <ArrowUpRightIcon aria-hidden />
            {t("documentation")}
          </a>
          <p className="hidden px-2.5 pt-2 type-caption text-sidebar-foreground/80 tabular-nums md:block">
            {t("versionLabel", { version })}
          </p>
        </div>
      </aside>
      <main className="px-5 pt-8 pb-16 md:px-10 md:pt-12">
        <div className="mx-auto w-full max-w-[640px] md:mx-0">{children}</div>
      </main>
    </div>
  );
}

// The first heading of a rail page and an optional caption line under it.
export function PageTitle({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <header className="mb-6">
      <h1 className="type-title-l">{title}</h1>
      {children}
    </header>
  );
}
