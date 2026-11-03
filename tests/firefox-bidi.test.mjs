import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { startFirefox } from "../scripts/firefox-bidi.mjs";
import { until } from "./fixtures/e2e-bridge.mjs";

test("a BiDi reply that arrives after its command timed out is ignored", async (t) => {
  // Cleanup runs in reverse order, so the browser stops before its directory goes.
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step();
  });
  const dir = await mkdtemp(join(tmpdir(), "omw-bidi-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  // FIREFOX_BIN runs tests/fixtures/fake-firefox.mjs with this Node.
  const binary = join(dir, "firefox");
  await writeFile(
    binary,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("tests/fixtures/fake-firefox.mjs"))} "$@"\n`,
  );
  await chmod(binary, 0o755);
  const previous = process.env.FIREFOX_BIN;
  process.env.FIREFOX_BIN = binary;
  cleanup.push(() => {
    process.env.FIREFOX_BIN = previous;
  });
  const firefox = await startFirefox({ dir });
  cleanup.push(() => firefox.close());
  assert.equal(firefox.version, "0.0-fake");

  await assert.rejects(
    firefox.send("slow", { delayMs: 300 }, 100),
    /BiDi slow timed out after 100 ms/u,
  );
  await until(
    () => firefox.output().includes("ignored BiDi success for command 2"),
    "late reply recorded",
  );
  // Replies and errors after the late one still reach their commands.
  assert.deepEqual(await firefox.send("echo", { n: 1 }, 2000), { n: 1 });
  await assert.rejects(firefox.send("missing", {}, 2000), /BiDi missing: unknown command/u);
  assert.equal(await firefox.close(), "browser.close succeeded");
});
