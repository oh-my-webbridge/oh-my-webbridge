import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { connect } from "../dist/sdk.mjs";

async function daemon(t, handle) {
  const dir = await mkdtemp(join(tmpdir(), "omw-sdk-"));
  const before = process.env.OMW_HOME;
  process.env.OMW_HOME = dir;
  t.after(async () => {
    if (before === undefined) delete process.env.OMW_HOME;
    else process.env.OMW_HOME = before;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({ address: "127.0.0.1:17373", token: "test" }),
  );
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.headers.authorization, "Bearer test");
    const command = JSON.parse(body);
    if (command.action === "unauthorized") {
      // The daemon answers a rejected token with plain text.
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("authentication required\n");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    handle(command, res);
  });
  server.listen(17373, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
}

test("SDK preserves session, JSON payloads, cancellation and structured errors", async (t) => {
  const commands = [];
  await daemon(t, (command, res) => {
    commands.push(command);
    assert.equal(command.session, "测试-session");
    if (command.action === "fail") {
      res.writeHead(409);
      res.end(JSON.stringify({ error: { code: "stale_ref", message: "take a fresh snapshot" } }));
    } else res.end(JSON.stringify({ result: command.args }));
  });
  const bridge = await connect("测试-session");
  assert.equal(bridge.browser, undefined);
  assert.deepEqual(await bridge.call("echo", { value: 'Avery · "x"\n✓' }), {
    value: 'Avery · "x"\n✓',
  });
  assert.equal("browser" in commands[0], false, "daemon routing decides without a browser");
  await assert.rejects(bridge.call("fail"), {
    code: "stale_ref",
    message: "take a fresh snapshot",
  });
  await assert.rejects(bridge.call("unauthorized"), {
    code: "http_error",
    message: "HTTP 401: authentication required",
  });
  await assert.rejects(bridge.call("echo", {}, { signal: AbortSignal.abort() }));
});

test("SDK sends the selected browser with every command", async (t) => {
  const commands = [];
  await daemon(t, (command, res) => {
    commands.push(command);
    if (command.action === "save_as_pdf") {
      res.writeHead(501);
      res.end(
        JSON.stringify({
          error: { code: "unsupported", message: "save_as_pdf is not available in Firefox" },
        }),
      );
    } else if (command.session === "bound") {
      res.writeHead(409);
      res.end(
        JSON.stringify({
          error: { code: "session_browser", message: "session bound is bound to chrome" },
        }),
      );
    } else res.end(JSON.stringify({ result: { tabId: 1, url: command.args.url ?? "" } }));
  });
  const firefox = await connect("fx", { browser: "firefox" });
  assert.equal(firefox.browser, "firefox");
  await firefox.navigate("https://example.com");
  await firefox.snapshot();
  await firefox.close();
  assert.deepEqual(
    commands.map(({ session, action, browser }) => ({ session, action, browser })),
    [
      { session: "fx", action: "navigate", browser: "firefox" },
      { session: "fx", action: "snapshot", browser: "firefox" },
      { session: "fx", action: "close_session", browser: "firefox" },
    ],
  );
  await assert.rejects(firefox.call("save_as_pdf"), {
    code: "unsupported",
    message: "save_as_pdf is not available in Firefox",
  });
  const chrome = await connect("bound", { browser: "chrome" });
  await assert.rejects(chrome.navigate("https://example.com"), { code: "session_browser" });
  assert.equal(commands.at(-1).browser, "chrome");
  await assert.rejects(connect("fx", { browser: "safari" }), /unsupported browser: safari/u);
});
