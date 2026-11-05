// The Password Game (neal.fun), the live site the activity scenes play. Its
// Cloudflare check turns headless browsers away, so these scenes run headed.
export const game = {
  url: "https://neal.fun/password-game/",
  window: { title: "The Password Game", host: "neal.fun" },
  // The password field is a ProseMirror editor.
  editor: "div.ProseMirror",
};

// Opens the game and waits for its password field. Cloudflare may show its
// check first; nothing is recorded yet, so a reload is only setup.
export async function openGame(stage) {
  const page = await stage.open(game.url);
  for (let attempt = 0; attempt < 3; attempt++) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await page.locator(game.editor).count()) return page;
      await stage.delay(200);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  throw new Error("the password game did not show its password field");
}

// The agent borrows the game tab with find_tab, which takes the active tab of
// the last focused window, so the tab is brought to the front first.
export async function borrowGame(stage, page) {
  await page.bringToFront();
  await stage.until(
    () =>
      stage.worker.evaluate(async (host) => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tab?.url !== undefined && new URL(tab.url).hostname === host;
      }, game.window.host),
    "the game as the active tab",
  );
  return stage.agent("find_tab", { url: game.window.host, active: true });
}
