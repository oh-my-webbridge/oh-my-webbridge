import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";

const chrome = process.env.CHROME_BIN;
async function until(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`timed out: ${label}`);
}

test(
  "MV3 bridge end-to-end on an isolated Chrome",
  { skip: !chrome, timeout: 180000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "omw-e2e-"));
    const home = join(dir, "home");
    const resources = new Map();
    let hangEntered = 0;
    const fixture = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (req.url === "/hang-entered") {
        hangEntered++;
        res.end("entered");
        return;
      }
      if (req.url === "/hang") {
        // The synchronous request marks the moment the main thread stops responding.
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<!doctype html><title>Unresponsive fixture</title><script>addEventListener("load",()=>setTimeout(()=>{const request=new XMLHttpRequest();request.open("GET","/hang-entered",false);request.send();for(;;){}}))</script>',
        );
        return;
      }
      if (req.url?.startsWith("/preset-asset/")) {
        const path = req.url.split("?")[0];
        resources.set(path, (resources.get(path) ?? 0) + 1);
        if (path.endsWith(".js")) {
          res.setHeader("Content-Type", "text/javascript");
          res.end("globalThis.externalScript=true");
        } else if (path.endsWith(".css")) {
          res.setHeader("Content-Type", "text/css");
          res.end("body{background:rgb(1,2,3)}");
        } else if (path.endsWith(".svg")) {
          res.setHeader("Content-Type", "image/svg+xml");
          res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
        } else {
          res.setHeader("Content-Type", "font/woff2");
          res.end("fixture-font");
        }
        return;
      }
      if (req.url?.startsWith("/preset-page")) {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!doctype html><title>Preset fixture</title><link rel="stylesheet" href="/preset-asset/style.css"><link rel="preload" href="/preset-asset/font.woff2" as="font" crossorigin><h1>Preset fixture</h1><img src="/preset-asset/photo.svg"><script src="/preset-asset/site.js"></script><script>globalThis.inlineScript=true</script><script src="http://googleads.g.doubleclick.net:${fixture.address().port}/preset-asset/ad.js"></script>`,
        );
        return;
      }
      if (req.url === "/download.txt") {
        res.setHeader("Content-Disposition", 'attachment; filename="fixture.txt"');
        res.end("download fixture");
        return;
      }
      if (req.url === "/download") {
        res.setHeader("Content-Disposition", 'attachment; filename="navigation.txt"');
        res.end("navigation fixture");
        return;
      }
      if (req.url === "/no-content") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === "/reset-content") {
        res.writeHead(205);
        res.end();
        return;
      }
      if (req.url?.startsWith("/frame")) {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<title>Child frame</title><input aria-label="Frame name" id="frame-input"><button onclick="globalThis.trusted=event.isTrusted;document.title=\'Frame clicked\'">Frame button</button>',
        );
        return;
      }
      if (req.url === "/api") {
        res.setHeader("Content-Type", "application/json");
        res.end('{"ok":true}');
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><title>Bridge fixture</title>
      <style>body{font:16px system-ui;padding:30px}input,textarea,select,button,[contenteditable]{display:block;margin:12px}#editor{min-height:30px;border:1px solid #999}</style>
      <h1>Bridge fixture</h1><input id="name" aria-label="Name"><textarea id="notes" aria-label="Notes"></textarea>
      <div id="editor" contenteditable="true" role="textbox" aria-label="Editor">old</div>
      <select id="choice" aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <input id="check" type="checkbox" aria-label="Accept"><input id="disabled" disabled><input id="file" type="file"><button id="submit">Record click</button><button id="fetch">Fetch data</button>
      <button id="dialog">Show dialog</button><p id="result"></p><div style="height:1200px">Scroll area</div><p id="bottom">Bottom</p>
      <script>/* Locator target */</script><style>/* Style only */</style><p id="locator-text">Locator target</p>
      <label for="labelled">Labelled field<style>/* Style label */</style></label><input id="labelled">
      <script>globalThis.clicks=0;globalThis.lastTrusted=false;
      document.querySelector('#submit').onclick=e=>{globalThis.clicks++;globalThis.lastTrusted=e.isTrusted;document.querySelector('#result').textContent='Clicked '+globalThis.clicks};
      document.querySelector('#fetch').onclick=()=>{globalThis.fetchStarted=true;return fetch('/api').then(response=>response.json()).then(value=>{globalThis.fetchValue=value})};document.querySelector('#dialog').onclick=()=>alert('Test dialog');
      const originalQuery=Document.prototype.querySelectorAll;Document.prototype.querySelectorAll=function(selector){if(selector==='#never')globalThis.waitObserved=true;return originalQuery.call(this,selector)};
      </script>`);
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const url = `http://127.0.0.1:${fixture.address().port}/`;
    const daemon = spawn(resolve("dist/omw"), ["serve"], {
      env: { ...process.env, OMW_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let daemonLogs = "";
    daemon.stderr.on("data", (chunk) => {
      daemonLogs += chunk;
    });
    let context;
    t.after(async () => {
      // Diagnostics for hosted macOS runners only; a local run never captures the desktop.
      if (process.platform === "darwin" && process.env.GITHUB_ACTIONS === "true") {
        await mkdir("dist/qa", { recursive: true });
        await promisify(execFile)("screencapture", ["-x", resolve("dist/qa/mac-desktop.png")], {
          timeout: 5000,
        }).catch((error) => t.diagnostic(`desktop capture: ${String(error)}`));
      }
      await Promise.race([
        context?.close().catch((error) => t.diagnostic(`close test Chrome: ${String(error)}`)),
        delay(5000),
      ]);
      // Only kill processes belonging to this disposable profile if graceful
      // close stalled. No personal browser profile is selected or inspected.
      const { stdout } = await promisify(execFile)("ps", ["-ax", "-o", "pid=,command="]);
      for (const line of stdout.split("\n"))
        if (line.includes(`--user-data-dir=${join(dir, "chrome")}`)) {
          const pid = Number(line.trim().match(/^\d+/u)?.[0]);
          if (pid) {
            try {
              process.kill(pid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
          }
        }
      daemon.kill("SIGTERM");
      fixture.close();
      await rm(dir, { recursive: true, force: true });
    });
    await until(async () => {
      try {
        return JSON.parse(await readFile(join(home, "config.json"), "utf8"));
      } catch {
        return false;
      }
    }, "daemon config");
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
    const status = async () => {
      try {
        const res = await fetch("http://127.0.0.1:17373/status", { headers });
        return res.ok ? res.json() : false;
      } catch {
        return false;
      }
    };
    await until(status, `daemon ready ${daemonLogs}`);
    await mkdir(join(dir, "chrome", "Default"), { recursive: true });
    await mkdir(join(dir, "downloads"), { recursive: true });
    await writeFile(
      join(dir, "chrome", "Default", "Preferences"),
      JSON.stringify({
        download: {
          default_directory: join(dir, "downloads"),
          prompt_for_download: false,
          directory_upgrade: true,
        },
      }),
    );
    context = await chromium.launchPersistentContext(join(dir, "chrome"), {
      executablePath: chrome,
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--no-sandbox",
        "--no-proxy-server",
        "--host-resolver-rules=MAP googleads.g.doubleclick.net 127.0.0.1",
        // Hosted macOS VMs may have no usable EGL display. This only changes CI Chrome.
        ...(process.platform === "darwin" ? ["--disable-gpu"] : []),
        "--remote-debugging-port=0",
        `--disable-extensions-except=${resolve("dist/extension")}`,
        `--load-extension=${resolve("dist/extension")}`,
      ],
    });
    // Pairing in normal use starts from a focused Chrome window. Establish that
    // precondition before checking that task navigation preserves the active tab.
    await context.pages()[0].bringToFront();
    // Keep the private download override alive for this test browser. Chrome
    // resets download overrides when the owning CDP session detaches.
    await mkdir(join(dir, "downloads"), { recursive: true });
    const browserControl = await context.browser().newBrowserCDPSession();
    await browserControl.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: join(dir, "downloads"),
    });
    t.after(async () => {
      await browserControl.detach().catch(() => {});
    });
    let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const errors = [];
    const recordError = (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
        t.diagnostic(`extension error: ${msg.text()}`);
      }
    };
    worker.on("console", recordError);
    // Installing opens the setup page, which pairs with a code from omw pair.
    const setup = await until(
      () => context.pages().find((page) => page.url().endsWith("/app.html")),
      "setup page after install",
    );
    // Interface text follows the browser language, so the test reads it from the extension.
    const message = (key, substitutions) =>
      worker.evaluate(([k, s]) => chrome.i18n.getMessage(k, s), [key, substitutions]);
    await setup.getByRole("heading", { name: await message("stepPair") }).waitFor();
    const pairing = await (
      await fetch("http://127.0.0.1:17373/pairing", { method: "POST", headers })
    ).json();
    assert.match(pairing.code, /^\d{6}$/u);
    // The field label names the group and its first digit.
    await setup
      .getByRole("textbox", { name: await message("pairCodeLabel"), exact: true })
      .pressSequentially(pairing.code);
    await setup.getByText(await message("setupDone")).waitFor({ timeout: 35000 });
    assert.equal(
      await worker.evaluate(async () => (await chrome.storage.local.get("token")).token),
      config.token,
    );
    await setup.close();
    await context.pages()[0].bringToFront();
    try {
      // The worker's capped reconnect delay is 30 seconds. Bootstrap gets the
      // same budget as daemon-restart recovery, including handshake time.
      await until(async () => (await status())?.extension_connected, "extension connected", 35000);
    } catch (error) {
      const diagnostics = await Promise.race([
        Promise.all([
          status(),
          worker.evaluate(() => chrome.storage.session.get("connection")),
        ]).catch((cause) => String(cause)),
        delay(1000).then(() => "bootstrap diagnostics timed out"),
      ]);
      t.diagnostic(`bootstrap connection state: ${JSON.stringify(diagnostics)}`);
      throw error;
    }
    async function call(action, args = {}, session = "fixture", timeoutMs = 30000) {
      if (process.platform === "darwin") t.diagnostic(`bridge start ${session}/${action}`);
      const res = await fetch("http://127.0.0.1:17373/command", {
        method: "POST",
        headers,
        body: JSON.stringify({ session, action, args, timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + 5000),
      });
      const result = await res.json();
      if (!res.ok || result.error) {
        if (action === "navigate" || action === "download") {
          const state = await Promise.race([
            worker
              .evaluate(async () => ({
                tabs: await chrome.tabs.query({}),
                downloads: await chrome.downloads.search({}),
              }))
              .catch((error) => String(error)),
            delay(500).then(() => "extension diagnostic timed out"),
          ]);
          t.diagnostic(`failed ${action} state: ${JSON.stringify(state)}`);
          const targets = await Promise.race([
            browserControl.send("Target.getTargets").catch((error) => String(error)),
            delay(500).then(() => "CDP diagnostic timed out"),
          ]);
          t.diagnostic(`native targets: ${JSON.stringify(targets)}`);
        }
        throw Object.assign(new Error(`${action}: ${JSON.stringify(result.error)}`), {
          code: result.error?.code,
        });
      }
      if (process.platform === "darwin") t.diagnostic(`bridge done ${session}/${action}`);
      return result.result;
    }
    async function verify(name, run) {
      let failure;
      await t.test(name, async () => {
        try {
          await run();
        } catch (error) {
          if (name.includes("network capture")) {
            t.diagnostic(
              `network failure state: ${JSON.stringify(await call("network", { cmd: "list" }))}`,
            );
            t.diagnostic(
              `preset failure state: ${JSON.stringify(await call("preset", { cmd: "status" }))}`,
            );
          }
          failure = error;
          throw error;
        }
      });
      if (failure) {
        throw failure;
      }
    }
    const value = async (code, session = "fixture") =>
      (await call("evaluate", { code }, session)).value;
    let tabId;
    await verify("background navigation, AX references, trusted click and rich text", async () => {
      t.diagnostic("background phase: initial active tab query");
      const activeBefore = await worker.evaluate(async () =>
        (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).map((tab) => tab.id),
      );
      t.diagnostic("background phase: navigate");
      const nav = await call("navigate", { url, group_title: "Fixture" });
      tabId = nav.tabId;
      assert.equal(nav.url, url);
      assert.deepEqual(
        await worker.evaluate(async () =>
          (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).map((tab) => tab.id),
        ),
        activeBefore,
      );
      const tree = await call("snapshot");
      assert.match(tree.tree, /Bridge fixture/);
      const ref = tree.tree
        .split("\n")
        .find((line) => line.includes('button "Record click"'))
        .trim()
        .split(" ")[0];
      await call("click", { selector: ref });
      assert.equal(await value("globalThis.clicks"), 1);
      assert.equal(await value("globalThis.lastTrusted"), true);
      // An iframe that loads or navigates after the snapshot leaves its references valid.
      assert.equal(
        await value(
          "new Promise(r=>{const f=document.createElement('iframe');f.id='late';f.onload=()=>r('loaded');f.src='/frame?late';document.body.append(f)})",
        ),
        "loaded",
      );
      await call("click", { selector: ref });
      assert.equal(await value("globalThis.clicks"), 2);
      assert.equal(
        await value(
          "new Promise(r=>{const f=document.getElementById('late');f.onload=()=>r('navigated');f.src='/frame?moved'})",
        ),
        "navigated",
      );
      await call("click", { selector: ref });
      assert.equal(await value("globalThis.clicks"), 3);
      await call("fill", { selector: "#name", value: "Avery · 测试" });
      assert.equal(await value("document.querySelector('#name').value"), "Avery · 测试");
      await call("fill", { selector: "#notes", value: "line one\nline two" });
      assert.equal(await value("document.querySelector('#notes').value"), "line one\nline two");
      await call("fill", { selector: "#editor", value: "rich text ✓" });
      assert.equal(await value("document.querySelector('#editor').innerText"), "rich text ✓");
      await call("fill", { selector: "#name", value: "" });
      assert.equal(await value("document.querySelector('#name').value"), "");
      await call("select_option", { selector: "#choice", value: "Beta" });
      assert.equal(await value("document.querySelector('#choice').value"), "b");
      await call("wait", { selector: "#result" });
      await call("hover", { selector: "#submit" });
      assert.match((await call("read_page")).text, /Bridge fixture/);
      assert.ok((await call("find", { query: "Record click" })).matches.length);
      await call("navigate", { url: `${url}?again=1` });
      await assert.rejects(call("click", { selector: ref }), { code: "stale_ref" });
    });
    await verify("controlled tabs show the activity layer, favicon and toolbar state", async () => {
      const page = context.pages().find((candidate) => candidate.url() === `${url}?again=1`);
      assert.ok(page, "the task tab is visible to the test");
      const layer = () =>
        page.evaluate(() => {
          const host = document.querySelector("omw-activity");
          return host
            ? {
                pointerEvents: getComputedStyle(host).pointerEvents,
                hidden: host.getAttribute("aria-hidden"),
                frame: host.shadowRoot.querySelector(".frame").hasAttribute("data-on"),
                favicon: document.querySelector("link[data-omw-icon]")?.href.slice(0, 24),
              }
            : null;
        });
      const drawn = await until(layer, "activity layer on the task tab");
      assert.deepEqual(
        { ...drawn, frame: undefined },
        {
          pointerEvents: "none",
          hidden: "true",
          frame: undefined,
          favicon: "data:image/png;base64,iV",
        },
      );
      await call("click", { selector: "#submit" });
      await until(async () => (await layer())?.frame, "focus frame around the clicked button");
      const controlled = await message("titleControlled", ["fixture"]);
      await until(
        async () =>
          (await worker.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId)) ===
          controlled,
        "toolbar title for the controlled tab",
      );
      assert.equal((await call("read_page")).text.includes("omw"), false);
      await worker.evaluate(() =>
        chrome.storage.local.set({ preferences: { activityLayer: false } }),
      );
      await until(async () => (await layer()) === null, "layer removed when turned off");
      assert.equal(
        await page.evaluate(() => document.querySelectorAll("link[data-omw-rel]").length),
        0,
        "page icons are restored",
      );
      await worker.evaluate(() =>
        chrome.storage.local.set({ preferences: { activityLayer: true } }),
      );
      await until(layer, "layer drawn again when turned on");
    });
    await verify("navigation ends on a download, a 204 or a 205 response", async () => {
      const paths = ["download", "no-content", "reset-content"];
      // Names the tab and response in a failure and reports each duration.
      const noDocument = async (path, newTab) => {
        const label = `${newTab ? "new tab" : "existing tab"} /${path}`;
        const started = Date.now();
        try {
          return await call("navigate", { url: `${url}${path}`, newTab }, "no-document", 15000);
        } catch (error) {
          const named = new Error(`${label}: ${error.message}`, { cause: error });
          throw Object.assign(named, { code: error.code });
        } finally {
          t.diagnostic(`${label} navigation: ${Date.now() - started} ms`);
        }
      };
      for (const path of paths) {
        const nav = await noDocument(path, true);
        assert.equal(nav.url, "about:blank", `/${path} opens no document`);
        const { tabs } = await call("list_tabs", {}, "no-document");
        assert.ok(
          tabs.some((tab) => tab.tabId === nav.tabId),
          `the /${path} tab stays in the session`,
        );
      }
      const page = await call("navigate", { url, newTab: true }, "no-document");
      for (const path of paths) {
        const nav = await noDocument(path, false);
        assert.deepEqual([nav.tabId, nav.url], [page.tabId, url], `/${path} keeps the page`);
      }
      await call("close_session", {}, "no-document");
    });
    await verify("upload, bounded network capture, screenshot and streamed PDF", async () => {
      const upload = join(dir, "upload.txt");
      await writeFile(upload, "bridge upload");
      await call("upload", { selector: "#file", files: [upload] });
      assert.equal(await value("document.querySelector('#file').files[0].name"), "upload.txt");
      await call("network", { cmd: "start" });
      await call("click", { selector: "#fetch" });
      await until(() => value("globalThis.fetchStarted===true"), "fetch click handler");
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
      assert.match(detail.body, /"ok":true/);
      await call("network", { cmd: "stop" });
      const focusBeforeCapture = await value("document.hasFocus()");
      const image = await call("screenshot", { selector: "#submit" });
      assert.ok(image.sizeBytes > 100);
      assert.equal((await readFile(image.path)).subarray(1, 4).toString(), "PNG");
      const pdf = await call("save_as_pdf", { paper_format: "a4" });
      assert.ok(pdf.sizeBytes > 1000);
      assert.equal((await readFile(pdf.path)).subarray(0, 4).toString(), "%PDF");
      await assert.rejects(call("screenshot", { path: image.path }));
      const activeBeforeCapture = await worker.evaluate(async () =>
        (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).map((tab) => tab.id),
      );
      for (let i = 0; i < 2; i++) {
        const viewport = await call("screenshot");
        assert.equal((await readFile(viewport.path)).subarray(1, 4).toString(), "PNG");
      }
      assert.deepEqual(
        await worker.evaluate(async () =>
          (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).map((tab) => tab.id),
        ),
        activeBeforeCapture,
      );
      assert.equal(await value("document.hasFocus()"), focusBeforeCapture);
      await assert.rejects(call("batch", { steps: [{ action: "screenshot" }] }), {
        code: "invalid_args",
      });
      await assert.rejects(call("locate", { value: "#submit", cmd: "locate" }), {
        code: "invalid_args",
      });
      await call("navigate", { url }, "pdf-peer");
      const concurrentPDFs = await Promise.all([
        call("save_as_pdf"),
        call("save_as_pdf", {}, "pdf-peer"),
      ]);
      assert.notEqual(concurrentPDFs[0].path, concurrentPDFs[1].path);
      for (const pdf of concurrentPDFs)
        assert.equal((await readFile(pdf.path)).subarray(0, 4).toString(), "%PDF");
      await call("close_session", {}, "pdf-peer");
    });
    await verify("semantic and shadow locators, state, batching and environment", async () => {
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
      // Text inside script and style elements is not page text.
      assert.equal(
        (await call("get", { selector: "text=Locator target", property: "count" })).value,
        1,
      );
      assert.equal(
        (
          await call("get", {
            selector: "text=Locator target",
            property: "attr",
            attribute: "id",
          })
        ).value,
        "locator-text",
      );
      assert.equal(
        (await call("get", { selector: "text=Style only", property: "count" })).value,
        0,
      );
      await call("fill", { selector: 'label="Labelled field"', value: "label text" });
      assert.equal(
        (await call("get", { selector: "#labelled", property: "value" })).value,
        "label text",
      );
      assert.equal((await call("is", { selector: "#disabled", property: "enabled" })).value, false);
      await call("check", { selector: "#check" });
      await call("check", { selector: "#check" });
      assert.equal((await call("is", { selector: "#check", property: "checked" })).value, true);
      await call("uncheck", { selector: "#check" });
      await value(
        `(()=>{const host=document.body.appendChild(document.createElement('div'));host.id='shadow-host';host.attachShadow({mode:'open'}).innerHTML='<input data-testid="shadow" placeholder="Shadow name">';return true})()`,
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
      await call("console", { cmd: "start" });
      await value("console.log('omw console fixture')");
      assert.ok(
        (await call("console")).entries.some((e) => e.text.includes("omw console fixture")),
      );
      await call("console", { cmd: "stop" });
      await call("emulate", { width: 900, height: 700, colorScheme: "dark" });
      assert.equal(await value("innerWidth"), 900);
      assert.equal(await value("matchMedia('(prefers-color-scheme: dark)').matches"), true);
      await call("emulate", { offline: true });
      assert.equal(await value("navigator.onLine"), false);
      await call("emulate", { offline: false });
      assert.equal(await value("navigator.onLine"), true);
      const download = await call("download", {
        url: `${url}download.txt`,
        filename: `omw-e2e-${Date.now()}.txt`,
      });
      assert.equal(await readFile(download.path, "utf8"), "download fixture");
      await rm(download.path);
      await call("emulate", { width: 1280, height: 720, colorScheme: "light" });
    });
    await verify("same-origin and cross-origin iframe contexts and trusted input", async () => {
      for (const origin of [url, url.replace("127.0.0.1", "localhost")]) {
        await value(
          `(()=>{document.querySelector('#child')?.remove();const f=document.createElement('iframe');f.id='child';f.name='fixture-child';f.src=${JSON.stringify(origin + "frame")};document.body.prepend(f);return true})()`,
        );
        await until(
          async () =>
            (await call("frame", { cmd: "list" })).frames.some((f) => f.url === origin + "frame"),
          "child frame loaded",
        );
        await call("frame", { selector: "#child" });
        await call("fill", { selector: 'label="Frame name"', value: "inside frame" });
        assert.equal(
          (await call("get", { selector: "#frame-input", property: "value" })).value,
          "inside frame",
        );
        const tree = await call("snapshot");
        assert.match(tree.tree, /Frame button/);
        await call("click", { selector: 'role=button[name="Frame button"]' });
        assert.equal(await value("globalThis.trusted"), true);
        await call("frame", { cmd: "main" });
        assert.equal(await value("document.title"), "Bridge fixture");
      }
      // Runs in the main frame's document whichever frame is selected.
      const main = async (expression) =>
        (
          await call("cdp", {
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true },
          })
        ).result.value;
      // A reference from a snapshot of the cross-site iframe expires with it; the
      // iframe's process numbers its nodes apart from the main document's.
      await call("frame", { selector: "#child" });
      const frameRef = (await call("snapshot")).tree
        .split("\n")
        .find((line) => line.includes('button "Frame button"'))
        .trim()
        .split(" ")[0];
      const remote = url.replace("127.0.0.1", "localhost");
      await main(
        "globalThis.mainClicks=0;addEventListener('click',()=>globalThis.mainClicks++,true);document.querySelector('#child').remove()",
      );
      // Listing reads each child target, so it succeeds without the iframe once
      // the worker has seen the target detach.
      await until(async () => {
        try {
          const { frames } = await call("frame", { cmd: "list" });
          return !frames.some((f) => f.url.startsWith(remote));
        } catch {
          return false;
        }
      }, "cross-site frame detached");
      await assert.rejects(call("click", { selector: frameRef }), { code: "stale_ref" });
      assert.equal(await main("globalThis.mainClicks"), 0);
      // The next command for the removed frame reports it, later ones use the main frame.
      await assert.rejects(call("evaluate", { code: "document.title" }), {
        code: "frame_unavailable",
      });
      assert.equal(await value("document.title"), "Bridge fixture");
      // A selected same-origin iframe that navigates itself.
      await value(
        `(()=>{const f=document.createElement('iframe');f.id='child';f.src=${JSON.stringify(url + "frame")};document.body.prepend(f);return true})()`,
      );
      await until(
        async () =>
          (await call("frame", { cmd: "list" })).frames.some((f) => f.url === url + "frame"),
        "child frame loaded",
      );
      await call("frame", { selector: "#child" });
      const name = await main("document.querySelector('#name').value");
      await value("setTimeout(()=>location.href='/frame?self',10),true");
      await until(
        async () =>
          (await call("frame", { cmd: "list" })).frames.some((f) => f.url === url + "frame?self"),
        "child frame navigated",
      );
      await assert.rejects(call("fill", { selector: "#name", value: "lost frame" }), {
        code: "frame_unavailable",
      });
      assert.equal(await value("document.querySelector('#name').value"), name);
      await main("document.querySelector('#child').remove()");
      // With a cross-site iframe selected, dialog answers alerts from the main
      // document and from that iframe, and both documents continue.
      await value(
        `(()=>{const f=document.createElement('iframe');f.id='child';f.src=${JSON.stringify(remote + "frame")};document.body.prepend(f);return true})()`,
      );
      await until(
        async () =>
          (await call("frame", { cmd: "list" })).frames.some((f) => f.url === remote + "frame"),
        "cross-site frame loaded",
      );
      await call("frame", { selector: "#child" });
      const pageURL = await main("location.href");
      const page = context.pages().find((candidate) => candidate.url() === pageURL);
      // A listener keeps Playwright from dismissing the dialogs itself.
      const keep = () => {};
      page.on("dialog", keep);
      try {
        for (const { message, run, title } of [
          { message: "main dialog", run: main, title: "Bridge fixture" },
          { message: "frame dialog", run: value, title: "Child frame" },
        ]) {
          await run(`setTimeout(()=>alert(${JSON.stringify(message)}),0),true`);
          await until(
            async () => (await call("dialog_status")).dialog?.message === message,
            `${message} reported`,
          );
          assert.deepEqual(await call("dialog", { accept: true }), { success: true });
          await until(async () => (await call("dialog_status")).dialog === null, "dialog closed");
          assert.equal(await run("document.title"), title, message);
        }
      } finally {
        page.off("dialog", keep);
      }
      await call("frame", { cmd: "main" });
      await main("document.querySelector('#child').remove()");
    });
    await verify("concurrent sessions have separate groups and tab ownership", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          call("navigate", { url: `${url}?session=${i}` }, `parallel-${i}`),
        ),
      );
      assert.equal(new Set(results.map((r) => r.tabId)).size, 12);
      await Promise.all(
        results.map((_, i) =>
          call("fill", { selector: "#name", value: `owner-${i}` }, `parallel-${i}`),
        ),
      );
      const values = await Promise.all(
        results.map((_, i) => value("document.querySelector('#name').value", `parallel-${i}`)),
      );
      assert.deepEqual(
        values,
        Array.from({ length: 12 }, (_, i) => `owner-${i}`),
      );
      await assert.rejects(
        call("evaluate", { tabId: results[1].tabId, code: "document.title" }, "parallel-0"),
        { code: "tab_busy" },
      );
      await Promise.all(results.map((_, i) => call("close_session", {}, `parallel-${i}`)));
    });
    await verify(
      "borrowed tabs survive cleanup and native dialogs can unblock execution",
      async () => {
        const external = await context.newPage();
        await external.goto(url);
        await external.bringToFront();
        const borrowed = await call("find_tab", { url, active: true }, "borrowed");
        assert.equal(borrowed.borrowed, true);
        await call("close_session", {}, "borrowed");
        assert.equal(external.isClosed(), false);
        await external.close();
        const ownPage = context.pages().find((page) => page.url() === `${url}?again=1`);
        const dialog = ownPage.waitForEvent("dialog");
        await call("cdp", { method: "Page.enable" });
        const execution = call("evaluate", { code: "(()=>{alert('Test dialog');return 7})()" });
        await dialog;
        await call("dialog", { accept: true });
        assert.equal((await execution).value, 7);
        await call("navigate", { url: `${url}?hung=1` }, "hung-task");
        const hungPage = await until(
          () => context.pages().find((page) => page.url() === `${url}?hung=1`),
          "hung task page observed by Playwright",
        );
        const hanging = call(
          "evaluate",
          { code: "(()=>{document.title='hung-started';return new Promise(()=>{})})()" },
          "hung-task",
          3000,
        ).catch((error) => error);
        await until(async () => (await hungPage.title()) === "hung-started", "hung task executing");
        assert.equal((await call("close_session", {}, "hung-task")).closed, 1);
        assert.ok((await hanging) instanceof Error);
      },
    );
    await verify("raw CDP page transport forwards responses and events", async () => {
      assert.equal(
        (
          await call("cdp", {
            method: "Runtime.evaluate",
            params: { expression: "2+3", returnByValue: true },
          })
        ).result.value,
        5,
      );
      const external = await context.newPage();
      await external.goto(url);
      const targets = await (await fetch("http://127.0.0.1:17373/json/list", { headers })).json();
      const target = targets.find((target) => target.url === url);
      assert.ok(target);
      const client = await chromium
        .connectOverCDP(`http://127.0.0.1:17373`, { headers })
        .catch((error) => error);
      assert.ok(
        client instanceof Error,
        "extension /json/version must not claim browser-level CDP",
      );
      const ws = new WebSocket(target.webSocketDebuggerUrl, { headers });
      await once(ws, "open");
      const packets = [];
      ws.on("message", (data) => packets.push(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      await until(() => packets.find((packet) => packet.id === 1), "CDP response");
      await until(
        () => packets.find((packet) => packet.method === "Runtime.executionContextCreated"),
        "CDP event",
      );
      ws.send(
        JSON.stringify({
          id: 2,
          method: "Runtime.evaluate",
          params: { expression: "6*7", returnByValue: true },
        }),
      );
      assert.equal(
        (await until(() => packets.find((packet) => packet.id === 2), "CDP evaluate")).result.result
          .value,
        42,
      );
      ws.send(
        JSON.stringify({
          id: 3,
          method: "Runtime.evaluate",
          params: {
            expression: "new Promise(resolve=>setTimeout(()=>resolve('slow'),500))",
            awaitPromise: true,
            returnByValue: true,
          },
        }),
      );
      ws.send(
        JSON.stringify({
          id: 4,
          method: "Runtime.evaluate",
          params: { expression: "'fast'", returnByValue: true },
        }),
      );
      await until(() => packets.find((packet) => packet.id === 4), "multiplexed CDP fast response");
      assert.equal(
        packets.some((packet) => packet.id === 3),
        false,
        "CDP commands must not block protocol continuations",
      );
      await until(() => packets.find((packet) => packet.id === 3), "multiplexed CDP slow response");
      ws.close();
      await once(ws, "close");
      await external.close();
    });
    await verify("deadline abort never executes queued late work", async () => {
      const before = await value("globalThis.clicks");
      const ownPage = context.pages().find((page) => page.url() === `${url}?again=1`);
      const first = call("wait", { selector: "#never" }, "fixture", 3000).catch((error) => error);
      await until(
        async () => await ownPage.evaluate(() => globalThis.waitObserved === true),
        "wait actually executing before queuing click",
      );
      const late = call("click", { selector: "#submit" }, "fixture", 20).catch((error) => error);
      await Promise.all([first, late]);
      await delay(150);
      assert.equal(await value("globalThis.clicks"), before);
    });
    await verify("extension popup reports the local connection", async () => {
      const page = await context.newPage();
      await page.goto(worker.url().replace(/worker\.js$/u, "popup.html"));
      await page
        .getByRole("status")
        .getByText(await message("state_connected"))
        .waitFor();
      await page.getByRole("tab", { name: await message("example_form") }).click();
      await page.getByText(await message("example_form_prompt")).waitFor();
      await mkdir("dist/qa", { recursive: true });
      await page.screenshot({ path: "dist/qa/extension.png" });
      await page.close();
    });
    await verify("session cleanup cancels queued work and removes a late-created tab", async () => {
      const before = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
      await worker.evaluate(() => {
        globalThis.originalCreate = chrome.tabs.create.bind(chrome.tabs);
        chrome.tabs.create = async (...args) => {
          globalThis.creationStarted = true;
          await new Promise((resolve) => {
            globalThis.releaseCreation = resolve;
          });
          return globalThis.originalCreate(...args);
        };
      });
      const late = call("navigate", { url: `${url}?late-create=1` }, "late-create").catch(
        (error) => error,
      );
      try {
        await until(
          () => worker.evaluate(() => globalThis.creationStarted),
          "tab creation in flight",
        );
        assert.equal((await call("close_session", {}, "late-create")).closed, 0);
      } finally {
        await worker.evaluate(() => {
          chrome.tabs.create = globalThis.originalCreate;
          globalThis.releaseCreation?.();
        });
      }
      assert.ok((await late) instanceof Error);
      await until(
        async () =>
          (await worker.evaluate(async () => (await chrome.tabs.query({})).length)) === before,
        "late tab cleaned up",
      );
    });
    await verify(
      "anti-ad defaults, environment fallback, Zen resources and restoration",
      async () => {
        resources.clear();
        await call("navigate", { url: `${url}preset-page` }, "presets");
        const status = await call("preset", { cmd: "status" }, "presets");
        assert.equal(status.name, "anti-ad");
        assert.equal(status.network, true);
        assert.ok(status.blocked >= 1);
        assert.equal(resources.get("/preset-asset/ad.js") ?? 0, 0);
        assert.equal(
          (await call("evaluate", { code: "globalThis.inlineScript" }, "presets")).value,
          true,
        );
        resources.clear();
        await call(
          "navigate",
          {
            url: `${url}preset-page?zen=1`,
            preset: "zen",
            zen: { images: true, fonts: true, css: true, javascript: true },
          },
          "presets",
        );
        assert.equal(
          (await call("evaluate", { code: "typeof globalThis.inlineScript" }, "presets")).value,
          "undefined",
        );
        assert.equal(
          [...resources.values()].reduce((a, b) => a + b, 0),
          0,
        );
        await call("navigate", { url: `${url}preset-page?none=1`, preset: "none" }, "presets");
        assert.equal(
          (
            await call(
              "evaluate",
              { code: "globalThis.inlineScript && globalThis.externalScript" },
              "presets",
            )
          ).value,
          true,
        );
        assert.ok((resources.get("/preset-asset/ad.js") ?? 0) > 0);
        await call(
          "navigate",
          { url: `${url}preset-page?environment=1`, preset: "anti-ad", environment: true },
          "presets",
        );
        const injected = await call("preset", { cmd: "status" }, "presets");
        assert.equal(injected.environmentState, "active");
        await call("close_session", {}, "presets");
      },
    );
    await verify("preset switches reach existing cross-site iframe targets", async () => {
      const session = "preset-frames";
      const rootURL = `${url}?preset-frame-root`;
      const root = await call("navigate", { url: rootURL, preset: "none" }, session);
      const page = context.pages().find((page) => page.url() === rootURL);
      assert.ok(page, `owned fixture page ${root.tabId} exists`);
      const childURL = `${url.replace("127.0.0.1", "localhost")}preset-page?child=initial`;
      await call(
        "evaluate",
        {
          code: `(()=>{const frame=document.createElement('iframe');frame.src=${JSON.stringify(childURL)};document.body.append(frame);return true})()`,
        },
        session,
      );
      const child = await until(
        () => page.frames().find((frame) => frame.url() === childURL),
        "cross-site preset frame",
      );
      await child.waitForLoadState("load");
      assert.equal(await child.evaluate("globalThis.inlineScript"), true);
      await call(
        "preset",
        { preset: "zen", zen: { images: true, fonts: true, css: true, javascript: true } },
        session,
      );
      resources.clear();
      await child.goto(`${childURL}&mode=zen`);
      assert.equal(await child.evaluate("typeof globalThis.inlineScript"), "undefined");
      assert.equal(
        [...resources.values()].reduce((sum, count) => sum + count, 0),
        0,
      );
      await call("preset", { preset: "none" }, session);
      resources.clear();
      await child.goto(`${childURL}&mode=none`);
      assert.equal(
        await child.evaluate("globalThis.inlineScript && globalThis.externalScript"),
        true,
      );
      assert.ok((resources.get("/preset-asset/ad.js") ?? 0) > 0);
      await call("preset", { preset: "anti-ad" }, session);
      resources.clear();
      await child.goto(`${childURL}&mode=anti-ad`);
      assert.equal(resources.get("/preset-asset/ad.js") ?? 0, 0);
      await call("close_session", {}, session);
    });
    await verify("an unchanged preset navigates away from an unresponsive page", async () => {
      const session = "unresponsive";
      // A separate site keeps the stuck renderer away from the other fixture tabs.
      const hangURL = `${url.replace("127.0.0.1", "localhost")}hang`;
      const targetURL = `${url}?after-hang=1`;
      try {
        const entered = hangEntered;
        await call("navigate", { url: hangURL }, session);
        assert.equal((await call("preset", { cmd: "status" }, session)).network, true);
        await until(() => hangEntered > entered, "page main thread entered its loop");
        const started = Date.now();
        const navigated = await call("navigate", { url: targetURL }, session, 5000);
        t.diagnostic(`navigation away from the unresponsive page: ${Date.now() - started} ms`);
        assert.equal(navigated.url, targetURL);
        assert.equal(
          (await call("evaluate", { code: "document.title" }, session)).value,
          "Bridge fixture",
        );
        const status = await call("preset", { cmd: "status" }, session);
        assert.equal(status.name, "anti-ad");
        assert.equal(status.network, true);
      } finally {
        await call("close_session", {}, session);
      }
    });
    await verify("daemon restart preserves extension session tabs and reconnects", async () => {
      daemon.kill("SIGTERM");
      await once(daemon, "exit");
      const [port, path] = (await readFile(join(dir, "chrome", "DevToolsActivePort"), "utf8"))
        .trim()
        .split("\n");
      const restarted = spawn(
        resolve("dist/omw"),
        ["serve", "--cdp", `ws://127.0.0.1:${port}${path}`],
        { env: { ...process.env, OMW_HOME: home }, stdio: "ignore" },
      );
      t.after(() => restarted.kill("SIGTERM"));
      await until(async () => (await status())?.extension_connected, "reconnected", 35000);
      const tabs = await call("list_tabs");
      assert.equal(tabs.tabs[0].tabId, tabId);
      const native = await chromium.connectOverCDP("http://127.0.0.1:17373", { headers });
      const browserCDP = await native.newBrowserCDPSession();
      assert.ok((await browserCDP.send("Browser.getVersion")).product.includes("Chrome"));
      const isolated = await native.newContext();
      const page = await isolated.newPage();
      await page.goto(url);
      assert.equal(await page.title(), "Bridge fixture");
      await isolated.close();
      await native.close();
      await call("close_session");
      assert.equal((await call("list_tabs")).tabs.length, 0);
    });
    await verify("a restarted extension worker releases inherited interception", async () => {
      const session = "worker-restart";
      const pageURL = `${url}preset-page?worker-restart=before`;
      await call("navigate", { url: pageURL }, session);
      const before = await call("preset", { cmd: "status" }, session);
      assert.equal(before.name, "anti-ad");
      assert.equal(before.network, true);
      const page = context.pages().find((candidate) => candidate.url() === pageURL);
      assert.ok(page, "owned preset page exists");
      const { targetInfos } = await browserControl.send("Target.getTargets");
      const target = targetInfos.find(
        (info) => info.type === "service_worker" && info.url === worker.url(),
      );
      assert.ok(target, "extension worker target");
      context.on("serviceworker", (candidate) => {
        worker = candidate;
        candidate.on("console", recordError);
      });
      await browserControl.send("Target.closeTarget", { targetId: target.targetId });
      // The terminated worker's WebSocket closes; the tab keeps the extension's
      // debugger session and Fetch interception.
      await until(async () => !(await status())?.extension_connected, "worker stopped", 10000);
      // Chrome starts the worker again on a debugger event or the 30-second
      // reconnect alarm; startup must release the inherited interception.
      const started = Date.now();
      const response = await page.evaluate(async (api) => {
        try {
          const result = await fetch(api, { signal: AbortSignal.timeout(35000) });
          return { status: result.status, body: await result.text() };
        } catch (error) {
          return { error: String(error) };
        }
      }, `${url}api`);
      t.diagnostic(`page request after worker stop settled in ${Date.now() - started} ms`);
      assert.deepEqual(response, { status: 200, body: '{"ok":true}' });
      await until(async () => (await status())?.extension_connected, "worker reconnected", 10000);
      resources.clear();
      const afterURL = `${url}preset-page?worker-restart=after`;
      const navigated = await call("navigate", { url: afterURL }, session);
      assert.equal(navigated.url, afterURL);
      const after = await call("preset", { cmd: "status" }, session);
      assert.equal(after.name, "anti-ad");
      assert.equal(after.network, true);
      assert.ok(after.blocked >= 1);
      assert.equal(resources.get("/preset-asset/ad.js") ?? 0, 0);
      await call("close_session", {}, session);
    });
    assert.deepEqual(
      errors.filter((message) => !message.includes("Cannot connect")),
      [],
    );
  },
);
