// First run: the setup page waits for the daemon, takes the pairing code from
// omw pair, and ends on the prompt examples.
import { icon, saveVideo } from "../compose.mjs";

export const options = { daemon: false };

export default async function setup({ name, stage, output, work }) {
  const page = await stage.tab(stage.extension("app.html"));
  await page.bringToFront();
  await page.getByText(stage.message("waitingDaemon")).waitFor();
  const chrome = {
    title: `${stage.message("setupTitle")} · oh-my-webbridge`,
    host: "oh-my-webbridge",
    favicon: icon.mark,
  };
  const codeField = page.getByRole("textbox", {
    name: stage.message("pairCodeLabel"),
    exact: true,
  });
  const recording = await stage.record(page, name);
  await stage.delay(1800);
  await stage.startDaemon();
  await codeField.waitFor();
  await stage.delay(1400);
  const code = await stage.pairingCode();
  await codeField.pressSequentially(code, { delay: 160 });
  await page.getByText(stage.message("setupDone")).waitFor({ timeout: 35000 });
  recording.mark("connected");
  await stage.delay(1500);
  await page.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }),
  );
  await stage.delay(1200);
  recording.mark("poster");
  await stage.delay(1600);
  const result = await recording.stop();
  await saveVideo({
    name,
    recording: result,
    timeline: [
      { at: 0, ...chrome, toolbar: "offline" },
      { at: result.marks.connected, ...chrome, toolbar: "connected" },
    ],
    output,
    work,
    gif: true,
  });
}
