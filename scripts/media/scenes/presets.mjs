// The same news front page twice: once with the ad script allowed, once behind
// the default anti-ad preset, whose empty slots collapse to nothing.
import { join } from "node:path";
import { composeStill, icon } from "../compose.mjs";

export default async function presets({ stage, output, work }) {
  await stage.pair();
  const url = stage.site("/news.html");
  await stage.agent("navigate", { url, preset: "none", group_title: "Plain" }, "plain");
  await stage.agent("navigate", { url, group_title: "Quiet" }, "quiet");
  const frame = {
    title: "The Harbor Gazette",
    host: "harborgazette.example",
    favicon: icon.live,
    toolbar: "live",
  };
  // Both tabs hold the same URL, so each is recognized by the session name the
  // activity layer prints on its page.
  const tabOf = (session) =>
    stage.until(async () => {
      for (const page of stage.context.pages()) {
        if (!page.url().startsWith(url)) continue;
        const chip = await page
          .evaluate(
            () =>
              document
                .querySelector("omw-activity")
                ?.shadowRoot?.querySelector(".chip span:last-child")?.textContent,
          )
          .catch(() => undefined);
        if (chip === session) return page;
      }
      return null;
    }, `tab of session ${session}`);
  const adState = (page) =>
    page.evaluate(() => {
      const slots = [...document.querySelectorAll(".ad-slot")];
      return {
        slots: slots.length,
        filled: slots.filter((slot) => slot.children.length > 0).length,
        requested: Boolean(document.querySelector('script[src*="doubleclick"]')),
      };
    });
  // A still shows one viewport, so the page must not scroll at all.
  const fits = async (page, label) => {
    const metrics = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    if (metrics.width > 1080 || metrics.height > 675)
      throw new Error(
        `${label} page is ${metrics.width}x${metrics.height}, larger than the recorded viewport`,
      );
    return metrics;
  };

  const plain = await tabOf("plain");
  await plain.bringToFront();
  await stage.until(async () => (await adState(plain)).filled === 3, "three injected ads");
  console.log(
    "plain",
    JSON.stringify(await adState(plain)),
    JSON.stringify(await fits(plain, "plain")),
  );
  const plainShot = join(work, "presets-none.png");
  await plain.screenshot({ path: plainShot });
  await composeStill({ image: plainShot, output: join(output, "presets-none.png"), window: frame });

  const quiet = await tabOf("quiet");
  await quiet.bringToFront();
  // The tag is there at once; what matters is that its request is answered
  // with nothing.
  await stage.until(async () => (await adState(quiet)).requested, "ad request");
  await stage.delay(1200);
  const quietState = await adState(quiet);
  if (quietState.filled) throw new Error("anti-ad left injected ads on the page");
  console.log("quiet", JSON.stringify(quietState), JSON.stringify(await fits(quiet, "quiet")));
  const quietShot = join(work, "presets.png");
  await quiet.screenshot({ path: quietShot });
  await composeStill({ image: quietShot, output: join(output, "presets.png"), window: frame });

  await stage.agent("close_session", {}, "plain");
  await stage.agent("close_session", {}, "quiet");
}
