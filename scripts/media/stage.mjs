// The stage every media scene runs on: an isolated omw daemon, the fixture site
// in scripts/media/fixtures, and Chrome for Testing with the built extension.
// Nothing touches the user's own daemon configuration or browser profile.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { format } from "../../extension/src/i18n.ts";

// CSS pixels of every recorded page. Frames are captured at twice this size.
export const viewport = { width: 1080, height: 675 };
export const scale = 2;

const fixtures = resolve("scripts/media/fixtures");
const icons = resolve("node_modules/lucide-static/icons");
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function until(read, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Serves the fixture pages, lucide icons under /icons/, and the stand-in ad
// creatives that the anti-ad preset blocks.
async function serveFixtures() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    const file = path.startsWith("/icons/")
      ? join(icons, path.slice("/icons/".length))
      : join(fixtures, path === "/" ? "index.html" : path);
    if (!file.startsWith(fixtures) && !file.startsWith(icons)) {
      response.writeHead(403).end();
      return;
    }
    readFile(file).then(
      (body) => {
        response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
        response.setHeader("Cache-Control", "no-store");
        response.end(body);
      },
      () => response.writeHead(404).end(),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, port, close: () => server.close() };
}

async function startDaemon(home) {
  const daemon = spawn(resolve("dist/omw"), ["serve"], {
    env: { ...process.env, OMW_HOME: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  daemon.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  const config = await until(
    () =>
      readFile(join(home, "config.json"), "utf8").then(
        (text) => JSON.parse(text),
        () => undefined,
      ),
    "daemon config",
  );
  await until(
    () =>
      fetch("http://127.0.0.1:17373/status", {
        headers: { Authorization: `Bearer ${config.token}` },
      }).then(
        (response) => response.ok,
        () => false,
      ),
    `daemon on 127.0.0.1:17373 ${logs}`,
  );
  return {
    token: config.token,
    stop: async () => {
      if (daemon.exitCode !== null || daemon.signalCode !== null) return;
      const exited = once(daemon, "exit");
      daemon.kill("SIGTERM");
      await exited;
    },
  };
}

// Streams a page's frames with CDP screencast. Frames arrive whenever the page
// repaints; compose.mjs turns them into a constant frame rate.
async function screencast(page, dir) {
  await mkdir(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const writes = [];
  const marks = {};
  // Frame timestamps come from Chrome's own clock; `offset` maps it to Date.now().
  let offset = 0;
  const now = () => Date.now() / 1000 - offset;
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    if (frames.length === 0) offset = Date.now() / 1000 - metadata.timestamp;
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    frames.push({ file, time: metadata.timestamp });
    writes.push(writeFile(file, data, "base64"));
    // The last acknowledgement can race the end of the screencast.
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, everyNthFrame: 1 });
  await until(() => frames.length > 0, "first screencast frame");
  return {
    // Names a moment of the recording, in seconds from its first frame.
    mark(name) {
      marks[name] = now() - frames[0].time;
    },
    async stop() {
      const end = now();
      await cdp.send("Page.stopScreencast");
      await cdp.detach();
      await Promise.all(writes);
      const start = frames[0].time;
      return {
        frames: frames.map((frame) => ({ file: frame.file, time: frame.time - start })),
        duration: end - start,
        marks,
      };
    },
  };
}

// `headed` opens a visible window, for sites that turn headless browsers away.
export async function openStage(work, { daemon = true, language = "en", headed = false } = {}) {
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const executablePath = process.env.CHROME_BIN;
  if (!executablePath) throw new Error("CHROME_BIN must point at Chrome for Testing");
  const site = await serveFixtures();
  const home = join(work, "home");
  let server;
  let context;
  const close = async () => {
    await context?.close();
    await server?.stop();
    site.close();
  };
  try {
    if (daemon) server = await startDaemon(home);
    context = await launch(work, executablePath, headed);
    await fitWindow(context);
  } catch (error) {
    // A half-started stage would keep port 17373 for the next scene.
    await close();
    throw error;
  }
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const base = worker.url().replace(/worker\.js$/u, "");
  // The interface language is a stored preference, independent of the browser language.
  await worker.evaluate(
    (choice) =>
      chrome.storage.local.set({ preferences: { activityLayer: true, language: choice } }),
    language,
  );
  const connection = () =>
    worker.evaluate(async () => (await chrome.storage.session.get("connection")).connection);

  const stage = {
    context,
    worker,
    adPort: site.port,
    site: (path) => site.origin + path,
    extension: (path) => base + path,
    delay,
    until,
    token: () => server?.token,
    // Interface text of the extension in the recorded language.
    message: (key, values) => format(language, key, values),
    async startDaemon() {
      server ??= await startDaemon(home);
    },
    // Stores the daemon token the way the setup page does after pairing.
    async pair() {
      await stage.startDaemon();
      await worker.evaluate(
        (token) => chrome.storage.local.set({ token, paused: false }),
        server.token,
      );
      await until(async () => (await connection())?.state === "connected", "extension connected");
    },
    async pairingCode() {
      const response = await fetch("http://127.0.0.1:17373/pairing", {
        method: "POST",
        headers: { Authorization: `Bearer ${server.token}` },
      });
      if (!response.ok) throw new Error(`pairing: HTTP ${response.status}`);
      return (await response.json()).code;
    },
    // Runs one action the way an agent does, through POST /command.
    async agent(action, args = {}, session = "demo") {
      const response = await fetch("http://127.0.0.1:17373/command", {
        method: "POST",
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session, action, args, timeoutMs: 30000 }),
      });
      const reply = await response.json();
      if (reply.error) throw new Error(`${action}: ${reply.error.code} ${reply.error.message}`);
      return reply.result;
    },
    // The Playwright page of a tab whose URL starts with prefix.
    tab: (prefix) =>
      until(() => context.pages().find((page) => page.url().startsWith(prefix)), `tab ${prefix}`),
    // Opens a page in the foreground, where Chrome paints it for the screencast.
    async open(url) {
      const page = await context.newPage();
      await page.goto(url);
      await page.bringToFront();
      return page;
    },
    record: (page, name) => screencast(page, join(work, "frames", name)),
    // What the activity layer draws on a page: null when it is absent.
    layer: (page) =>
      page.evaluate(() => {
        const host = document.querySelector("omw-activity");
        if (!host?.shadowRoot) return null;
        return {
          frame: host.shadowRoot.querySelector(".frame")?.hasAttribute("data-on") ?? false,
          favicon: document.querySelector("link[data-omw-icon]") !== null,
        };
      }),
    close,
  };
  return stage;
}

