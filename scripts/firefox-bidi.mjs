// Launches an isolated Firefox through WebDriver BiDi for the end-to-end tests
// and the release smoke check: a disposable profile with updates disabled, a
// fixed extension UUID, and a BiDi session that installs extensions temporarily.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

export const firefoxAddonId = "oh-my-webbridge@oh-my-webbridge.github.io";
export const firefoxExtensionUuid = "0c0ffee0-0000-4000-8000-000000000001";
// Hosts that resolve to the loopback test site, like Chrome's
// --host-resolver-rules in tests/e2e.test.mjs.
const loopbackHosts = "googleads.g.doubleclick.net";

const userJs = (prefs) =>
  Object.entries(prefs)
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`)
    .join("");

// Starts FIREFOX_BIN with a profile under dir. Firefox writes temporary files,
// including print-driver symlinks, below its own TMPDIR inside dir, so removing
// dir removes the links themselves.
export async function startFirefox({ dir, addonId = firefoxAddonId, prefs = {} }) {
  const binary = process.env.FIREFOX_BIN;
  if (!binary) throw Error("FIREFOX_BIN is required");
  const profile = join(dir, "firefox-profile");
  const temp = join(dir, "firefox-tmp");
  const downloads = join(dir, "firefox-downloads");
  for (const path of [profile, temp, downloads]) await mkdir(path, { recursive: true });
  await writeFile(
    join(profile, "user.js"),
    userJs({
      "app.update.disabledForTesting": true,
      "app.update.auto": false,
      "app.update.staging.enabled": false,
      "browser.shell.checkDefaultBrowser": false,
      "datareporting.policy.dataSubmissionEnabled": false,
      "toolkit.telemetry.reportingpolicy.firstRun": false,
      "extensions.webextensions.uuids": JSON.stringify({ [addonId]: firefoxExtensionUuid }),
      "extensions.webextOptionalPermissionPrompts": false,
      "browser.download.dir": downloads,
      "browser.download.folderList": 2,
      "browser.download.useDownloadDir": true,
      "browser.download.always_ask_before_handling_new_types": false,
      "network.proxy.type": 0,
      "network.trr.mode": 5,
      "network.dns.localDomains": loopbackHosts,
      "dom.security.https_first": false,
      // Extension background and popup console messages go to stdout, so
      // output() and the saved test logs include them.
      "devtools.console.stdout.content": true,
      ...prefs,
    }),
  );
  const child = spawn(
    binary,
    ["-headless", "-no-remote", "-profile", profile, "--remote-debugging-port", "0"],
    {
      env: {
        ...process.env,
        TMPDIR: temp,
        MOZ_NO_REMOTE: "1",
        MOZ_HEADLESS: "1",
        MOZ_CRASHREPORTER_DISABLE: "1",
        // Allows BiDi to navigate to and evaluate in moz-extension:// pages.
        MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  // The most recent 1 MiB of Firefox output, including extension console lines.
  let output = "";
  const record = (chunk) => {
    output = (output + chunk).slice(-(1 << 20));
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);

  let socket;
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`BiDi ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        if (message.type === "success") resolve(message.result);
        else reject(Error(`BiDi ${method}: ${message.error}: ${message.message}`));
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  let session;
  try {
    const deadline = Date.now() + 30000;
    let endpoint;
    while (!(endpoint = output.match(/WebDriver BiDi listening on (ws:\/\/\S+)/u)?.[1])) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw Error(`Firefox did not start WebDriver BiDi: ${output.slice(-2000)}`);
      await delay(100);
    }
    socket = new WebSocket(`${endpoint}/session`);
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "event") for (const listener of listeners) listener(message);
      // A reply to a command that already timed out has no one waiting for it;
      // it is noted in the browser output and later replies are handled as usual.
      else if (pending.has(message.id)) pending.get(message.id)(message);
      else
        record(
          `ignored BiDi ${message.type} for command ${message.id}, which is no longer pending\n`,
        );
    });
    await once(socket, "open");
    session = await send("session.new", { capabilities: {} });
  } catch (error) {
    // A browser that never served a BiDi session is not handed to the caller.
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    throw error;
  }

  // Evaluates an expression in a browsing context and returns its JSON value.
  const evaluate = async (context, expression) => {
    const result = await send("script.evaluate", {
      expression: `(async () => JSON.stringify((await (${expression})) ?? null))()`,
      target: { context },
      awaitPromise: true,
    });
    if (result.type === "exception")
      throw Error(`evaluate ${expression}: ${result.exceptionDetails.text}`);
    return JSON.parse(result.result.value);
  };
  // A BiDi pointer click is a trusted user gesture, which permissions.request needs.
  const click = async (context, selector) => {
    const { nodes } = await send("browsingContext.locateNodes", {
      context,
      locator: { type: "css", value: selector },
    });
    if (nodes.length !== 1) throw Error(`${selector} matches ${nodes.length} elements`);
    await send("input.performActions", {
      context,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              x: 0,
              y: 0,
              origin: { type: "element", element: { sharedId: nodes[0].sharedId } },
            },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await send("input.releaseActions", { context });
  };
  const open = async (url) => {
    const { context } = await send("browsingContext.create", { type: "tab", background: true });
    await send("browsingContext.navigate", { context, url, wait: "complete" });
    return context;
  };

  return {
    version: session.capabilities.browserVersion,
    downloads,
    send,
    evaluate,
    click,
    open,
    output: () => output,
    // Reads the extension's connection state, tabs and frames through an
    // extension page, for failure diagnostics.
    extensionState: (page) =>
      evaluate(
        page,
        `(async () => {
          const tabs = await chrome.tabs.query({});
          return {
            connection: await chrome.storage.session.get("connection"),
            tabs: await Promise.all(
              tabs.map(async ({ id, url, status, discarded, groupId }) => ({
                id,
                url,
                status,
                discarded,
                groupId,
                frames: await chrome.webNavigation.getAllFrames({ tabId: id }),
              })),
            ),
          };
        })()`,
      ),
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Installs temporarily; extensionData is {type:"path"} for an unpacked
    // directory or {type:"archivePath"} for an .xpi file. Returns the add-on id.
    async installExtension(extensionData) {
      return (await send("webExtension.install", { extensionData })).extension;
    },
    // Opens an extension page such as popup.html in a background tab.
    openExtensionPage: (page) => open(`moz-extension://${firefoxExtensionUuid}/${page}`),
    // Closes the browser, then kills only this Firefox process if it is still
    // running after the grace period. Returns a description for diagnostics.
    async close() {
      if (child.exitCode !== null) return `Firefox had exited with ${child.exitCode}`;
      const closing = send("browser.close", {}, 10000).then(
        () => "browser.close succeeded",
        (error) => `browser.close failed: ${error.message}`,
      );
      // An unreferenced grace timer does not keep Node running once Firefox exits.
      const closed = await Promise.race([
        exited.then(() => true),
        delay(15000, false, { ref: false }),
      ]);
      socket.terminate();
      if (closed) return closing;
      child.kill("SIGKILL");
      await exited;
      return `${await closing}; killed Firefox ${child.pid} after 15 s`;
    },
  };
}
