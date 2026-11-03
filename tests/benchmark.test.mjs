import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpValue, observed, output } from "../benchmarks/results.mjs";
const packet = (text) => ({ content: [{ type: "text", text }] });
test("benchmark reads MCP result sections, excluding echoed source code", () => {
  const pw = packet(
    '### Result\n"actual"\n### Ran Playwright code\n```js\n// expected-marker\n```',
  );
  const devtools = packet('Script ran on page and returned:\n```json\n{"value":"actual"}\n```');
  assert.equal(observed(mcpValue(pw, true)), "actual");
  assert.deepEqual(observed(mcpValue(devtools, false)), { value: "actual" });
  assert.equal(mcpValue(pw, true).wireBytes, Buffer.byteLength(JSON.stringify(pw)));
  assert.throws(
    () => mcpValue(packet("### Ran Playwright code\nexpected-marker"), true),
    /no result section/,
  );
  assert.throws(
    () => mcpValue(packet("Script failed: expected-marker"), false),
    /no result section/,
  );
});
test("benchmark keeps result types and payload length separate from wire metadata", () => {
  const data = "x".repeat(131072) + "marker";
  assert.equal(observed(output(data, { result: data })).length, 131078);
  assert.equal(observed(output(false, { expected: true })), false);
  assert.equal(observed(output(null, { result: "echoed" })), null);
  assert.equal(observed("plain"), "plain");
});

test("OBU schema compatibility admits only the two observed integer counters", async () => {
  const { obuOutputSchema } = await import("../benchmarks/compat.mjs");
  const original = {
    type: "object",
    additionalProperties: false,
    properties: { displays: { type: "array" }, duration_ms: { type: "integer" }, error_detail: {} },
    required: ["displays", "duration_ms"],
  };
  const normalized = obuOutputSchema(original);
  assert.equal(normalized.additionalProperties, false);
  assert.deepEqual(normalized.required, original.required);
  assert.equal(original.properties.displays_total, undefined);
  assert.deepEqual(normalized.properties.displays_total, { type: "integer", minimum: 0 });
  assert.deepEqual(Object.keys(normalized.properties).sort(), [
    "displays",
    "displays_shown",
    "displays_total",
    "duration_ms",
    "error_detail",
  ]);
  const other = { type: "object", properties: { result: {} } };
  assert.equal(obuOutputSchema(other), other);
});

async function benchmarkFixture(t, prefix, files) {
  const { cp, mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = async (file, data) => {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), data);
  };
  for (const file of files) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await cp(file, join(dir, file));
  }
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const run = (args, extra = {}) =>
    promisify(execFile)(process.execPath, args, { cwd: dir, env: { ...env, ...extra } }).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
  return { dir, write, run, env };
}

