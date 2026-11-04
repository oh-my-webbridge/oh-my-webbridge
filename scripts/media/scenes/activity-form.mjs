// The user has a booking form open and asks the agent to fill it in. The agent
// borrows the active tab, fills each field, and stops before submitting.
import { icon, saveVideo } from "../compose.mjs";

export default async function activityForm({ name, stage, output, work }) {
  await stage.pair();
  const page = await stage.open(stage.site("/reserve.html"));
  const site = {
    title: "Reserve · Harbor Table",
    host: "harbortable.example",
    favicon: icon.lucide("utensils"),
  };
  const recording = await stage.record(page, name);
  await stage.delay(1200);
  recording.mark("controlled");
  await stage.agent("find_tab", { url: "127.0.0.1", active: true });
  await stage.delay(900);
  const steps = [
    ["fill", { selector: "#name", value: "Avery Chen" }],
    ["fill", { selector: "#email", value: "avery@example.com" }],
    ["select_option", { selector: "#date", value: "Sat, Nov 21" }],
    ["select_option", { selector: "#time", value: "19:30" }],
    ["select_option", { selector: "#guests", value: "4" }],
    ["check", { selector: "#terrace" }],
    ["fill", { selector: "#notes", value: "Celebrating a birthday. A quiet corner if possible." }],
    ["check", { selector: "#reminder" }],
    ["hover", { selector: "#submit" }],
  ];
  for (const [index, [action, args]] of steps.entries()) {
    await stage.agent(action, args);
    // The layer appears with the first action, once the extension attaches to the tab.
    if (index === 0) {
      await stage.until(async () => (await stage.layer(page))?.frame, "focus frame");
      recording.mark("layer");
    }
    if (index === 6) recording.mark("poster");
    await stage.delay(700);
  }
  await stage.delay(1200);
  recording.mark("released");
  await stage.agent("close_session");
  await stage.until(async () => (await stage.layer(page)) === null, "layer removed");
  await stage.delay(1600);
  const result = await recording.stop();
  await saveVideo({
    name,
    recording: result,
    timeline: [
      { at: 0, ...site, toolbar: "connected" },
      { at: result.marks.controlled + 0.2, ...site, toolbar: "live" },
      { at: result.marks.layer, ...site, favicon: icon.live, toolbar: "live" },
      { at: result.marks.released + 0.3, ...site, toolbar: "connected" },
    ],
    output,
    work,
    gif: true,
  });
}
