import { releasePage, releaseUpdate, type ReleaseCheck } from "@ext/releases.ts";
import type * as React from "react";
import { version } from "@/lib/extension";
import { useI18n } from "@/lib/i18n";

export function ReleaseNotice({
  check,
  daemon,
}: {
  check: ReleaseCheck | undefined;
  daemon: string | undefined;
}): React.ReactElement | null {
  const { t } = useI18n();
  const latest = check?.releaseCache?.latest;
  if (check?.checkForReleases === false || !latest) return null;
  const update = releaseUpdate(latest, version, daemon);
  if (!update) return null;
  return (
    <div className="flex flex-col gap-1 text-sm" role="status">
      <p>{t(update, { version: latest })}</p>
      <a
        className="self-start text-primary underline underline-offset-2"
        href={releasePage(latest)}
        rel="noreferrer"
        target="_blank"
      >
        {t("releaseLink")}
      </a>
    </div>
  );
}
