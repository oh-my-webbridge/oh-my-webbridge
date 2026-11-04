import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { firefoxAddonId, startFirefox } from "../scripts/firefox-bidi.mjs";
import { startDaemon, startSite, until } from "./fixtures/e2e-bridge.mjs";

const adHost = "googleads.g.doubleclick.net";
// Actions and arguments the Firefox extension rejects with unsupported (HTTP 501).
const unsupported = [
  ["save_as_pdf", {}],
  ["dialog", { accept: true }],
  ["drag", { from: "#submit", to: "#name" }],
  ["console", { cmd: "start" }],
  ["mouse", { cmd: "move", x: 10, y: 10 }],
  ["keyboard", { cmd: "down", key: "Shift" }],
  ["keyboard", { cmd: "up", key: "Shift" }],
  ["send_keys", { keys: "ArrowDown" }],
  ["history", { cmd: "list" }],
  ["emulate", { width: 900, height: 700 }],
  ["emulate", { colorScheme: "dark" }],
  ["emulate", { offline: true }],
  ["cdp", { method: "Runtime.evaluate", params: { expression: "1" } }],
  ["cdp_attach", {}],
  ["list_targets", {}],
];

test(
  "MV3 bridge end-to-end on an isolated Firefox",
  { skip: !process.env.FIREFOX_BIN, timeout: 480000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "omw-e2e-firefox-"));
    // Cleanup runs in reverse order: Firefox, daemon, site, then the directory.
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
      await writeFile("dist/qa/firefox-e2e-daemon.log", daemon.logs());
    });
    const firefox = await startFirefox({ dir });
    cleanup.push(async () => {
      t.diagnostic(`Firefox close: ${await firefox.close()}`);
      await mkdir("dist/qa", { recursive: true });
      await writeFile("dist/qa/firefox-e2e-browser.log", firefox.output());
    });

    const call = (action, args = {}, session = "fixture", timeoutMs = 30000) =>
      daemon.call(action, args, { session, timeoutMs });
    const value = async (code, session = "fixture") =>
      (await call("evaluate", { code }, session)).value;
    const rejectsUnsupported = async (action, args, session = "fixture") => {
      const reply = await daemon.command({ session, action, args, timeoutMs: 10000 });
      const label = `${action} ${JSON.stringify(args)}: ${JSON.stringify(reply)}`;
      assert.equal(reply.status, 501, label);
      assert.equal(reply.error?.code, "unsupported", label);
      assert.match(reply.error.message, /Firefox/u, label);
    };
    const firefoxStatus = async () =>
      (await daemon.status())?.browsers?.find((b) => b.browser === "firefox" && b.connected);
    assert.equal(
      await firefox.installExtension({ type: "path", path: resolve("dist/extension-firefox") }),
      firefoxAddonId,
    );
    const popup = await firefox.openExtensionPage("popup.html");
    // On a failure, the daemon and extension state is saved beside the logs.
    const saveState = async (failed) => {
      await mkdir("dist/qa", { recursive: true });
      await writeFile(
        "dist/qa/firefox-e2e-state.json",
        JSON.stringify(
          { failed, daemon: await daemon.status(), ...(await firefox.extensionState(popup)) },
          null,
          2,
        ) + "\n",
      );
    };
    // A later step depends on the state an earlier one leaves, so the first
    // failure stops the run.
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

    await firefox.evaluate(
      popup,
      `chrome.storage.local.set(${JSON.stringify({ token: daemon.token, paused: false })})`,
    );
    try {
      await until(firefoxStatus, "Firefox extension connected", 60000);
    } catch (error) {
      await saveState("Firefox extension connected");
      throw error;
    }
    let tabId;

    await step("status reports the connected Firefox and no CDP endpoints", async () => {
      const status = await daemon.status();
      assert.equal(status.extension_connected, true);
      assert.deepEqual(status.browsers, [
        { browser: "firefox", browserVersion: firefox.version, connected: true },
      ]);
      for (const path of ["/json/version", "/json/list"]) {
        const res = await daemon.get(path);
        assert.equal(res.status, 501, path);
        assert.match(await res.text(), /unsupported/u, path);
      }
      await until(
        async () =>
          (await firefox.evaluate(popup, "document.body.innerText")).includes("Connected"),
        "popup reports the connection",
      );
    });

    await step("evaluate needs the userScripts grant from the settings page", async () => {
      const nav = await call("navigate", { url: site.url, group_title: "Fixture" });
      tabId = nav.tabId;
      assert.equal(nav.url, site.url);
      await rejectsUnsupported("evaluate", { code: "document.title" });
      const settings = await firefox.openExtensionPage("app.html#settings");
      const granted = () =>
        firefox.evaluate(settings, "chrome.permissions.contains({ permissions: ['userScripts'] })");
      assert.equal(await granted(), false);
      await until(
        () => firefox.evaluate(settings, "document.querySelector('#user-scripts') !== null"),
        "Allow scripts button",
      );
      await firefox.click(settings, "#user-scripts");
      await until(granted, "userScripts granted");
      assert.equal(await value("document.title"), "Bridge fixture");
      assert.equal(await value("(async () => 6 * 7)()"), 42);
    });

    await step("DOM references, synthetic clicks and trusted text input", async () => {
      const tree = await call("snapshot");
      assert.match(tree.tree, /Bridge fixture/u);
      const ref = tree.tree
        .split("\n")
        .find((line) => line.includes('button "Record click"'))
        .trim()
        .split(" ")[0];
      await call("click", { selector: ref });
      assert.equal(await value("globalThis.clicks"), 1);
      // Extension clicks are synthetic events in Firefox.
      assert.equal(await value("globalThis.lastTrusted"), false);
      await call("fill", { selector: "#name", value: "Avery · 测试" });
      assert.equal(await value("document.querySelector('#name').value"), "Avery · 测试");
      assert.equal(await value("globalThis.inputs.at(-1)"), true);
      await call("fill", { selector: "#notes", value: "line one\nline two" });
      assert.equal(await value("document.querySelector('#notes').value"), "line one\nline two");
      await call("fill", { selector: "#editor", value: "rich text ✓" });
      assert.equal(await value("document.querySelector('#editor').innerText"), "rich text ✓");
      await call("fill", { selector: "#name", value: "" });
      await call("focus", { selector: "#name" });
      await call("key_type", { text: "typed" });
      assert.equal(await value("document.querySelector('#name').value"), "typed");
      await call("send_keys", { keys: "Control+A" });
      await call("send_keys", { keys: "Backspace" });
      assert.equal(await value("document.querySelector('#name').value"), "");
      await call("select_option", { selector: "#choice", value: "Beta" });
      assert.equal(await value("document.querySelector('#choice').value"), "b");
      await call("wait", { selector: "#result" });
      await call("hover", { selector: "#hover" });
      assert.equal(await value("document.querySelector('#result').textContent"), "Hovered");
      await call("scroll", { selector: "#bottom" });
      // The activity layer framed the scrolled element. The check reads the page
      // from an extension page, before the next action moves the frame.
      assert.equal(
        await firefox.evaluate(
          popup,
          `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, func: () => document.querySelector("omw-activity")?.shadowRoot?.querySelector(".frame")?.hasAttribute("data-on") ?? false }).then(([entry]) => entry.result)`,
        ),
        true,
      );
      assert.ok(await value("scrollY > 0"));
      assert.match((await call("read_page")).text, /Bridge fixture/u);
      assert.ok((await call("find", { query: "Record click" })).matches.length);
      await call("navigate", { url: `${site.url}?again=1` });
      await assert.rejects(call("click", { selector: ref }), { code: "stale_ref" });
    });

    await step("semantic locators, state, batching, headers, history and downloads", async () => {
      await call("fill", { selector: 'label="Name"', value: "label works" });
      await call("locate", {
        by: "role",
        value: "textbox",
        name: "Name",
        cmd: "fill",
        text: "role works",
      });
      assert.equal(
        (await call("get", { selector: "#name", property: "value" })).value,
        "role works",
      );
      assert.equal(
        (await call("get", { selector: 'role=button[name="Record click"]', property: "count" }))
          .value,
        1,
      );
      assert.equal((await call("is", { selector: "#disabled", property: "enabled" })).value, false);
      await call("check", { selector: "#check" });
      await call("check", { selector: "#check" });
      assert.equal((await call("is", { selector: "#check", property: "checked" })).value, true);
      await call("uncheck", { selector: "#check" });
      await value(
        `(()=>{const host=document.body.appendChild(document.createElement('div'));host.attachShadow({mode:'open'}).innerHTML='<input data-testid="shadow" placeholder="Shadow name">';return true})()`,
      );
      await call("fill", { selector: "testid=shadow", value: "shadow works" });
      assert.equal(
        (await call("get", { selector: "placeholder=Shadow name", property: "value" })).value,
        "shadow works",
      );
      await call("wait", { expression: "document.querySelector('#check').checked===false" });
      const batch = await call("batch", {
        steps: [
          { action: "storage", args: { cmd: "set", name: "fixture", value: "stored" } },
          { action: "storage", args: { cmd: "get", name: "fixture" } },
          {
            action: "cookies",
            args: { cmd: "set", data: { name: "omw_fixture", value: "cookie" } },
          },
        ],
      });
      assert.equal(batch.results[1].value, "stored");
      assert.ok(
        (await call("cookies")).cookies.some(
          (c) => c.name === "omw_fixture" && c.value === "cookie",
        ),
      );
      await call("emulate", { data: { "X-Omw-Fixture": "header" } });
      await call("navigate", { url: `${site.url}next` });
      assert.equal(
        site.requests.findLast((r) => r.path === "/next").headers["x-omw-fixture"],
        "header",
      );
      await call("history", { cmd: "back" });
      await until(async () => (await value("location.search")) === "?again=1", "history back");
      await call("history", { cmd: "forward" });
      await until(async () => (await value("location.pathname")) === "/next", "history forward");
      // A 204 response keeps the current document.
      const empty = await call("navigate", { url: `${site.url}no-content` }, "fixture", 5000);
      assert.equal(empty.url, `${site.url}next`);
      assert.ok(site.hits("/no-content") > 0);
      assert.equal(await value("location.pathname"), "/next");
      const download = await call("download", {
        url: `${site.url}download.txt`,
        filename: `omw-e2e-${Date.now()}.txt`,
      });
      assert.equal(await readFile(download.path, "utf8"), "download fixture");
      await rm(download.path);
      await call("navigate", { url: `${site.url}?again=1` });
    });

    await step("uploads through the daemon, network capture and screenshots", async () => {
      const upload = join(dir, "upload.txt");
      await writeFile(upload, "bridge upload");
      await call("upload", { selector: "#file", files: [upload] });
      assert.deepEqual(await value("globalThis.upload"), {
        name: "upload.txt",
        size: 13,
        type: "text/plain",
      });
      const large = join(dir, "large.bin");
      await writeFile(large, Buffer.alloc((16 << 20) + 1));
      for (const files of [[large], ["upload.txt"], [dir]])
        await assert.rejects(call("upload", { selector: "#file", files }), {
          code: "invalid_args",
        });
      await call("network", { cmd: "start" });
      await call("click", { selector: "#fetch" });
      const requests = await until(async () => {
        const r = await call("network", { cmd: "list", filter: "/api" });
        return (
          r.requests.some((request) => request.status === 200 && request.complete) && r.requests
        );
      }, "network response");
      const detail = await call("network", {
        cmd: "detail",
        requestId: requests.find((r) => r.status === 200 && r.complete).requestId,
      });
      assert.match(detail.body, /"ok":true/u);
      await call("network", { cmd: "stop" });
      for (const args of [{ selector: "#submit" }, {}, { fullPage: true }]) {
        const image = await call("screenshot", args);
        assert.ok(image.sizeBytes > 100, JSON.stringify(args));
        assert.equal((await readFile(image.path)).subarray(1, 4).toString(), "PNG");
      }
    });

    await step("same-origin and cross-origin iframes", async () => {
      await call("navigate", { url: `${site.url}frames` });
      const origin = site.url.replace("127.0.0.1", "localhost");
      await until(async () => {
        const urls = (await call("frame", { cmd: "list" })).frames.map((f) => f.url);
        return urls.includes(`${site.url}frame`) && urls.includes(`${origin}frame`);
      }, "both frames loaded");
      for (const selector of ["#same", "#cross"]) {
        await call("frame", { selector });
        await call("fill", { selector: 'label="Frame name"', value: `inside ${selector}` });
        assert.equal(
          (await call("get", { selector: "#frame-input", property: "value" })).value,
          `inside ${selector}`,
        );
        assert.match((await call("snapshot")).tree, /Frame button/u);
        await call("click", { selector: 'role=button[name="Frame button"]' });
        assert.equal(await value("document.title"), "Frame clicked");
        await call("frame", { cmd: "main" });
        assert.equal(await value("document.title"), "Frames fixture");
      }
      // Firefox reports the tab's unchanged URL once an iframe that moved to
      // another site is removed; the selection stays.
      const frameUrls = async () => (await call("frame", { cmd: "list" })).frames.map((f) => f.url);
      await call("frame", { selector: "#same" });
      await value(
        `(()=>{const f=parent.document.createElement('iframe');f.id='extra';f.src=${JSON.stringify(`${site.url}next`)};parent.document.body.append(f);return true})()`,
      );
      await until(
        async () => (await frameUrls()).includes(`${site.url}next`),
        "extra frame loaded",
      );
      await value(
        `(()=>{parent.document.querySelector('#extra').src=${JSON.stringify(`${origin}next`)};return true})()`,
      );
      await until(async () => (await frameUrls()).includes(`${origin}next`), "extra frame moved");
      await value("(()=>{parent.document.querySelector('#extra').remove();return true})()");
      await until(
        async () => !(await frameUrls()).includes(`${origin}next`),
        "extra frame removed",
      );
      await delay(1000);
      assert.equal(await value("location.href"), `${site.url}frame`);
      assert.equal(
        (await call("get", { selector: "#frame-input", property: "value" })).value,
        "inside #same",
      );
      await call("frame", { cmd: "main" });
      // A selected iframe that moves to another site ends the selection:
      // cookies reports frame_unavailable and leaves that site's cookies alone.
      await call("navigate", { url: `${origin}next` }, "other-site");
      await call(
        "cookies",
        { cmd: "set", data: { name: "omw_other", value: "kept" } },
        "other-site",
      );
      await call("frame", { selector: "#same" });
      await value(
        `(()=>{setTimeout(()=>{location.href=${JSON.stringify(`${origin}next?moved`)}},100);return true})()`,
      );
      await until(
        async () => (await frameUrls()).includes(`${origin}next?moved`),
        "selected frame moved",
      );
      const cleared = await daemon.command({
        session: "fixture",
        action: "cookies",
        args: { cmd: "clear" },
        timeoutMs: 10000,
      });
      assert.equal(cleared.error?.code, "frame_unavailable", JSON.stringify(cleared));
      assert.equal(await value("document.title"), "Frames fixture");
      assert.ok(
        (await call("cookies", {}, "other-site")).cookies.some(
          (c) => c.name === "omw_other" && c.value === "kept",
        ),
      );
      await call("close_session", {}, "other-site");
    });

    await step("actions Firefox cannot perform return unsupported with HTTP 501", async () => {
      for (const [action, args] of unsupported) await rejectsUnsupported(action, args);
      // The session still works after rejected actions.
      assert.equal((await call("list_tabs")).tabs[0].tabId, tabId);
    });

    await step("presets filter requests in every frame of the owned tab", async () => {
      const session = "presets";
      const adHits = () => site.hits("/preset-asset/ad.js", adHost);
      const assetHits = () =>
        site.requests.filter((r) => r.path.startsWith("/preset-asset/")).length;
      let ads = adHits();
      await call("navigate", { url: `${site.url}preset-page` }, session);
      let status = await call("preset", { cmd: "status" }, session);
      assert.equal(status.name, "anti-ad");
      assert.equal(status.network, true);
      assert.ok(status.blocked >= 1);
      assert.equal(adHits(), ads);
      assert.equal(await value("globalThis.inlineScript", session), true);
      // A preset that blocks the document keeps the tab's page.
      const blocked = await call(
        "navigate",
        { url: `http://${adHost}:${new URL(site.url).port}/preset-asset/ad.js` },
        session,
        5000,
      );
      assert.equal(blocked.url, `${site.url}preset-page`);
      assert.equal(adHits(), ads);
      await call(
        "navigate",
        { url: `${site.url}preset-page?environment=1`, environment: true },
        session,
      );
      assert.equal(
        (await call("preset", { cmd: "status" }, session)).environmentState,
        "unavailable",
      );

      const assets = assetHits();
      await call(
        "navigate",
        {
          url: `${site.url}preset-page?zen=1`,
          preset: "zen",
          zen: { images: true, fonts: true, css: true, javascript: true },
        },
        session,
      );
      assert.equal(await value("typeof globalThis.inlineScript", session), "undefined");
      assert.equal(assetHits(), assets);

      await call("navigate", { url: `${site.url}preset-page?none=1`, preset: "none" }, session);
      assert.equal(
        await value("globalThis.inlineScript && globalThis.externalScript", session),
        true,
      );
      // The ad host resolves to the site, so an unfiltered page fetches it.
      assert.ok(adHits() > ads);

      // A preset switch applies to an existing cross-site iframe.
      const childURL = `${site.url.replace("127.0.0.1", "localhost")}preset-page?child=1`;
      await value(
        `(()=>{const frame=document.createElement('iframe');frame.src=${JSON.stringify(childURL)};document.body.append(frame);return true})()`,
        session,
      );
      const child = await until(async () => {
        const { contexts } = await firefox.send("browsingContext.getTree", {});
        return contexts.flatMap((c) => c.children ?? []).find((c) => c.url === childURL)?.context;
      }, "cross-site preset frame");
      await call("preset", { preset: "anti-ad" }, session);
      ads = adHits();
      await firefox.send("browsingContext.navigate", {
        context: child,
        url: `${childURL}&mode=anti-ad`,
        wait: "complete",
      });
      assert.equal(adHits(), ads);
      assert.equal(await firefox.evaluate(child, "globalThis.inlineScript"), true);
      status = await call("preset", { cmd: "status" }, session);
      assert.equal(status.name, "anti-ad");
      await call("close_session", {}, session);
    });

    await step("an idle event page keeps its connection through the heartbeat", async () => {
      // Firefox suspends an idle event page after 30 seconds; the heartbeat
      // renews it, so the connection must not drop during a longer idle period.
      for (let second = 0; second < 45; second++) {
        assert.ok(await firefoxStatus(), `connected after ${second} idle seconds`);
        await delay(1000);
      }
      assert.equal((await call("list_tabs")).tabs[0].tabId, tabId);
    });

    await step("daemon restart while the event page is suspended reconnects", async () => {
      await daemon.stop();
      // Longer than the idle timeout, so only the reconnect alarm wakes the page.
      await delay(35000);
      await daemon.start();
      await until(firefoxStatus, "Firefox extension reconnected", 70000);
      assert.equal((await call("list_tabs")).tabs[0].tabId, tabId);
      await call("close_session");
      assert.equal((await call("list_tabs")).tabs.length, 0);
    });
  },
);
