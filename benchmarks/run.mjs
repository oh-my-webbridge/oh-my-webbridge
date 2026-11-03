import { registry } from "./registry.mjs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
const exec = promisify(execFile);
const output = resolve(process.env.OMW_BENCH_OUTPUT ?? "dist/benchmarks");
await mkdir(output, { recursive: true });
const selected = process.env.OMW_BENCH_TOOLS?.split(",");
const tools = registry
  .filter((t) => t.automatic && (!selected || selected.includes(t.name)))
  .map((t) => t.name);
if (selected?.some((n) => !registry.some((t) => t.name === n && t.automatic)))
  throw Error("unknown automatic comparator");
const rounds = Number(process.env.OMW_BENCH_ROUNDS ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw Error("rounds must be 1-10");
if (!process.env.CHROME_BIN) throw Error("CHROME_BIN and AGENT_BROWSER_BIN are required");
process.env.AGENT_BROWSER_BIN ??= resolve("dist/benchmark-vendors/agent-browser");
const vendors = JSON.parse(await readFile("dist/benchmark-vendors/provenance.json", "utf8"));
// prepare.mjs drops upstream payloads whose pinned hash changed. Those
// comparators keep one unavailable record with the hashes instead of a run.
const unavailable = (tool) => vendors.unavailable.filter((u) => u.tool === tool);
const measured = tools.filter((tool) => !unavailable(tool).length);
const records = [
  ...registry.filter((t) => !t.automatic).map((t) => ({ ...t, status: "manual", exitCode: 0 })),
  ...tools
    .filter((tool) => unavailable(tool).length)
    .map((tool) => ({
      ...registry.find((t) => t.name === tool),
      status: "unavailable",
      exitCode: null,
      reason: unavailable(tool)
        .map(
          (u) =>
            `${u.artifact} at ${u.url} changed upstream (expected sha256 ${u.expectedSha256}, got ${u.actualSha256} at ${u.checkedAt}); review and repin`,
        )
        .join("; "),
      unavailableArtifacts: unavailable(tool),
    })),
];
for (let round = 0; round < rounds; round++) {
  // Rotate order to reduce systematic first/last-tool bias on a shared runner.
  const order = measured.slice(round).concat(measured.slice(0, round));
  const directory = join(output, `round-${round + 1}`);
  await mkdir(directory, { recursive: true });
  for (const tool of order) {
    // A worker that exits before writing must not inherit an earlier run's result.
    await rm(join(directory, `${tool}.json`), { force: true });
    const code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, ["benchmarks/worker.mjs", tool], {
        env: { ...process.env, OMW_BENCH_OUTPUT: directory },
        stdio: "inherit",
      });
      let killer;
      const deadline = setTimeout(() => {
        child.kill("SIGTERM");
        killer = setTimeout(() => child.kill("SIGKILL"), 20000);
      }, 240000);
      child.on("error", (error) => {
        clearTimeout(deadline);
        clearTimeout(killer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(deadline);
        clearTimeout(killer);
        done(code);
      });
    });
    let result;
    try {
      result = JSON.parse(await readFile(join(directory, `${tool}.json`), "utf8"));
    } catch {
      result = { name: tool, error: "worker did not write results" };
    }
    records.push({
      round: round + 1,
      exitCode: code,
      status:
        code === 0 &&
        !result.error &&
        result.expectedError === true &&
        result.samples?.length > 0 &&
        result.samples.every((s) => s.failures === 0)
          ? result.samples.some((s) => s.unsupported > 0)
            ? "limited"
            : "passed"
          : "failed",
      ...result,
    });
    await writeFile(
      join(output, "progress.json"),
      JSON.stringify({ round: round + 1, completed: records }, null, 2),
    );
  }
}
const metadata = {
  date: new Date().toISOString(),
  commit: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
  node: process.version,
  os: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  totalMemoryBytes: totalmem(),
  chrome: (await exec(process.env.CHROME_BIN, ["--version"])).stdout.trim(),
  versions: JSON.parse(await readFile("benchmarks/tools/package.json", "utf8")).dependencies,
  agentBrowser: "0.40.0",
  rounds,
  registry,
  vendorArtifacts: vendors,
};
await writeFile(join(output, "results.json"), JSON.stringify({ metadata, records }, null, 2));
const median = (a) => (a.length ? [...a].sort((a, b) => a - b)[Math.floor(a.length / 2)] : null);
const attempts = new Map();
for (const s of records.flatMap((r) => r.samples ?? [])) {
  const key =
    s.workload === "concurrent_evaluate" ? `concurrent_evaluate c${s.concurrency}` : s.workload;
  attempts.set(key, new Set([...(attempts.get(key) ?? []), s.attempts]));
}
const attemptSummary = [...attempts]
  .map(([key, counts]) => `${key} ${[...counts].sort((a, b) => a - b).join("/")}`)
  .join(", ");
