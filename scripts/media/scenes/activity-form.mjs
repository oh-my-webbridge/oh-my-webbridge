// The user has The Password Game open and asks the agent to get through its
// rules. The agent borrows the tab, types one character at a time, and folds
// the CAPTCHA's digits into the sum the fifth rule asks for.
import { icon, saveVideo } from "../compose.mjs";
import { borrowGame, game, openGame } from "../game.mjs";

export const options = { headed: true };

// The rule cards read newest first; each carries its own kind, such as captcha
// or moon-phase, next to the shared `rule` and `rule-error` classes.
const ruleIds = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".rule")).map((card) =>
      Array.from(card.classList)
        .filter((name) => name !== "rule" && name !== "rule-error")
        .join(" "),
    ),
  );

// The CAPTCHA answer is the file name of its image, for example 4cn7b.
const captchaAnswer = (page) =>
  page.evaluate(() => {
    const image = document.querySelector(".captcha-img");
    return image?.getAttribute("src").split("/").at(-1).replace(".png", "") ?? "";
  });

const password = (page) => page.locator(game.editor).evaluate((field) => field.innerText);

const digitSum = (text) =>
  [...text]
    .filter((character) => /\d/u.test(character))
    .reduce((sum, character) => sum + Number(character), 0);

// Digits that add up to `sum`: 24 becomes 996.
const digitsAddingTo = (sum) => {
  const digits = [];
  for (let rest = sum; rest > 0; rest -= 9) digits.push(Math.min(9, rest));
  return digits.join("");
};

// The game asks its own API for the Wordle answer of the day; the public Wordle
// payload carries the same word.
async function wordleAnswer() {
  const today = new Date();
  const date = [
    today.getFullYear(),
    `${today.getMonth() + 1}`.padStart(2, "0"),
    `${today.getDate()}`.padStart(2, "0"),
  ].join("-");
  const response = await fetch(`https://www.nytimes.com/svc/wordle/v2/${date}.json`);
  if (!response.ok) throw new Error(`Wordle for ${date}: HTTP ${response.status}`);
  const { solution } = await response.json();
  if (typeof solution !== "string") throw new Error(`Wordle for ${date} has no solution`);
  return solution;
}

export default async function activityForm({ name, stage, output, work }) {
  const wordle = await wordleAnswer();
  await stage.pair();
  const page = await openGame(stage);
  const site = { ...game.window, favicon: icon.lucide("key-round") };
  const recording = await stage.record(page, name);
  await stage.delay(3200);
  recording.mark("controlled");
  await borrowGame(stage, page);
  await stage.delay(600);
  // A read before the first keystroke: the agent looks at the page it borrowed.
  await stage.agent("read_page");
  await stage.delay(1400);
  await stage.agent("click", { selector: game.editor });
  await stage.until(async () => (await stage.layer(page))?.frame, "focus frame");
  recording.mark("layer");
  await stage.delay(900);

  const type = async (text) => {
    for (const character of text) {
      await stage.agent("key_type", { selector: game.editor, text: character });
      await stage.delay(90);
    }
  };
  // Waits for the rule a step reveals, then leaves it on screen to be read.
  const reveal = async (id, hold = 1300) => {
    await stage.until(async () => (await ruleIds(page)).includes(id), `rule ${id}`);
    await stage.delay(hold);
  };
  const keys = async (key, count) => {
    for (let index = 0; index < count; index++) {
      await stage.agent("send_keys", { keys: key });
      await stage.delay(40);
    }
  };

  await type("abcpepsi");
  await reveal("number");
  await type("1");
  await reveal("uppercase");
  await type("P");
  await reveal("special");
  await type("!");
  await reveal("digits");
  // 1 + 9 + 9 + 6 = 25, before the CAPTCHA adds digits of its own.
  await type("996");
  await reveal("month");
  await type("may");
  await reveal("roman");
  // The sponsor is already in the password, so typing X reveals the multiply
  // rule with X alone: 10, not 35.
  await type("X");
  await reveal("roman-multiply");
  await type("XXV");
  await reveal("captcha");

  let answer = await captchaAnswer(page);
  if (!answer) throw new Error("the CAPTCHA image has no answer in its source");
  // The CAPTCHA's digits count towards the sum of rule 5, so the agent prefers
  // one that leaves most of the sum to the digits after "!".
  for (let attempt = 0; attempt < 12 && digitSum(answer) > 12; attempt++) {
    await stage.agent("click", { selector: ".captcha-refresh" });
    await stage.delay(450);
    answer = await captchaAnswer(page);
  }
  const captchaDigits = digitSum(answer);
  if (captchaDigits > 24) throw new Error(`CAPTCHA digits leave no sum to write: ${answer}`);
  await stage.delay(2200);
  await type(answer);
  // Rule 5 breaks as soon as the CAPTCHA lands, so the digits after "!" are
  // rewritten to what is left of 25. The caret walks there and back by a known
  // character count, which holds when the field wraps onto two lines.
  if (captchaDigits > 0) {
    const tail = "mayXXXV".length + answer.length;
    await keys("ArrowLeft", tail);
    await keys("Backspace", 3);
    await type(digitsAddingTo(24 - captchaDigits));
    await keys("ArrowRight", tail);
    const rewritten = await password(page);
    if (digitSum(rewritten) !== 25)
      throw new Error(`digits add up to ${digitSum(rewritten)}: ${rewritten}`);
  }
  await reveal("wordle");
  await type(wordle);
  await reveal("periodic-table");
  await type("He");
  await reveal("moon-phase", 1000);
  recording.mark("poster");

  await stage.delay(2200);
  recording.mark("released");
  await stage.agent("close_session");
  await stage.until(async () => (await stage.layer(page)) === null, "layer removed");
  await stage.delay(2600);
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