// --window-size includes the window frame, so the window grows until its
// pages measure exactly the recorded viewport.
async function fitWindow(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  const { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
  const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
  await cdp.send("Browser.setWindowBounds", {
    windowId,
    bounds: {
      width: bounds.width + viewport.width - width,
      height: bounds.height + viewport.height - height,
    },
  });
  await until(
    async () =>
      (await page.evaluate(() => [innerWidth, innerHeight])).join() ===
      `${viewport.width},${viewport.height}`,
    "window at the recorded viewport size",
  );
  await cdp.detach();
}

function launch(work, executablePath, headed) {
  const extension = resolve("dist/extension");
  return chromium.launchPersistentContext(join(work, "chrome"), {
    executablePath,
    headless: !headed,
    // The window itself has the recorded size and pixel density: screencast
    // frames follow the real window, not an emulated viewport.
    viewport: null,
    colorScheme: "light",
    locale: "en-US",
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--no-sandbox",
      "--hide-scrollbars",
      `--window-size=${viewport.width},${viewport.height}`,
      `--force-device-scale-factor=${scale}`,
      // Chrome shrinks the page under a "started debugging" bar otherwise.
      "--silent-debugger-extension-api",
      "--lang=en-US",
      // Fixture traffic, including the stand-in ad host, stays on this computer.
      "--no-proxy-server",
      "--host-resolver-rules=MAP *.doubleclick.net 127.0.0.1",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
}
