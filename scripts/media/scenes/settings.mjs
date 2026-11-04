// The settings view of a paired browser.
import { join } from "node:path";
import { composeStill, icon } from "../compose.mjs";

export default async function settings({ name, stage, output, work }) {
  await stage.pair();
  const page = await stage.open(stage.extension("app.html#settings"));
  await page.getByRole("switch", { name: stage.message("activityLabel") }).waitFor();
  await page.getByText(stage.message("state_connected")).first().waitFor();
  await stage.delay(600);
  const image = join(work, "settings.png");
  await page.screenshot({ path: image });
  await composeStill({
    image,
    output: join(output, `${name}.png`),
    window: {
      title: `${stage.message("settingsTitle")} · oh-my-webbridge`,
      host: "oh-my-webbridge",
      favicon: icon.mark,
      toolbar: "connected",
    },
  });
}
