// Shared pieces of the Firefox and dual-browser end-to-end tests: the omw
// daemon on its fixed port and a local fixture site.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const daemonPort = 17373;
const daemonURL = `http://127.0.0.1:${daemonPort}`;

export async function until(fn, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw Error(`timed out after ${timeout} ms: ${label}`);
}

const listening = () =>
  new Promise((done) => {
    const socket = connect(daemonPort, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });

// Starts dist/omw serve with its own OMW_HOME. The daemon port is shared by
// every local test, so a port that is already in use fails the test.
export async function startDaemon(home) {
  let child;
  let logs = "";
  const spawnDaemon = async () => {
    if (await listening())
      throw Error(`127.0.0.1:${daemonPort} is in use; another omw daemon or test is running`);
    child = spawn(resolve("dist/omw"), ["serve"], {
      env: { ...process.env, OMW_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = (chunk) => {
      logs = (logs + chunk).slice(-65536);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
  };
  await spawnDaemon();
  const config = await until(
    () => readFile(join(home, "config.json"), "utf8").then(JSON.parse, () => false),
    "daemon config",
  );
  const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  const status = () =>
    fetch(`${daemonURL}/status`, { headers }).then(
      (res) => (res.ok ? res.json() : false),
      () => false,
    );
  await until(status, "daemon status");
  // One POST /command; returns the HTTP status with the parsed body.
  const command = async (body) => {
    const res = await fetch(`${daemonURL}/command`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((body.timeoutMs ?? 30000) + 5000),
    });
    return { status: res.status, ...(await res.json()) };
  };
  return {
    token: config.token,
    headers,
    status,
    command,
    logs: () => logs,
    get: (path) => fetch(`${daemonURL}${path}`, { headers }),
    // Runs an action and returns its result; failures throw with the error code.
    async call(action, args = {}, { session = "fixture", browser, timeoutMs = 30000 } = {}) {
      const reply = await command({ session, action, args, timeoutMs, browser });
      if (reply.status !== 200 || reply.error)
        throw Object.assign(Error(`${session}/${action}: ${JSON.stringify(reply.error)}`), {
          code: reply.error?.code,
          status: reply.status,
        });
      return reply.result;
    },
    async stop() {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      if (!(await Promise.race([exited.then(() => true), delay(5000, false, { ref: false })]))) {
        child.kill("SIGKILL");
        await exited;
      }
      await until(async () => !(await listening()), "daemon port released");
    },
    async start() {
      await spawnDaemon();
      await until(status, "restarted daemon status");
    },
  };
}

const formPage = `<!doctype html><title>Bridge fixture</title>
<style>body{font:16px system-ui;padding:30px}input,textarea,select,button,[contenteditable]{display:block;margin:12px}#editor{min-height:30px;border:1px solid #999}</style>
<h1>Bridge fixture</h1><input id="name" aria-label="Name"><textarea id="notes" aria-label="Notes"></textarea>
<div id="editor" contenteditable="true" role="textbox" aria-label="Editor">old</div>
<select id="choice" aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
<input id="check" type="checkbox" aria-label="Accept"><input id="disabled" aria-label="Disabled" disabled><input id="file" type="file" aria-label="Attachment"><button id="submit">Record click</button><button id="fetch">Fetch data</button>
<button id="hover" onmouseenter="document.querySelector('#result').textContent='Hovered'">Hover target</button><p id="result"></p><div style="height:1200px">Scroll area</div><p id="bottom">Bottom</p>
<script>globalThis.clicks=0;globalThis.inputs=[];
document.querySelector('#submit').onclick=e=>{globalThis.clicks++;globalThis.lastTrusted=e.isTrusted;document.querySelector('#result').textContent='Clicked '+globalThis.clicks};
document.querySelector('#name').addEventListener('input',e=>globalThis.inputs.push(e.isTrusted));
document.querySelector('#file').addEventListener('change',e=>{const f=e.target.files[0];globalThis.upload={name:f.name,size:f.size,type:f.type}});
document.querySelector('#fetch').onclick=()=>fetch('/api').then(r=>r.json()).then(v=>{globalThis.fetchValue=v});
</script>`;

// A local site serving the form, frame, preset and download fixtures. Every
// request is recorded with its Host header, so a test can tell which hosts and
// resources a browser actually fetched.
export async function startSite() {
  const requests = [];
  let port;
  const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    requests.push({ host: req.headers.host, path, url: req.url, headers: req.headers });
    res.setHeader("Cache-Control", "no-store");
    const html = (body) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(body);
    };
    if (path === "/") return html(formPage);
    if (path === "/next") return html("<!doctype html><title>Next page</title><p>Next</p>");
    if (path === "/frame")
      return html(
        '<!doctype html><title>Child frame</title><input aria-label="Frame name" id="frame-input"><button onclick="globalThis.frameClicks=(globalThis.frameClicks??0)+1;document.title=\'Frame clicked\'">Frame button</button>',
      );
    if (path === "/frames")
      return html(
        `<!doctype html><title>Frames fixture</title><iframe id="same" src="/frame"></iframe><iframe id="cross" src="http://localhost:${port}/frame"></iframe>`,
      );
    if (path === "/preset-page")
      return html(
        `<!doctype html><title>Preset fixture</title><link rel="stylesheet" href="/preset-asset/style.css"><link rel="preload" href="/preset-asset/font.woff2" as="font" crossorigin><h1>Preset fixture</h1><img src="/preset-asset/photo.svg"><script src="/preset-asset/site.js"></script><script>globalThis.inlineScript=true</script><script src="http://googleads.g.doubleclick.net:${port}/preset-asset/ad.js"></script>`,
      );
    if (path.startsWith("/preset-asset/")) {
      const [type, body] = path.endsWith(".js")
        ? ["text/javascript", "globalThis.externalScript=true"]
        : path.endsWith(".css")
          ? ["text/css", "body{background:rgb(1,2,3)}"]
          : path.endsWith(".svg")
            ? ["image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>']
            : ["font/woff2", "fixture-font"];
      res.setHeader("Content-Type", type);
      return res.end(body);
    }
    if (path === "/download.txt") {
      res.setHeader("Content-Disposition", 'attachment; filename="fixture.txt"');
      return res.end("download fixture");
    }
    if (path === "/no-content") {
      res.statusCode = 204;
      return res.end();
    }
    if (path === "/api") {
      res.setHeader("Content-Type", "application/json");
      return res.end('{"ok":true}');
    }
    res.statusCode = 404;
    res.end("missing");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    requests,
    // Requests for path, optionally only those addressed to host (without port).
    hits: (path, host) =>
      requests.filter((r) => r.path === path && (!host || r.host === `${host}:${port}`)).length,
    close() {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  };
}
