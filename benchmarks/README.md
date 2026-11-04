# Browser interface and preset benchmarks

Run from the repository root on an otherwise idle Linux host:

```sh
pnpm install
npm ci --ignore-scripts --prefix benchmarks/tools
pnpm run build
go build -trimpath -ldflags='-s -w' -o dist/omw ./cmd/omw
node benchmarks/prepare.mjs
CHROME_BIN=/absolute/chrome CHROMEDRIVER_BIN=/matching/chromedriver node benchmarks/run.mjs
```

The `checks` workflow downloads current stable Chrome for Testing and pinned agent-browser 0.40.0 with SHA-256 verification. The other tool versions and transitive dependencies are pinned in `tools/package-lock.json`. The measurement packages are development-only and never bundled with the extension or Go daemon.

Every tool uses a fresh isolated Chrome profile and the same fixture, viewport and Chrome binary. Three rounds rotate tool order. JSON includes cold readiness, current RSS, daemon-only memory where available, raw warm latencies, output sizes, failures and recovery. Workloads cover eval, page text, trusted form input, accessibility snapshots, concurrency 1/4/16, 4 KiB/128 KiB results and a 2000-row page. CLI and MCP overhead are deliberately included in their interface measurements.

Cold readiness starts after the common Playwright-based Chrome launcher has been imported. It includes tool-specific setup and later module imports, including Puppeteer and MCP, but excludes that shared launcher import; it is not total command-to-ready startup.

The worker's total RSS includes its own Node process and the Chrome and tool processes it starts. This is sampled current RSS at workload boundaries, not a true peak, not incremental extension memory, and not suitable for comparing daemon-only memory. Summed process RSS may count shared pages more than once, so it is not exclusive physical memory. Shared runner noise, JIT state and short sample counts limit generalization. Raw AX, formatted CLI and MCP snapshots also have different payloads. Do not turn this fixture into a claim about real-site task success, model token cost or a universal speed ranking.

`dist/benchmarks/report.md` summarizes the run and lists the attempts per workload recorded in `results.json`. `results.json` and per-round JSON retain every operation and failure. Each worker's previous result file is removed before it starts, so a worker that exits without writing is reported as failed without older samples. The MCP `tools/list` response is saved with each round so schema changes can be inspected. A failed operation is retained and makes the benchmark check fail. CI uploads all available results even on failure.

Official interfaces: [agent-browser v0.40.0](https://github.com/vercel-labs/agent-browser/tree/v0.40.0), [Playwright](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp), [Puppeteer](https://pptr.dev/api/puppeteer.puppeteer.connect), [Playwright MCP](https://github.com/microsoft/playwright-mcp), [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp). AI planning, cloud providers and full browser products remain qualitative comparisons in `docs/research.md`.

## Expanded matrix

The registry includes the hash-pinned Pi Chrome Use 1.1.1 execution core, Selenium 4.52.0 with a matching ChromeDriver, open-browser-use 0.1.12 (released MCP + native host, explicit CDP backend), and a bare CLI-launched `Chrome --headless=new` using raw CDP. The raw Chrome row still includes the common observer/validator process; it is not Chrome startup in isolation. Pi excludes model/Pi UI; OBU's WebExtension backend is not measured by its CDP row.

The official [ChatGPT Chrome extension used from Codex](https://learn.chatgpt.com/docs/chrome-extension) has an explicit manual row. It needs a supported signed-in client and browser permission prompts; no standalone public API is documented. Record client/extension/model versions, prompt, approvals, elapsed wall time, task success and evidence in a separate end-to-end manual report. Those measurements cannot be mixed into protocol latency. This repository does not inspect or attach a personal signed-in profile.

`prepare.mjs` verifies every upstream payload hash, bundles the unmodified Pi core for Node, and extracts the OBU release into `dist/benchmark-vendors`. It never runs vendor installers. When a downloaded payload does not match its pinned hash, `prepare.mjs` deletes it and records that comparator as unavailable in `provenance.json` with the URL, expected and actual hashes and check time; the other comparators are prepared as usual. Inspect the downloaded artifact and update the pin in a reviewed PR. The OBU SDK is trusted only by its verified module hash, without enabling trust-all. Payloads are excluded from release packages.

Cross-tool oh-my-webbridge measurements select `none`. A separate static archive fixture compares `none`, default anti-ad and aggressive Zen: request count, response bytes, load latency and extension `Runtime.getHeapUsage` (including backing storage) are retained in `presetResults`. Tracker hostnames resolve to the local fixture server, with the Chrome proxy disabled, so the scenario sends no tracking traffic. Network transfer counts include fixture resource bodies, not full protocol bytes.

Use `OMW_BENCH_SMOKE=true OMW_BENCH_ROUNDS=1` for a short check, or `OMW_BENCH_TOOLS=selenium,pi-chrome-use` while debugging adapters. Each record is passed, limited, failed, unavailable or manual. An unavailable comparator is not run; `results.json` keeps one record with its hashes and the report's comparator table shows the reason. A failed record, including a worker that writes no result, fails CI; unavailable and manual records do not. Full runs rotate three fresh-profile rounds weekly and on release tags. Smoke runs take two samples per workload (two sequential requests at concurrency 1, one batch at 4 and 16) and one preset sample per mode; PR smoke samples are for regression detection, not performance conclusions.

OBU 0.1.12 advertises an output schema that omits the emitted `displays_shown` and `displays_total` fields. Its adapter records that mismatch and extends strict validation only for those nonnegative integer counters; raw tools/list schemas remain untouched. It also explicitly raises the documented evaluate result bound to 1 MiB for the 128 KiB workload. Adapter initialization registers cleanup before the first tool call so rejected schemas do not leave a running MCP host.

Known OBU limits are reported as `limited`, separately from failures: concurrent cells can return `kernel is busy`, and its native MCP display/result budget summarizes large values. The adapter does not queue retries or reconstruct truncated payloads. Successful timings for partially rejected concurrency batches are retained in raw data, while the summary marks that throughput as limited. Unexpected errors still fail CI.
