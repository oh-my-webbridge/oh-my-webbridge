import { pair } from "@ext/status.ts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import type * as React from "react";
import { CommandRow } from "@/components/command-row";
import { PromptExamples } from "@/components/prompt-examples";
import { PageTitle } from "@/components/rail-page";
import { Step, Steps, type StepState } from "@/components/steps";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { OTPField, OTPFieldInput, OTPFieldSeparator } from "@/components/ui/otp-field";
import {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
} from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { isFirefox, useConnection, useDaemon, useUserScripts } from "@/lib/extension";
import { useI18n } from "@/lib/i18n";

const releases = "https://github.com/oh-my-webbridge/oh-my-webbridge/releases/latest";

function PairForm(): React.ReactElement {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (value: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await pair(value);
    setBusy(false);
    if (!result.ok) {
      setError(t(result.reason === "offline" ? "pairOffline" : "pairInvalid"));
      setCode("");
    }
  };
  const digit = (index: number): string => t("pairCodeDigit", { index, count: 6 });
  return (
    <Field invalid={error !== undefined}>
      <FieldLabel>{t("pairCodeLabel")}</FieldLabel>
      <div className="flex items-center gap-3">
        <OTPField
          disabled={busy}
          length={6}
          onValueChange={setCode}
          onValueComplete={(value) => void submit(value)}
          size="lg"
          value={code}
        >
          <OTPFieldInput />
          <OTPFieldInput aria-label={digit(2)} />
          <OTPFieldInput aria-label={digit(3)} />
          <OTPFieldSeparator />
          <OTPFieldInput aria-label={digit(4)} />
          <OTPFieldInput aria-label={digit(5)} />
          <OTPFieldInput aria-label={digit(6)} />
        </OTPField>
        {busy && <Spinner className="size-4 text-muted-foreground" />}
      </div>
      {error && <FieldError match>{error}</FieldError>}
    </Field>
  );
}

export function Setup(): React.ReactElement {
  const { t } = useI18n();
  const connection = useConnection();
  const connected = connection?.state === "connected" || connection?.state === "paused";
  const daemon = useDaemon(!connected);
  const [scripts, requestScripts] = useUserScripts();
  const done = [connected || daemon === true, connected, ...(isFirefox ? [scripts === true] : [])];
  const states: StepState[] = [];
  let open = false;
  for (const finished of done) {
    states.push(finished ? "done" : open ? "upcoming" : "current");
    if (!finished) open = true;
  }
  const tryState: StepState = open ? "upcoming" : "current";
  const total = done.length + 1;
  const finished = done.filter(Boolean).length + (open ? 0 : 1);
  return (
    <>
      <PageTitle title={t("setupTitle")}>
        <Progress
          className="mt-4 flex-row items-center gap-3"
          getAriaValueText={() => t("setupProgress", { done: finished, total })}
          max={total}
          value={finished}
        >
          <ProgressTrack className="h-1 max-w-48 bg-muted">
            <ProgressIndicator />
          </ProgressTrack>
          <ProgressLabel className="font-medium type-caption text-muted-foreground tabular-nums">
            {t("setupProgress", { done: finished, total })}
          </ProgressLabel>
        </Progress>
      </PageTitle>
      <Steps>
        <Step
          busy={daemon !== true}
          index={1}
          state={states[0]!}
          summary={t("daemonRunning")}
          title={t("stepDaemon")}
        >
          <p className="text-sm">
            {t("stepDaemonBody")}{" "}
            <a
              className="font-medium text-primary underline-offset-4 hover:underline"
              href={releases}
              rel="noreferrer"
              target="_blank"
            >
              {t("stepDaemonDownload")}
            </a>
          </p>
          <CommandRow command="omw start" />
          <p className="text-muted-foreground text-sm">{t("stepDaemonService")}</p>
          <p className="type-caption text-muted-foreground">{t("waitingDaemon")}</p>
        </Step>
        <Step index={2} state={states[1]!} summary={t("paired")} title={t("stepPair")}>
          <p className="text-sm">{t("stepPairBody")}</p>
          <CommandRow command="omw pair" />
          <PairForm />
          {connection?.state === "rejected" && (
            <p className="text-destructive text-sm">{t("pairRejected")}</p>
          )}
        </Step>
        {isFirefox && (
          <Step index={3} state={states[2]!} summary={t("scriptsAllowed")} title={t("stepScripts")}>
            <p className="text-sm">{t("stepScriptsBody")}</p>
            <div>
              <Button id="user-scripts" onClick={requestScripts}>
                {t("allowScripts")}
              </Button>
            </div>
          </Step>
        )}
        <Step index={total} state={tryState} title={t("stepTry")}>
          <p className="text-sm">{t("stepTryBody")}</p>
          <CommandRow command="omw install-skill ~/.agents/skills" />
          <p className="text-sm">{t("stepTryPrompt")}</p>
          <PromptExamples />
          <p className="flex items-center gap-2 font-medium text-sm text-success">
            <CheckIcon aria-hidden className="size-4" />
            {t("setupDone")}
          </p>
        </Step>
      </Steps>
    </>
  );
}
