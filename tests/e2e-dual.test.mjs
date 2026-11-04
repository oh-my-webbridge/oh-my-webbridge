import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { firefoxAddonId, startFirefox } from "../scripts/firefox-bidi.mjs";
import { startDaemon, startSite, until } from "./fixtures/e2e-bridge.mjs";

const chromeBin = process.env.CHROME_BIN;

test(
  "one daemon routes sessions between Chrome and Firefox",
  { skip: !chromeBin || !process.env.FIREFOX_BIN, timeout: 240000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "omw-e2e-dual-"));
    // Cleanup runs in reverse order: browsers, daemon, site, then the directory.
    const cleanup = [() => rm(dir, { recursive: true, force: true })];
    t.after(async () => {
      for (const step of cleanup.reverse()) await step();
    });
    const site = await startSite();
    cleanup.push(() => site.close());
    const daemon = await startDaemon(join(dir, "home"));
    cleanup.push(async () => {
      await daemon.stop();
      await mkdir("dist/qa", { recursive: true });
      await writeFile("dist/qa/dual-e2e-daemon.log", daemon.logs());
    });

    const firefox = await startFirefox({ dir });
    cleanup.push(async () => {
      t.diagnostic(`Firefox close: ${await firefox.close()}`);
      await mkdir("dist/qa", { recursive: true });
      await writeFile("dist/qa/dual-e2e-firefox.log", firefox.output());
    });
    assert.equal(
      await firefox.installExtension({ type: "path", path: resolve("dist/extension-firefox") }),
      firefoxAddonId,
    );
    const popup = await firefox.openExtensionPage("popup.html");
    const pauseFirefox = (paused) =>
      firefox.evaluate(
        popup,
        `chrome.storage.local.set(${JSON.stringify({ token: daemon.token, paused })})`,
      );

    const profile = join(dir, "chrome");
    const context = await chromium.launchPersistentContext(profile, {
      executablePath: chromeBin,
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--no-sandbox",
        "--no-proxy-server",
        ...(process.platform === "darwin" ? ["--disable-gpu"] : []),
        `--disable-extensions-except=${resolve("dist/extension")}`,
        `--load-extension=${resolve("dist/extension")}`,
      ],
    });
    cleanup.push(async () => {
      await Promise.race([
        context.close().catch((error) => t.diagnostic(`close test Chrome: ${String(error)}`)),
        delay(5000, undefined, { ref: false }),
      ]);
      // Only processes of this disposable profile are killed if close stalled.
      const { stdout } = await promisify(execFile)("ps", ["-ax", "-o", "pid=,command="]);
      for (const line of stdout.split("\n"))
        if (line.includes(`--user-data-dir=${profile}`)) {
          const pid = Number(line.trim().match(/^\d+/u)?.[0]);
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
    });
    await context.pages()[0].bringToFront();
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const pauseChrome = (paused) =>
      worker.evaluate((settings) => chrome.storage.local.set(settings), {
        token: daemon.token,
        paused,
      });

    const connected = async () =>
      ((await daemon.status())?.browsers ?? [])
        .filter((b) => b.connected)
        .map((b) => b.browser)
        .sort();
    const browsersAre = (expected, label) =>
      until(
        async () => JSON.stringify(await connected()) === JSON.stringify(expected),
        `${label}: ${JSON.stringify(expected)}`,
        70000,
      );
    await Promise.all([pauseChrome(false), pauseFirefox(false)]);
    await browsersAre(["chrome", "firefox"], "both extensions connected");

    const command = (session, action, args = {}, browser) =>
      daemon.command({ session, action, args, browser, timeoutMs: 30000 });
    const call = async (session, action, args = {}, browser) => {
      const reply = await command(session, action, args, browser);
      assert.equal(reply.status, 200, `${session}/${action}: ${JSON.stringify(reply)}`);
      return reply.result;
    };
    // Which browser shows a URL: Chrome pages through Playwright, Firefox
    // top-level browsing contexts through BiDi.
    const inChrome = (url) => context.pages().some((page) => page.url() === url);
    const inFirefox = async (url) =>
      (await firefox.send("browsingContext.getTree", { maxDepth: 0 })).contexts.some(
        (c) => c.url === url,
      );
    const opensIn = async (url, browser) => {
      await until(
        async () => (browser === "chrome" ? inChrome(url) : await inFirefox(url)),
        `${url} in ${browser}`,
      );
      assert.equal(browser === "chrome" ? await inFirefox(url) : inChrome(url), false, url);
    };
    // On a failure, the daemon state, both extensions' connections and tabs,
    // and Firefox's frames are saved beside the logs. The Chrome extension has
    // no webNavigation permission, so its frames are not listed.
    const saveState = async (failed) => {
      const chromeState = await worker.evaluate(async () => ({
        connection: await chrome.storage.session.get("connection"),
        tabs: (await chrome.tabs.query({})).map(({ id, url, status, discarded, groupId }) => ({
          id,
          url,
          status,
          discarded,
          groupId,
        })),
      }));
      await mkdir("dist/qa", { recursive: true });
      await writeFile(
        "dist/qa/dual-e2e-state.json",
        JSON.stringify(
          {
            failed,
            daemon: await daemon.status(),
            firefox: await firefox.extensionState(popup),
            chrome: chromeState,
          },
          null,
          2,
        ) + "\n",
      );
    };
    const step = async (name, run) => {
      let failure;
      await t.test(name, () =>
        run().catch((error) => {
          failure = error;
          throw error;
        }),
      );
      if (failure) {
        await saveState(name);
        throw failure;
      }
    };

    await step("status lists both browsers", async () => {
      const status = await daemon.status();
      assert.equal(status.extension_connected, true);
      assert.deepEqual(status.browsers.map((b) => b.browser).sort(), ["chrome", "firefox"]);
      assert.equal(
        status.browsers.find((b) => b.browser === "firefox").browserVersion,
        firefox.version,
      );
    });

    await step("an explicit browser binds the session to it", async () => {
      await call("fx", "navigate", { url: `${site.url}?fx=1` }, "firefox");
      await opensIn(`${site.url}?fx=1`, "firefox");
      await call("cr", "navigate", { url: `${site.url}?cr=1` }, "chrome");
      await opensIn(`${site.url}?cr=1`, "chrome");
      // Later commands without a browser follow the binding.
      await call("fx", "navigate", { url: `${site.url}?fx=2` });
      await opensIn(`${site.url}?fx=2`, "firefox");
      assert.equal((await call("fx", "list_tabs")).tabs.length, 1);
    });

    await step("a session without a browser uses Chrome while both are connected", async () => {
      await call("default", "navigate", { url: `${site.url}?default=1` });
      await opensIn(`${site.url}?default=1`, "chrome");
    });

    await step("a bound session rejects the other browser with HTTP 409", async () => {
      const reply = await command("fx", "list_tabs", {}, "chrome");
      assert.equal(reply.status, 409, JSON.stringify(reply));
      assert.equal(reply.error.code, "session_browser");
      // The binding is unchanged.
      assert.equal((await call("fx", "list_tabs", {}, "firefox")).tabs.length, 1);
    });

    await step("close_session releases the binding", async () => {
      await call("fx", "close_session");
      await call("fx", "navigate", { url: `${site.url}?fx=chrome` }, "chrome");
      await opensIn(`${site.url}?fx=chrome`, "chrome");
      await call("fx", "close_session");
    });

    await step("an offline browser returns browser_offline", async () => {
      await call("fx-bound", "navigate", { url: `${site.url}?bound=1` }, "firefox");
      await pauseFirefox(true);
      await browsersAre(["chrome"], "Firefox paused");
      for (const [session, browser] of [
        ["fx-new", "firefox"],
        ["fx-bound", undefined],
      ]) {
        const reply = await command(session, "list_tabs", {}, browser);
        assert.equal(reply.error?.code, "browser_offline", JSON.stringify(reply));
        assert.match(reply.error.message, /firefox/iu);
      }
      // Chrome keeps working, and a new session without a browser uses it.
      await call("solo-chrome", "navigate", { url: `${site.url}?solo=chrome` });
      await opensIn(`${site.url}?solo=chrome`, "chrome");
      await call("solo-chrome", "close_session");

      await pauseFirefox(false);
      await pauseChrome(true);
      await browsersAre(["firefox"], "Chrome paused");
      const reply = await command("cr", "list_tabs");
      assert.equal(reply.error?.code, "browser_offline", JSON.stringify(reply));
      assert.match(reply.error.message, /chrome/iu);
      await call("solo-firefox", "navigate", { url: `${site.url}?solo=firefox` });
      await opensIn(`${site.url}?solo=firefox`, "firefox");
      // The session bound before Firefox went offline still reaches its tab.
      assert.equal((await call("fx-bound", "list_tabs")).tabs.length, 1);

      await pauseChrome(false);
      await browsersAre(["chrome", "firefox"], "both extensions reconnected");
      for (const session of ["solo-firefox", "fx-bound", "cr", "default"])
        await call(session, "close_session");
    });
  },
);
