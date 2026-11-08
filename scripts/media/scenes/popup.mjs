// The toolbar popup over a tab an agent is playing in, as the user sees it when
// they click the extension icon: the tab's session, the prompt and its suggestions, controls.
import { join } from "node:path";
import { composeStill, icon } from "../compose.mjs";
import { borrowGame, game, openGame } from "../game.mjs";

export const options = { headed: true };

export default async function popup({ name, stage, output, work }) {
  await stage.pair();
  const page = await openGame(stage);
  await borrowGame(stage, page);
  for (const character of "Agent2026!")
    await stage.agent("key_type", { selector: game.editor, text: character });
  await stage.until(async () => (await stage.layer(page))?.favicon, "activity layer");
  await stage.delay(900);
  const background = join(work, "page.png");
  await page.screenshot({ path: background });
  // The popup page opens in a window of its own; it reads the active tab of
  // the last focused normal window, the page above.
  const opened = stage.context.waitForEvent("page", {
    predicate: (candidate) => candidate.url().endsWith("/popup.html"),
  });
  await stage.worker.evaluate(
    (url) => chrome.windows.create({ url, type: "popup", width: 400, height: 720, focused: false }),
    stage.extension("popup.html"),
  );
  const panel = await opened;
  await panel.getByText(stage.message("tabControlled", { session: "demo" })).waitFor();
  await panel.getByRole("button", { name: stage.message("example_form") }).click();
  await stage.delay(400);
  const main = panel.locator("main");
  const box = await main.boundingBox();
  if (!box) throw new Error("the popup has no layout box");
  const image = join(work, "popup.png");
  await main.screenshot({ path: image });
  await composeStill({
    image: background,
    output: join(output, `${name}.png`),
    window: { ...game.window, favicon: icon.live, toolbar: "live" },
    panel: { image, width: box.width, height: box.height },
  });
  await stage.agent("close_session");
}
