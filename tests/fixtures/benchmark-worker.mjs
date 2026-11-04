// Stand-in for benchmarks/worker.mjs. Tools listed in OMW_FAKE_WORKER_CRASH
// exit before writing a result; others write a smoke-sized result.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const name = process.argv[2];
if (process.env.OMW_FAKE_WORKER_CRASH?.split(",").includes(name)) process.exit(1);
const sample = (workload, attempts, concurrency = 1) => ({
  workload,
  concurrency,
  attempts,
  failures: 0,
  unsupported: 0,
  wallMs: attempts * 3,
  p50Ms: 3,
  p95Ms: 3,
  operationsPerSecond: 333,
  meanOutputBytes: 10,
  latenciesMs: Array.from({ length: attempts }, () => 3),
});
await writeFile(
  join(process.env.OMW_BENCH_OUTPUT, `${name}.json`),
  JSON.stringify({
    name,
    coldReadyMs: 5,
    idleRssKiB: 1024,
    sampledPeakRssKiB: 2048,
    expectedError: true,
    samples: [sample("evaluate", 2), sample("concurrent_evaluate", 16, 16)],
    errors: [],
  }),
);
