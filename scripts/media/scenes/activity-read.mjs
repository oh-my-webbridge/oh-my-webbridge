// The agent reads a long article: it takes a snapshot, moves through the
// sections, reads a paragraph, and rests on the one it is summarizing.
import { icon, saveVideo } from "../compose.mjs";

export default async function activityRead({ name, stage, output, work }) {
  await stage.pair();
  const url = stage.site("/article.html");
  await stage.agent("navigate", { url, group_title: "Reading" });
  const page = await stage.tab(url);
  await page.bringToFront();
  const site = {
    at: 0,
    title: "A field guide to tide pools",
    host: "shorelinenotes.example",
    favicon: icon.live,
    toolbar: "live",
  };
  const recording = await stage.record(page, name);
  await stage.delay(1400);
  await stage.agent("snapshot", {});
  await stage.delay(900);
  await stage.agent("scroll", { selector: "#s2" });
  await stage.delay(900);
  const paragraph = await stage.agent("get", { selector: "#s2 + p", property: "text" });
  if (typeof paragraph.value !== "string" || !paragraph.value.trim())
    throw new Error("section 2 has no paragraph to read");
  await stage.delay(900);
  await stage.agent("scroll", { selector: "#s4" });
  await stage.delay(900);
  await stage.agent("hover", { selector: "#s4" });
  await stage.until(async () => (await stage.layer(page))?.frame, "focus frame");
  // The frame springs onto the hovered section; the poster is the moment it
  // has landed on it.
  await stage.until(
    () =>
      page.evaluate(() => {
        const frame = document.querySelector("omw-activity")?.shadowRoot?.querySelector(".frame");
        const section = document.querySelector("#s4")?.getBoundingClientRect();
        if (!frame?.hasAttribute("data-on") || !section) return false;
        const box = frame.getBoundingClientRect();
        return (
          Math.abs(box.top + 4 - section.top) < 2 && Math.abs(box.height - section.height - 8) < 2
        );
      }),
    "focus frame on section 4",
  );
  recording.mark("poster");
  await stage.delay(600);
  await stage.agent("scroll", { selector: "#s5" });
  await stage.delay(2000);
  const result = await recording.stop();
  console.log(name, result.duration.toFixed(2), JSON.stringify(result.marks));
  // Closing the session closes the tab, so the recording ends first.
  await stage.agent("close_session");
  await saveVideo({
    name,
    recording: result,
    timeline: [site],
    output,
    work,
  });
}
