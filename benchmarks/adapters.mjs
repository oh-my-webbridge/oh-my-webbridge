import { obuOutputSchema } from "./compat.mjs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { output } from "./results.mjs";
const require = createRequire(new URL("./tools/package.json", import.meta.url));
export async function directCDP(ws, targetId) {
  const socket = new WebSocket(ws);
  await new Promise((ok, no) => {
    socket.onopen = ok;
    socket.onerror = no;
  });
  let next = 0;
  const pending = new Map();
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    }
  };
  socket.onclose = () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("CDP closed"));
    }
    pending.clear();
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`CDP timeout: ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetInfos } = await call("Target.getTargets");
  const target = targetInfos.find((t) => (targetId ? t.targetId === targetId : t.type === "page"));
  if (!target) throw Error("no fixture page target");
  const { sessionId } = await call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  return { send: (m, p) => call(m, p, sessionId), close: () => socket.close() };
}
async function cdpActions(send, until) {
  const evaluate = async (code) => {
    const r = await send("Runtime.evaluate", {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  return {
    navigate: async (url) => {
      await send("Page.navigate", { url });
      await until(
        async () =>
          (await evaluate("location.href")) === url &&
          (await evaluate("document.readyState")) === "complete",
        "navigation",
      );
      return { url };
    },
    evaluate,
    read: () => evaluate("document.body.innerText"),
    snapshot: () => send("Accessibility.getFullAXTree"),
    form: async (value) => {
      await evaluate(`(()=>{const e=document.querySelector('#name');e.focus();e.select()})()`);
      await send("Input.insertText", { text: value });
      const p = await evaluate(
        `(()=>{const r=document.querySelector('#submit').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...p,
        button: "left",
        clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...p,
        button: "left",
        clickCount: 1,
      });
      return { success: true };
    },
  };
}
export async function extraAdapter(name, { ws, endpoint, dir, until, launch, url, onCleanup }) {
  const root = resolve("dist/benchmark-vendors");
  if (name === "chrome-headless-new") {
    const cdp = await directCDP(ws);
    return { adapter: await cdpActions(cdp.send, until), cleanup: cdp.close };
  }
  if (name === "pi-chrome-use") {
    const { executeBrowserCode, SessionStore } = await import(pathToFileURL(join(root, "pi.mjs")));
    const sessionID = `bench-${process.pid}`;
    const ctx = { sessionID, workspaceDir: dir };
    const invoke = async (code) => {
      const r = await executeBrowserCode(
        { code, description: "deterministic local benchmark", timeout: 15000 },
        ctx,
      );
      return output(JSON.parse(r.result), r);
    };
    await invoke(
      `await session.connect({wsUrl:${JSON.stringify(ws)}});const {targetInfos}=await session._call('Target.getTargets',{});await session.use(targetInfos.find(t=>t.type==='page').targetId);return true`,
    );
    const send = async (method, params = {}) => {
      const r = await invoke(
        `return await session._call(${JSON.stringify(method)},${JSON.stringify(params)})`,
      );
      return r.benchmarkValue;
    };
    // Keep the upstream execution wrapper in every measured operation.
    onCleanup(() => SessionStore.evict(sessionID));
    const actions = await cdpActions(send, until);
    return { adapter: actions, cleanup: () => SessionStore.evict(sessionID) };
  }
  if (name === "selenium") {
    const { Builder } = require("selenium-webdriver");
    const chrome = require("selenium-webdriver/chrome");
    const driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(new chrome.Options().debuggerAddress(new URL(endpoint).host))
      .setChromeService(new chrome.ServiceBuilder(process.env.CHROMEDRIVER_BIN))
      .build();
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 10000, script: 10000 });
    return {
      adapter: {
        navigate: (url) => driver.get(url),
        evaluate: (code) => driver.executeScript(`return (${code})`),
        read: () => driver.findElement({ css: "body" }).getText(),
        snapshot: () => driver.sendAndGetDevToolsCommand("Accessibility.getFullAXTree", {}),
        form: async (value) => {
          const input = await driver.findElement({ css: "#name" });
          await input.clear();
          await input.sendKeys(value);
          await driver.findElement({ css: "#submit" }).click();
          return { success: true };
        },
      },
      cleanup: () => driver.quit(),
    };
  }
  if (name === "open-browser-use") {
    const { Client } =
      await import("./tools/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
    const { StdioClientTransport } =
      await import("./tools/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
    const obu = join(root, "obu");
    const runtime = join(dir, "runtime");
    await mkdir(runtime, { mode: 0o700, recursive: true });
    const socket = join(runtime, "host.sock");
    launch(
      join(obu, "bin/obu-host"),
      ["--socket", socket, "--cdp-url", endpoint, "--session-id", `benchmark-${process.pid}`],
      { ...process.env, OBU_RUNTIME_DIR: runtime },
    );
    await until(async () => {
      try {
        return (await stat(socket)).isSocket();
      } catch {
        return false;
      }
    }, "OBU host socket");

    const transport = new StdioClientTransport({
      command: join(obu, "bin/obu-node-repl"),
      args: ["--working-dir", obu, "mcp", "stdio"],
      env: {
        ...process.env,
        PATH: `${obu}:${join(obu, "bin")}:${process.env.PATH}`,
        HOME: join(dir, "obu-home"),
        XDG_RUNTIME_DIR: join(dir, "runtime"),
        OBU_NODE_BINARY: join(obu, "node/bin/node"),
        OBU_TRUSTED_MODULE_SHA256S:
          "6bc9be41e6d085d500bd6b13e757b5c7bee21cd7078553d8b2c89f2f07a67ed5",
        OBU_RUNTIME_DIR: runtime,
        OBU_BACKENDS: `cdp:cdp:${socket}`,
        OBU_CDP_URL: endpoint,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const { AjvJsonSchemaValidator } =
      await import("./tools/node_modules/@modelcontextprotocol/sdk/dist/esm/validation/ajv-provider.js");
    const validator = new AjvJsonSchemaValidator();
    const client = new Client(
      { name: "omw-benchmark", version: "1" },
      {
        jsonSchemaValidator: {
          getValidator: (schema) => validator.getValidator(obuOutputSchema(schema)),
        },
      },
    );
    onCleanup(() => client.close());
    await client.connect(transport);
    await writeFile(
      join(process.env.OMW_BENCH_OUTPUT, "open-browser-use-tools.json"),
      JSON.stringify(await client.listTools(), null, 2),
    );
    await writeFile(
      join(process.env.OMW_BENCH_OUTPUT, "open-browser-use-schema-compat.json"),
      JSON.stringify(
        {
          version: "0.1.12",
          allowedAdditionalOutputFields: ["displays_shown", "displays_total"],
          validation: "strict; nonnegative integer counters only",
        },
        null,
        2,
      ),
    );
    const invoke = async (source) => {
      const r = await client.callTool(
        { name: "js", arguments: { source, timeout_ms: 12000 } },
        undefined,
        { timeout: 15000 },
      );
      if (r.isError) throw Error(JSON.stringify(r));
      const data = r.structuredContent;
      if (data?.truncated?.displays || data?.truncated?.result)
        throw Object.assign(Error("OBU output exceeds its native MCP result/display budget"), {
          benchmarkLimit: "output_budget",
        });
      const displays = data?.displays ?? [];
      const value = displays.at(-1)?.value ?? data?.result;
      return output(value, r);
    };
    const call = async (source) => {
      try {
        return await invoke(source);
      } catch (error) {
        if (error.code === -32603 && error.message.includes("kernel is busy"))
          throw Object.assign(Error("OBU rejects concurrent cells in one persistent kernel"), {
            benchmarkLimit: "single_kernel",
          });
        throw error;
      }
    };
    await call(
      `globalThis.browser=await agent.browsers.get('cdp');globalThis.tab=await browser.tabs.create(${JSON.stringify(url)});await tab.attach();display(true)`,
    );
    return {
      adapter: {
        navigate: (url) => call(`await tab.goto(${JSON.stringify(url)});display(true)`),
        evaluate: (code) =>
          call(`display(await tab.evaluate(${JSON.stringify(code)},{maxJsonBytes:1048576}))`),
        read: () => call(`display(await tab.locator('body').innerText())`),
        snapshot: () => call("display(await tab.domSnapshot())"),
        form: (value) =>
          call(
            `await tab.locator('#name').fill(${JSON.stringify(value)});await tab.locator('#submit').click();display(true)`,
          ),
      },
      cleanup: () => client.close(),
    };
  }
  throw Error(`no adapter: ${name}`);
}