// benchmarks/run.mjs with tests/fixtures/benchmark-worker.mjs, which writes a
// smoke-sized result or exits early for tools in OMW_FAKE_WORKER_CRASH.
async function runBenchmarks(t, prefix, { tools, crash = "", unavailable = [], previous }) {
  const { chmod, cp, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { dir, write, run, env } = await benchmarkFixture(t, prefix, [
    "benchmarks/run.mjs",
    "benchmarks/registry.mjs",
    "benchmarks/tools/package.json",
  ]);
  await cp("tests/fixtures/benchmark-worker.mjs", join(dir, "benchmarks/worker.mjs"));
  await write(
    "dist/benchmark-vendors/provenance.json",
    JSON.stringify({ artifacts: [], unavailable }),
  );
  await write("chrome", "#!/bin/sh\necho 'Chrome for Testing fixture'\n");
  await chmod(join(dir, "chrome"), 0o755);
  for (const args of [
    ["init", "-b", "main"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ])
    await promisify(execFile)("git", args, { cwd: dir, env });
  if (previous) await write(previous.file, JSON.stringify(previous.result));
  const result = await run(["benchmarks/run.mjs"], {
    CHROME_BIN: join(dir, "chrome"),
    OMW_BENCH_TOOLS: tools,
    OMW_BENCH_ROUNDS: "1",
    OMW_FAKE_WORKER_CRASH: crash,
  });
  return {
    ...result,
    dir,
    report: await readFile(join(dir, "dist/benchmarks/report.md"), "utf8"),
    records: JSON.parse(await readFile(join(dir, "dist/benchmarks/results.json"), "utf8")).records,
  };
}

const changedObu = [
  {
    tool: "open-browser-use",
    artifact: "obu.tar.gz",
    url: "https://github.com/open-browser-use/open-browser-use/releases/download/v0.1.12/open-browser-use-0.1.12-linux-x64-gnu.tar.gz",
    expectedSha256: "a".repeat(64),
    actualSha256: "b".repeat(64),
    checkedAt: "2026-11-02T16:20:58.000Z",
  },
];

test("benchmark summary uses recorded attempts and never reuses an earlier result", async (t) => {
  const result = await runBenchmarks(t, "omw-bench-run-", {
    tools: "playwright,puppeteer",
    crash: "puppeteer",
    // A result left by an earlier run for the tool whose worker now exits early.
    previous: {
      file: "dist/benchmarks/round-1/puppeteer.json",
      result: {
        name: "puppeteer",
        coldReadyMs: 111,
        expectedError: true,
        samples: [{ workload: "evaluate", concurrency: 1, attempts: 20, failures: 0, p50Ms: 1.23 }],
      },
    },
  });
  assert.equal(result.code, 1, "a worker without results fails the run");
  const crashed = result.records.find((r) => r.name === "puppeteer");
  assert.equal(crashed.status, "failed");
  assert.equal(crashed.error, "worker did not write results");
  assert.equal(crashed.samples, undefined);
  assert.match(result.report, /^\| puppeteer \| failed \| failed \| failed \| failed \|/mu);
  assert.match(
    result.report,
    /Attempts per tool and round recorded in results\.json: evaluate 2, concurrent_evaluate c16 16\./u,
  );
  assert.doesNotMatch(result.report, /20 eval\/read|64 requests/u);
});

test("comparators with changed upstream payloads are reported unavailable without failing", async (t) => {
  const { access } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const result = await runBenchmarks(t, "omw-bench-unavailable-", {
    tools: "playwright,open-browser-use",
    unavailable: changedObu,
  });
  assert.equal(result.code, 0, result.stderr);
  const obu = result.records.filter((r) => r.name === "open-browser-use");
  assert.equal(obu.length, 1);
  assert.equal(obu[0].status, "unavailable");
  assert.deepEqual(obu[0].unavailableArtifacts, changedObu);
  assert.match(
    obu[0].reason,
    /obu\.tar\.gz at \S+ changed upstream \(expected sha256 a{64}, got b{64}/u,
  );
  assert.equal(result.records.find((r) => r.name === "playwright").status, "passed");
  await assert.rejects(access(join(result.dir, "dist/benchmarks/round-1/open-browser-use.json")));
  assert.match(result.report, /^\| open-browser-use \| [^|]+ \| unavailable: obu\.tar\.gz at /mu);
  assert.doesNotMatch(result.report, /^\| open-browser-use \| [\d.]+ \|/mu);
});

test("benchmark preparation records changed upstream payloads instead of stopping", async (t) => {
  const { access, chmod, cp, readFile } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");
  const { symlink } = await import("node:fs/promises");
  const { dir, write, run } = await benchmarkFixture(t, "omw-bench-prepare-", [
    "benchmarks/prepare.mjs",
  ]);
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
  const pi = "benchmarks/tools/node_modules/pi-chrome-use/src";
  await write(`${pi}/browser-execute.ts`, "export const executeBrowserCode = () => undefined;\n");
  await write(`${pi}/session-store.ts`, "export const SessionStore = {};\n");
  await cp("tests/fixtures/fake-curl.sh", join(dir, "curl"));
  await chmod(join(dir, "curl"), 0o755);
  const result = await run(["benchmarks/prepare.mjs"], { PATH: `${dir}:${process.env.PATH}` });
  assert.equal(result.code, 0, result.stderr);
  const vendors = join(dir, "dist/benchmark-vendors");
  const provenance = JSON.parse(await readFile(join(vendors, "provenance.json"), "utf8"));
  assert.deepEqual(
    provenance.unavailable.map((u) => [u.tool, u.artifact]),
    [
      ["agent-browser", "agent-browser"],
      ["open-browser-use", "obu.tar.gz"],
    ],
  );
  for (const u of provenance.unavailable) {
    const pinned = provenance.artifacts.find((a) => a.id === u.artifact);
    assert.equal(u.url, pinned.url);
    assert.equal(u.expectedSha256, pinned.sha256);
    assert.notEqual(u.actualSha256, pinned.sha256);
    assert.ok(!Number.isNaN(Date.parse(u.checkedAt)));
    await assert.rejects(access(join(vendors, u.artifact)), `${u.artifact} is removed`);
  }
  await assert.rejects(access(join(vendors, "obu")));
  await access(join(vendors, "pi.mjs"));
  assert.match(result.stdout, /open-browser-use unavailable: obu\.tar\.gz changed upstream/u);
});
