// Stand-in for scripts/update-filters.mjs: records a new pinned snapshot dated
// FAKE_FILTER_SNAPSHOT without downloading filter sources.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const path = "third_party/filters/sources.lock.json";
const lock = JSON.parse(await readFile(path, "utf8"));
lock.updated = process.env.FAKE_FILTER_SNAPSHOT;
lock.sources[0].sha256 = createHash("sha256").update(lock.updated).digest("hex");
await writeFile(path, JSON.stringify(lock, null, 2) + "\n");
