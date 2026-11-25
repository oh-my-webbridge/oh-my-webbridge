#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

// Copy this executable to RUN/omw. Keep the real CLI on PATH.
const args = process.argv.slice(2);
const directory = dirname(process.argv[1]);
let action;
let batchPayload, input;
if (args[0] === "call") {
  const { positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    options: { browser: { type: "string" }, "timeout-ms": { type: "string" } },
  });
  const [session, name, payload] = positionals;
  if (session !== basename(directory)) throw Error("Use the assigned benchmark session");
  action = name;
  if (action === "batch" && payload) {
    if (payload === "-") input = readFileSync(0);
    batchPayload = input?.toString("utf8") ?? payload;
  }
} else if (!["doctor", "status", "help", "version"].includes(args[0])) {
  throw Error("Use a session call or a read-only diagnostic");
}
const start = Date.now();
const reply = spawnSync("omw", args, {
  input,
  stdio: [input ? "pipe" : "inherit", "inherit", "inherit"],
});
const end = Date.now();
let steps;
if (batchPayload) {
  try {
    const request = JSON.parse(batchPayload);
    if (Array.isArray(request?.steps)) steps = request.steps.map((step) => step?.action);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // The CLI has already reported the malformed request. Count the invocation.
  }
}
appendFileSync(
  join(directory, "commands.jsonl"),
  JSON.stringify({
    command: args[0],
    action,
    steps,
    start,
    end,
    status: reply.status,
  }) + "\n",
);
if (reply.error) throw reply.error;
process.exitCode = reply.status ?? 1;
