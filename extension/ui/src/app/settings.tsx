import { validToken } from "@ext/status.ts";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type * as React from "react";
import { useUserScripts } from "@/app/setup";
import { ConnectionLabel } from "@/components/status-label";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import {
  isFirefox,
  setPreference,
  useConnection,
  usePreferences,
  useToken,
  version,
} from "@/lib/extension";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const docs = "https://oh-my-webbridge.github.io";
const repository = "https://github.com/oh-my-webbridge/oh-my-webbridge";

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="ps-4 font-medium text-muted-foreground text-xs uppercase tracking-[0.02em]">
        {title}
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-2xl border bg-card [&>*]:ms-4 [&>*]:ps-0">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex min-h-12 items-center gap-4 py-3 pe-4">
      <div className="min-w-0 flex-1">
        <label className="text-sm" htmlFor={htmlFor}>
          {label}
        </label>
        {description && <p className="mt-0.5 text-muted-foreground text-xs">{description}</p>}
      </div>
      {children}
    </div>
  );
}

const masked = (token: string): string => `${token.slice(0, 4)}…${token.slice(-4)}`;

function TokenRow(): React.ReactElement {
  const token = useToken();
  const [value, setValue] = useState("");
  const invalid = value !== "" && !validToken(value.trim());
  return (
    <div className="flex flex-col gap-3 py-3 pe-4">
      <div>
        <label className="text-sm" htmlFor="token">
          {t("tokenLabel")}
        </label>
        <p className="mt-0.5 text-muted-foreground text-xs">
          {token ? t("tokenSaved", masked(token)) : t("tokenEmpty")}
        </p>
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void chrome.storage.local.set({ token: value.trim(), paused: false }).then(() => {
            setValue("");
            toastManager.add({ title: t("tokenUpdated"), type: "success" });
          });
        }}
      >
        <Input
          aria-invalid={invalid || undefined}
          autoComplete="off"
          className="font-mono"
          id="token"
          onChange={(event) => setValue(event.target.value)}
          placeholder={t("tokenPlaceholder")}
          spellCheck={false}
          type="password"
          value={value}
        />
        <Button disabled={!validToken(value.trim())} type="submit" variant="outline">
          {t("save")}
        </Button>
      </form>
    </div>
  );
}

export function Settings(): React.ReactElement {
  const connection = useConnection();
  const preferences = usePreferences();
  const token = useToken();
  const [scripts, requestScripts] = useUserScripts();
  const [advanced, setAdvanced] = useState(false);
  return (
    <div className="flex flex-col gap-8">
      <Group title={t("groupConnection")}>
        <Row label={t("status")}>{connection && <ConnectionLabel state={connection.state} />}</Row>
        <Row description={t("pauseDescription")} htmlFor="paused" label={t("pauseLabel")}>
          <Switch
            checked={connection?.state === "paused"}
            disabled={!token}
            id="paused"
            onCheckedChange={(paused) => void chrome.storage.local.set({ paused })}
          />
        </Row>
      </Group>
      <Group title={t("groupPages")}>
        <Row description={t("activityDescription")} htmlFor="activity" label={t("activityLabel")}>
          <Switch
            checked={preferences?.activityLayer ?? true}
            id="activity"
            onCheckedChange={(on) => void setPreference("activityLayer", on)}
          />
        </Row>
        {isFirefox && (
          <Row description={t("scriptsDescription")} label={t("stepScripts")}>
            {scripts ? (
              <span className="text-muted-foreground text-sm">{t("allowed")}</span>
            ) : (
              <Button id="user-scripts" onClick={requestScripts} size="sm" variant="outline">
                {t("allowScripts")}
              </Button>
            )}
          </Row>
        )}
      </Group>
      <Collapsible onOpenChange={setAdvanced} open={advanced}>
        <CollapsibleTrigger className="flex items-center gap-1 ps-4 font-medium text-muted-foreground text-xs uppercase tracking-[0.02em] outline-none focus-visible:text-foreground">
          {t("groupAdvanced")}
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", advanced && "rotate-90")}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-2 divide-y divide-border overflow-hidden rounded-2xl border bg-card [&>*]:ms-4">
            <TokenRow />
            <Row description={t("forgetDescription")} label={t("forgetLabel")}>
              <Button
                disabled={!token}
                onClick={() => void chrome.storage.local.remove(["token", "paused"])}
                size="sm"
                variant="destructive-outline"
              >
                {t("forget")}
              </Button>
            </Row>
          </div>
        </CollapsiblePanel>
      </Collapsible>
      <footer className="flex items-center gap-4 ps-4 text-muted-foreground text-xs">
        <span className="tabular-nums">{t("versionLabel", version)}</span>
        <a className="hover:text-foreground" href={docs} rel="noreferrer" target="_blank">
          {t("documentation")}
        </a>
        <a className="hover:text-foreground" href={repository} rel="noreferrer" target="_blank">
          GitHub
        </a>
      </footer>
    </div>
  );
}
