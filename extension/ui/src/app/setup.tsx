import { pair } from "@ext/status.ts";
import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type * as React from "react";
import { CommandRow } from "@/components/command-row";
import { PromptExamples } from "@/components/prompt-examples";
import { Step, Steps, type StepState } from "@/components/steps";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { OTPField, OTPFieldInput, OTPFieldSeparator } from "@/components/ui/otp-field";
import { Spinner } from "@/components/ui/spinner";
import { isFirefox, useConnection, useDaemon } from "@/lib/extension";
import { t } from "@/lib/i18n";

const releases = "https://github.com/oh-my-webbridge/oh-my-webbridge/releases/latest";

function Waiting({ children }: { children: string }): React.ReactElement {
  return (
    <p className="flex items-center gap-2 text-muted-foreground text-xs">
      <Spinner className="size-3.5" />
      {children}
    </p>
  );
}

function PairForm(): React.ReactElement {
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
          <OTPFieldInput aria-label={t("pairCodeDigit", ["2", "6"])} />
          <OTPFieldInput aria-label={t("pairCodeDigit", ["3", "6"])} />
          <OTPFieldSeparator />
          <OTPFieldInput aria-label={t("pairCodeDigit", ["4", "6"])} />
          <OTPFieldInput aria-label={t("pairCodeDigit", ["5", "6"])} />
          <OTPFieldInput aria-label={t("pairCodeDigit", ["6", "6"])} />
        </OTPField>
        {busy && <Spinner className="size-4 text-muted-foreground" />}
      </div>
      {error && <FieldError match>{error}</FieldError>}
    </Field>
  );
}

function useUserScripts(): [boolean | undefined, () => void] {
  const [granted, setGranted] = useState<boolean>();
  useEffect(() => {
    if (!isFirefox) return;
    const read = (): void => {
      void chrome.permissions.contains({ permissions: ["userScripts"] }).then(setGranted);
    };
    read();
    chrome.permissions.onAdded.addListener(read);
    chrome.permissions.onRemoved.addListener(read);
    return () => {
      chrome.permissions.onAdded.removeListener(read);
      chrome.permissions.onRemoved.removeListener(read);
    };
  }, []);
  // Firefox accepts the request only inside the click handler.
  const request = (): void => {
    void chrome.permissions.request({ permissions: ["userScripts"] }).then(setGranted);
  };
  return [granted, request];
}
export { useUserScripts };

export function Setup(): React.ReactElement {
  const connection = useConnection();
  const connected = connection?.state === "connected" || connection?.state === "paused";
  const daemon = useDaemon(!connected);
  const [scripts, requestScripts] = useUserScripts();
  const states: StepState[] = [];
  const done = [connected || daemon === true, connected, ...(isFirefox ? [scripts === true] : [])];
  let current = false;
  for (const finished of done) {
    states.push(finished ? "done" : current ? "upcoming" : "current");
    if (!finished) current = true;
  }
  const tryState: StepState = current ? "upcoming" : "current";
  return (
    <Steps>
      <Step index={1} state={states[0]!} summary={t("daemonRunning")} title={t("stepDaemon")}>
        <p className="text-sm">
          {t("stepDaemonBody")}{" "}
          <a
            className="text-primary hover:underline"
            href={releases}
            rel="noreferrer"
            target="_blank"
          >
            {t("stepDaemonDownload")}
          </a>
        </p>
        <CommandRow command="omw start" />
        <p className="text-muted-foreground text-xs">{t("stepDaemonService")}</p>
        <Waiting>{t("waitingDaemon")}</Waiting>
      </Step>
      <Step index={2} state={states[1]!} summary={t("paired")} title={t("stepPair")}>
        <p className="text-sm">{t("stepPairBody")}</p>
        <CommandRow command="omw pair" />
        <PairForm />
        {connection?.state === "rejected" && (
          <p className="text-destructive text-xs">{t("pairRejected")}</p>
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
      <Step index={isFirefox ? 4 : 3} last state={tryState} title={t("stepTry")}>
        <p className="text-sm">{t("stepTryBody")}</p>
        <CommandRow command="omw install-skill ~/.agents/skills" />
        <p className="text-sm">{t("stepTryPrompt")}</p>
        <PromptExamples />
        <p className="flex items-center gap-2 text-success text-xs">
          <CheckIcon aria-hidden className="size-3.5" />
          {t("setupDone")}
        </p>
      </Step>
    </Steps>
  );
}
