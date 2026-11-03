// The toolbar popup over a tab an agent is filling in, as the user sees it when
// they click the extension icon: the tab's session, prompt examples, controls.
import { join } from "node:path";
import { composeStill, icon } from "../compose.mjs";

export default async function popup({ name, stage, output, work }) {
  await stage.pair();
  const page = await stage.open(stage.site("/reserve.html"));
  await stage.agent("find_tab", { url: "127.0.0.1", active: true });
  await stage.agent("fill", { selector: "#name", value: "Avery Chen" });
  await stage.agent("fill", { selector: "#email", value: "avery@example.com" });
  await stage.until(async () => (await stage.layer(page))?.favicon, "activity layer");
  await stage.delay(800);
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
  await panel.getByText("Session demo").waitFor();
  await panel.getByRole("tab", { name: "Fill a form" }).click();
  await stage.delay(400);
  const main = panel.locator("main");
  const box = await main.boundingBox();
  if (!box) throw new Error("the popup has no layout box");
  const image = join(work, "popup.png");
  await main.screenshot({ path: image });
  await composeStill({
    image: background,
    output: join(output, `${name}.png`),
    window: {
      title: "Reserve · Harbor Table",
      host: "harbortable.example",
      favicon: icon.live,
      toolbar: "live",
    },
    panel: { image, width: box.width, height: box.height },
  });
  await stage.agent("close_session");
}