const number = (v) => (v == null ? "failed" : v.toFixed(2));
const lines = [
  "# Browser tooling benchmark",
  "",
  `Measured ${metadata.date}; commit ${metadata.commit}; ${metadata.chrome}.`,
  "",
  `Platform: ${metadata.os}; ${metadata.cpu}; ${metadata.logicalCpus} logical CPUs. ${rounds} fresh-browser rounds; rotated tool order.`,
  "",
  "| Tool | Cold ready ms | Idle total MiB | Sampled peak total MiB | Eval p50 ms | Form p50 ms | Snapshot p50 ms | c16 eval req/s | Failures | Limits |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
];
for (const tool of measured) {
  const r = records.filter((r) => r.name === tool);
  const metric = (work, key, concurrency) =>
    median(
      r
        .flatMap((r) => r.samples ?? [])
        .filter((s) => s.workload === work && (!concurrency || s.concurrency === concurrency))
        .map((s) => s[key])
        .filter((v) => v != null),
    );
  const failures = r.reduce(
    (n, r) =>
      n +
      (r.error || r.exitCode !== 0 ? 1 : 0) +
      (r.samples ?? []).reduce((n, s) => n + s.failures, 0) +
      (r.expectedError === false ? 1 : 0),
    0,
  );
  const limits = r.reduce(
    (n, r) => n + (r.samples ?? []).reduce((n, s) => n + (s.unsupported ?? 0), 0),
    0,
  );
  const c16Limited = r.some((r) =>
    (r.samples ?? []).some(
      (s) => s.workload === "concurrent_evaluate" && s.concurrency === 16 && s.unsupported > 0,
    ),
  );
  lines.push(
    `| ${tool} | ${number(median(r.map((r) => r.coldReadyMs).filter((v) => v != null)))} | ${number(median(r.map((r) => r.idleRssKiB / 1024).filter(Number.isFinite)))} | ${number(median(r.map((r) => r.sampledPeakRssKiB / 1024).filter(Number.isFinite)))} | ${number(metric("evaluate", "p50Ms"))} | ${number(metric("form", "p50Ms"))} | ${number(metric("snapshot", "p50Ms"))} | ${c16Limited ? "limited" : number(metric("concurrent_evaluate", "operationsPerSecond", 16))} | ${failures} | ${limits} |`,
  );
}
lines.push(
  "",
  "| Comparator | Interface | Status |",
  "| --- | --- | --- |",
  ...registry.map(
    (t) =>
      `| ${t.name} | ${t.interface} | ${
        !t.automatic
          ? `manual: ${t.reason}`
          : !tools.includes(t.name)
            ? "not selected"
            : measured.includes(t.name)
              ? records
                  .filter((r) => r.name === t.name)
                  .map((r) => r.status)
                  .join(" / ")
              : `unavailable: ${records.find((r) => r.name === t.name).reason}`
      } |`,
  ),
);
const presetRows = records
  .filter((r) => r.name === "oh-my-webbridge")
  .flatMap((r) => r.presetResults ?? []);
if (presetRows.length) {
  lines.push(
    "",
    "## Static archive resource scenario",
    "",
    "| Preset | Load p50 ms | Resource requests | Response bodies KiB | V8 used MiB | Backing storage MiB |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const preset of ["none", "anti-ad", "zen"]) {
    const rows = presetRows.filter((r) => r.preset === preset);
    const metric = (f) => median(rows.map(f).filter(Number.isFinite));
    lines.push(
      `| ${preset} | ${number(metric((r) => r.loadMs))} | ${number(metric((r) => r.requests))} | ${number(metric((r) => r.bytes / 1024))} | ${number(metric((r) => r.workerHeap?.usedSize / 1048576))} | ${number(metric((r) => r.workerHeap?.backingStorageSize / 1048576))} |`,
    );
  }
  lines.push(
    "",
    "The preset scenario is measured after cross-tool workloads in one OMW process. It is a local, cache-busted static page with 16 images, a font preload, CSS and two scripts. Tracker names resolve to the local server. V8 heap/backing storage are current samples without forced GC; mode order can retain previous engine allocations until collection. Response counts/bytes are fixture resource bodies, not complete wire traffic. Zen blocks all four resource classes in this scenario.",
  );
}
lines.push(
  "",
  "Cold ready includes isolated Chrome launch, tool-specific initialization and first navigation. The common Playwright module is imported before the timer; later Puppeteer/MCP imports are included. The raw Chrome row launches --headless=new through the Chrome CLI, then connects a common Playwright observer for fixture identity checks. Pi uses the unmodified execution core, without model/Pi UI overhead; OBU uses its released MCP/native host with explicit CDP backend. OMW uses preset none for the cross-tool comparison. Downloads, npm install and Node bootstrap are excluded. This is not total command-to-ready startup.",
  "",
  "Total RSS includes the measurement Node worker, Chrome processes and newly created tool processes on this otherwise idle runner. It is sampled at workload boundaries, so it is neither an OS high-water mark nor daemon-only memory. Summed RSS can count shared pages multiple times and is not exclusive physical memory. OMW daemon heap and cumulative peak RSS are separately recorded in each OMW JSON file.",
  "",
  `Attempts per tool and round recorded in results.json: ${attemptSummary || "none"}. Concurrent reads share one page. Form timings include fill and trusted click; verification runs outside individual latency timers but inside throughput wall time. CDP snapshots for direct libraries are raw AX output; CLI/MCP snapshots include their own formatting. Output bytes are recorded, not treated as token counts.`,
  "",
  "MCP tools may attach snapshots/code to action responses. Agent-browser includes per-command process and socket overhead. These are interface measurements, not isolated engine rankings. Reference acquisition is done during initial DevTools MCP navigation and is included in cold-ready, rather than repeated for each form.",
  "",
  "Read the raw latency arrays, error messages, 4 KiB/128 KiB payload and 2000-row workloads in results.json. A failed or unsupported operation is retained; successful timing alone does not imply feature parity. This is a deterministic local fixture, not a real-site reliability benchmark.",
);
await writeFile(join(output, "report.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
if (records.some((r) => r.status === "failed")) process.exitCode = 1;
