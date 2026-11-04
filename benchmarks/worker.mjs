import { extraAdapter, directCDP } from "./adapters.mjs";
import assert from "node:assert/strict";
import { observed, output, mcpValue } from "./results.mjs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright-core";

const exec = promisify(execFile);
const name = process.argv[2];
const marker = "omw-benchmark-fixture";
const samples = [];
const children = [];
const dir = await mkdtemp(join(tmpdir(), "omw-bench-"));
const before = new Set((await exec("ps", ["-eo", "pid="])).stdout.trim().split(/\s+/u).map(Number));
let peakRssKiB = 0;
let context,
  cleanup = async () => {};
let adapter;
let presetCall;
let presetResults;
const resourceStats = { requests: 0, bytes: 0 };
const errors = [];
let interrupted = false;
process.on("SIGTERM", () => {
  interrupted = true;
});
await writeFile(
  join(process.env.OMW_BENCH_OUTPUT, `${name}-profile.json`),
  JSON.stringify({ dir }),
);
const fixture = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.url?.startsWith("/resource/")) {
    const kind = req.url.split("/")[2].split("?")[0];
    const body =
      kind === "js"
        ? "/*" + "x".repeat(131072) + "*/"
        : kind === "css"
          ? "/*" + "x".repeat(131072) + "*/"
          : kind === "font"
            ? "x".repeat(131072)
            : '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--' +
              "x".repeat(131072) +
              "--></svg>";
    res.setHeader(
      "Content-Type",
      kind === "js"
        ? "text/javascript"
        : kind === "css"
          ? "text/css"
          : kind === "font"
            ? "font/woff2"
            : "image/svg+xml",
    );
    resourceStats.requests++;
    resourceStats.bytes += Buffer.byteLength(body);
    res.end(body);
    return;
  }
  if (req.url?.startsWith("/web2")) {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><title>Static archive fixture</title><link rel="stylesheet" href="/resource/css"><link rel="preload" href="/resource/font" as="font" crossorigin><h1>Static archive fixture</h1>${Array.from({ length: 16 }, (_, i) => `<img src="/resource/image?i=${i}">`).join("")}<script src="/resource/js"></script><script src="http://googleads.g.doubleclick.net:${fixture.address().port}/resource/js?ad=1"></script>`,
    );
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const count = req.url?.includes("dense") ? 2000 : 20;
  res.end(
    `<!doctype html><title>${marker}</title><style>body{font:16px system-ui}input,button{display:block;margin:12px}</style><h1>${marker}</h1><label>Name<input id="name" aria-label="Name"></label><button id="submit">Record</button><output id="result"></output><main>${Array.from({ length: count }, (_, i) => `<p>row ${i} ${marker}</p>`).join("")}</main><script>globalThis.clicks=0;document.querySelector('#submit').onclick=e=>{globalThis.clicks++;globalThis.trusted=e.isTrusted;document.querySelector('#result').textContent=document.querySelector('#name').value};</script>`,
  );
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const url = `http://127.0.0.1:${fixture.address().port}/`;
async function until(fn, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (interrupted) throw Error("benchmark interrupted by worker deadline");
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw Error(`timeout: ${label}`);
}
function launch(command, args, env = process.env) {
  const p = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.on("data", (chunk) => {
    if (errors.length < 20) errors.push(String(chunk).slice(0, 1000));
  });
  children.push(p);
  return p;
}
async function memory() {
  const rows = (await exec("ps", ["-eo", "pid=,rss="])).stdout
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/u).map(Number));
  const current = rows
    .filter(([pid]) => pid === process.pid || !before.has(pid))
    .reduce((n, [, rss]) => n + rss, 0);
  peakRssKiB = Math.max(peakRssKiB, current);
  return current;
}
function text(result) {
  return typeof result === "string" ? result : JSON.stringify(result);
}
function requireMarker(result, value = marker) {
  result = observed(result);
  assert.ok(
    text(result).includes(value),
    `missing result marker ${value}: ${text(result).slice(0, 500)}`,
  );
}
async function measure(workload, fn, verify, count = 20, concurrency = 1) {
  if (process.env.OMW_BENCH_SMOKE === "true")
    count = Math.min(count, concurrency > 1 ? concurrency : 2);
  const raw = [];
  let failureCount = 0;
  let unsupported = 0;
  let outputBytes = 0;
  const start = performance.now();
  for (let at = 0; at < count; at += concurrency) {
    if (interrupted) throw Error("benchmark interrupted by worker deadline");
    await Promise.all(
      Array.from({ length: Math.min(concurrency, count - at) }, async (_, offset) => {
        const i = at + offset;
        const began = performance.now();
        try {
          const value = await fn(i);
          const elapsed = performance.now() - began;
          await verify?.(value, i);
          raw.push(elapsed);
          outputBytes += value?.wireBytes ?? Buffer.byteLength(text(value) ?? "");
        } catch (error) {
          if (error.benchmarkLimit) unsupported++;
          else failureCount++;
          errors.push(`${workload}: ${String(error).slice(0, 1000)}`);
        }
      }),
    );
  }
  const wallMs = performance.now() - start;
  await memory();
  raw.sort((a, b) => a - b);
  samples.push({
    workload,
    concurrency,
    attempts: count,
    failures: failureCount,
    unsupported,
    wallMs,
    p50Ms: raw[Math.floor(raw.length * 0.5)] ?? null,
    p95Ms: raw[Math.min(raw.length - 1, Math.floor(raw.length * 0.95))] ?? null,
    operationsPerSecond: (count - failureCount - unsupported) / (wallMs / 1000),
    meanOutputBytes: outputBytes / (count - failureCount - unsupported || 1),
    latenciesMs: raw,
  });
}
const started = performance.now();
try {
  if (name === "chrome-headless-new") {
    launch(process.env.CHROME_BIN, [
      "--headless=new",
      "--no-sandbox",
      "--no-proxy-server",
      "--host-resolver-rules=MAP googleads.g.doubleclick.net 127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(dir, "chrome")}`,
      "--window-size=1280,720",
      "about:blank",
    ]);
    await until(async () => {
      try {
        return (await readFile(join(dir, "chrome", "DevToolsActivePort"), "utf8"))
          .trim()
          .split("\n")[0];
      } catch {
        return false;
      }
    }, "raw Chrome endpoint");
    const port = (await readFile(join(dir, "chrome", "DevToolsActivePort"), "utf8")).split("\n")[0];
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    context = browser.contexts()[0];
  } else
    context = await chromium.launchPersistentContext(join(dir, "chrome"), {
      executablePath: process.env.CHROME_BIN,
      headless: true,
      viewport: { width: 1280, height: 720 },
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--no-sandbox",
        "--no-proxy-server",
        "--host-resolver-rules=MAP googleads.g.doubleclick.net 127.0.0.1",
        "--remote-debugging-port=0",
        ...(name === "oh-my-webbridge"
          ? [
              `--disable-extensions-except=${resolve("dist/extension")}`,
              `--load-extension=${resolve("dist/extension")}`,
            ]
          : []),
      ],
    });
  const [port, path] = await until(async () => {
    try {
      const lines = (await readFile(join(dir, "chrome", "DevToolsActivePort"), "utf8"))
        .trim()
        .split("\n");
      const port = Number(lines[0]);
      return Number.isInteger(port) &&
        port > 0 &&
        port <= 65535 &&
        lines[1]?.startsWith("/devtools/browser/")
        ? lines
        : false;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, "Chrome native endpoint");
  const endpoint = `http://127.0.0.1:${port}`;
  const ws = `ws://127.0.0.1:${port}${path}`;
  if (name === "oh-my-webbridge") {
    const home = join(dir, "home");
    launch(resolve("dist/omw"), ["serve"], { ...process.env, OMW_HOME: home });
    const config = await until(async () => {
      try {
        return JSON.parse(await readFile(join(home, "config.json"), "utf8"));
      } catch {
        return false;
      }
    }, "daemon config");
    const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
    const status = async () => {
      try {
        return await (await fetch("http://127.0.0.1:17373/status", { headers })).json();
      } catch {
        return false;
      }
    };
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await worker.evaluate(
      (token) => chrome.storage.local.set({ token, paused: false }),
      config.token,
    );
    await until(async () => (await status())?.extension_connected, "paired extension");
    const call = async (action, args = {}) => {
      const res = await fetch("http://127.0.0.1:17373/command", {
        method: "POST",
        headers,
        body: JSON.stringify({ session: "benchmark", action, args, timeoutMs: 10000 }),
        signal: AbortSignal.timeout(15000),
      });
      const packet = await res.json();
      if (packet.error) throw Error(JSON.stringify(packet.error));
      return packet.result;
    };
    presetCall = call;
    adapter = {
      navigate: (url) => call("navigate", { url, preset: "none" }),
      evaluate: async (code) => (await call("evaluate", { code })).value,
      read: () => call("read_page"),
      snapshot: () => call("snapshot"),
      form: async (value) => {
        await call("fill", { selector: "#name", value });
        return call("click", { selector: "#submit" });
      },
    };
    cleanup = async () => {
      await call("close_session");
      adapter.daemonMemory = (await status()).memory;
    };
  } else if (name === "playwright") {
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    adapter = {
      navigate: (url) => page.goto(url).then(() => ({ url })),
      evaluate: (code) => page.evaluate(code),
      read: () => page.locator("body").innerText(),
      snapshot: () => cdp.send("Accessibility.getFullAXTree"),
      form: async (value) => {
        await page.locator("#name").fill(value);
        await page.locator("#submit").click();
        return { success: true };
      },
    };
  } else if (name === "puppeteer") {
    const require = createRequire(new URL("./tools/package.json", import.meta.url));
    const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    const page = (await browser.pages())[0];
    const cdp = await page.createCDPSession();
    adapter = {
      navigate: (url) => page.goto(url).then(() => ({ url })),
      evaluate: (code) => page.evaluate(code),
      read: () => page.$eval("body", (e) => e.innerText),
      snapshot: () => cdp.send("Accessibility.getFullAXTree"),
      form: async (value) => {
        await page.locator("#name").fill(value);
        await page.click("#submit");
        return { success: true };
      },
    };
    cleanup = () => browser.disconnect();
  } else if (name === "agent-browser") {
    const env = {
      ...process.env,
      AGENT_BROWSER_DEFAULT_TIMEOUT: "10000",
      AGENT_BROWSER_HOME: join(dir, "agent"),
      AGENT_BROWSER_SOCKET_DIR: join(dir, "sockets"),
    };
    const cli = async (...args) => {
      const { stdout } = await exec(
        process.env.AGENT_BROWSER_BIN,
        ["--session", `omw-bench-${process.pid}`, "--json", ...args],
        { env, timeout: 15000, maxBuffer: 4 << 20 },
      );
      const result = JSON.parse(stdout);
      if (result.success === false) throw Error(stdout);
      return result;
    };
    await cli("connect", endpoint);
    adapter = {
      navigate: (url) => cli("open", url),
      evaluate: async (code) => {
        const packet = await cli("eval", code);
        return output(packet.data.result, packet);
      },
      read: () => cli("get", "text", "body"),
      snapshot: () => cli("snapshot"),
      form: async (value) => {
        await cli("fill", "#name", value);
        return cli("click", "#submit");
      },
    };
    cleanup = () => cli("close");
  } else if (
    ["pi-chrome-use", "selenium", "open-browser-use", "chrome-headless-new"].includes(name)
  ) {
    ({ adapter, cleanup } = await extraAdapter(name, {
      ws,
      endpoint,
      dir,
      until,
      launch,
      url,
      onCleanup: (fn) => {
        cleanup = fn;
      },
    }));
  } else {
    const { Client } =
      await import("./tools/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
    const { StdioClientTransport } =
      await import("./tools/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
    const isPW = name === "playwright-mcp";
    const file = isPW
      ? "@playwright/mcp/cli.js"
      : "chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js";
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve("benchmarks/tools/node_modules", file),
        ...(isPW
          ? ["--cdp-endpoint", endpoint]
          : ["--browserUrl", endpoint, "--no-usage-statistics", "--no-performance-crux"]),
      ],
      env: { ...process.env, CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "omw-benchmark", version: "0.1.1" });
    cleanup = () => client.close();
    await client.connect(transport);
    const tools = await client.listTools();
    await writeFile(
      join(process.env.OMW_BENCH_OUTPUT, `${name}-tools.json`),
      JSON.stringify(tools, null, 2),
    );
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 15000,
      });
      if (result.isError) throw Error(text(result));
      return result;
    };
    if (isPW)
      adapter = {
        navigate: (url) => call("browser_navigate", { url }),
        evaluate: async (code) =>
          mcpValue(await call("browser_evaluate", { function: `() => (${code})` }), true),
        read: async () =>
          mcpValue(
            await call("browser_evaluate", { function: "() => document.body.innerText" }),
            true,
          ),
        snapshot: () => call("browser_snapshot"),
        form: async (value) => {
          await call("browser_fill_form", {
            fields: [{ name: "Name", target: "#name", type: "textbox", value }],
          });
          return call("browser_click", { target: "#submit" });
        },
      };
    else {
      const result = await call("new_page", { url, background: true });
      const line = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .split("\n")
        .find((l) => /^\d+:.*\[selected\]/u.test(l));
      const pageId = Number(line?.match(/^(\d+):/u)?.[1]);
      if (!Number.isInteger(pageId)) throw Error(`cannot find page ID: ${text(result)}`);
      let inputUid, buttonUid;
      const snap = () => call("take_snapshot", { pageId });
      adapter = {
        navigate: async (url) => {
          const result = await call("navigate_page", { pageId, url, type: "url", timeout: 10000 });
          const packet = await snap();
          const snapshot = packet.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          inputUid = snapshot.match(/uid=([^\s]+)\s+textbox\s+"Name/u)?.[1];
          buttonUid = snapshot.match(/uid=([^\s]+)\s+button\s+"Record/u)?.[1];
          if (!inputUid || !buttonUid) throw Error(`missing UIDs: ${snapshot.slice(0, 2000)}`);
          return result;
        },
        evaluate: async (code) =>
          mcpValue(
            await call("evaluate_script", {
              pageId,
              function: `() => (${code})`,
              waitForStableDom: false,
            }),
            false,
          ),
        read: async () =>
          mcpValue(
            await call("evaluate_script", {
              pageId,
              function: "() => document.body.innerText",
              waitForStableDom: false,
            }),
            false,
          ),
        snapshot: snap,
        form: async (value) => {
          await call("fill", { pageId, uid: inputUid, value });
          return call("click", { pageId, uid: buttonUid });
        },
      };
    }
    cleanup = () => client.close();
  }
  await adapter.navigate(url);
  const measuredPage = context.pages().find((page) => page.url() === url);
  assert.ok(measuredPage, "adapter must control the isolated Chrome fixture, not another browser");
  await measuredPage.setViewportSize({ width: 1280, height: 720 });
  const identity = crypto.randomUUID();
  await measuredPage.evaluate((id) => {
    globalThis.__omwBenchmarkIdentity = id;
  }, identity);
  assert.equal(observed(await adapter.evaluate("globalThis.__omwBenchmarkIdentity")), identity);
  const coldReadyMs = performance.now() - started;
  const idleRssKiB = await memory();
  await measure(
    "evaluate",
    () => adapter.evaluate(JSON.stringify(marker)),
    (value) => requireMarker(value),
  );
  await measure(
    "read",
    () => adapter.read(),
    (value) => requireMarker(value),
  );
  await measure(
    "form",
    (i) => adapter.form(`form-${i}`),
    async (_, i) => {
      const value = await adapter.evaluate(
        "JSON.stringify({value:document.querySelector('#name').value,result:document.querySelector('#result').textContent,trusted:globalThis.trusted})",
      );
      assert.deepEqual(JSON.parse(observed(value)), {
        value: `form-${i}`,
        result: `form-${i}`,
        trusted: true,
      });
    },
    10,
  );
  await measure(
    "snapshot",
    () => adapter.snapshot(),
    (value) => requireMarker(value),
    5,
  );
  for (const concurrency of [1, 4, 16])
    await measure(
      "concurrent_evaluate",
      () => adapter.evaluate(JSON.stringify(marker)),
      (value) => requireMarker(value),
      64,
      concurrency,
    );
  for (const bytes of [4096, 131072])
    await measure(
      `payload_${bytes}`,
      () => adapter.evaluate(`'x'.repeat(${bytes})+'${marker}'`),
      (value) => {
        const actual = observed(value);
        assert.equal(typeof actual, "string");
        assert.equal(actual.length, bytes + marker.length);
        assert.ok(actual.endsWith(marker));
      },
      5,
    );
  await adapter.navigate(`${url}?dense=1`);
  await measure(
    "dense_snapshot",
    () => adapter.snapshot(),
    (value) => requireMarker(value),
    5,
  );
  await measure(
    "dense_read",
    () => adapter.read(),
    (value) => requireMarker(value),
    5,
  );
  let expectedError = false;
  const errorStart = performance.now();
  try {
    await adapter.evaluate("(()=>{throw Error('intentional benchmark failure')})()");
  } catch {
    expectedError = true;
  }
  const errorRecoveryMs = performance.now() - errorStart;
  requireMarker(await adapter.evaluate(JSON.stringify(marker)));
  if (presetCall) {
    presetResults = [];
    const worker = context.serviceWorkers()[0];
    const observer = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await observer.send("Target.getTargets");
    const target = targetInfos.find((t) => t.type === "service_worker" && t.url === worker.url());
    const heap = await directCDP(ws, target.targetId);
    for (const preset of ["none", "anti-ad", "zen"]) {
      for (let i = 0; i < (process.env.OMW_BENCH_SMOKE === "true" ? 1 : 5); i++) {
        resourceStats.requests = 0;
        resourceStats.bytes = 0;
        const start = performance.now();
        await presetCall("navigate", {
          url: `${url}web2?mode=${preset}&sample=${i}`,
          preset,
          zen: { images: true, fonts: true, css: true, javascript: true },
        });
        presetResults.push({
          preset,
          sample: i,
          loadMs: performance.now() - start,
          ...resourceStats,
          status: await presetCall("preset", { cmd: "status" }),
          workerHeap: await heap.send("Runtime.getHeapUsage"),
        });
      }
    }
    heap.close();
    await observer.detach();
  }
  await cleanup();
  cleanup = async () => {};
  const record = {
    name,
    coldReadyMs,
    idleRssKiB,
    sampledPeakRssKiB: peakRssKiB,
    daemonMemory: adapter.daemonMemory,
    presetResults,
    expectedError,
    errorRecoveryMs,
    samples,
    errors,
  };
  await writeFile(
    join(process.env.OMW_BENCH_OUTPUT, `${name}.json`),
    JSON.stringify(record, null, 2),
  );
  console.log(
    JSON.stringify({
      name,
      coldReadyMs,
      failures: samples.reduce((n, s) => n + s.failures, 0),
      expectedError,
    }),
  );
  if (samples.some((s) => s.failures) || !expectedError) process.exitCode = 1;
} catch (error) {
  await writeFile(
    join(process.env.OMW_BENCH_OUTPUT, `${name}.json`),
    JSON.stringify({ name, error: String(error), samples, errors }, null, 2),
  );
  console.error(`${name}: ${String(error)}`);
  process.exitCode = 1;
} finally {
  await Promise.resolve()
    .then(cleanup)
    .catch((error) => console.error("cleanup", String(error)));
  await Promise.race([
    context?.close().catch((error) => console.error("close benchmark Chrome", String(error))),
    delay(5000),
  ]);
  const { stdout: processes } = await exec("ps", ["-eo", "pid=,args="]);
  for (const line of processes.split("\n"))
    if (line.includes(`--user-data-dir=${join(dir, "chrome")}`)) {
      const pid = Number(line.trim().match(/^\d+/u)?.[0]);
      if (pid)
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") {
            console.error("benchmark cleanup", String(error));
            process.exitCode = 1;
          }
        }
    }
  for (const child of children) child.kill("SIGTERM");
  fixture.close();
  await rm(dir, { recursive: true, force: true });
}

if (name === "pi-chrome-use") process.exit(process.exitCode ?? 0);
