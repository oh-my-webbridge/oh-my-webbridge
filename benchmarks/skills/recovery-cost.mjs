import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { measure } from "./turn-cost.mjs";

function records(path) {
  const contents = readFileSync(path, "utf8").trim();
  return contents ? contents.split("\n").map((line) => JSON.parse(line)) : [];
}

const [log, ...pairs] = process.argv.slice(2);
assert.ok(
  log && pairs.length && pairs.length % 2 === 0,
  "Supply the event log and pairs of run directory and rollout",
);
const events = records(log);
const results = [];
const cues = {
  archive: "Superseded",
  loading: "Preliminary",
  receipt: "Confirmation unavailable",
  unknown: "Confirmation unavailable",
};
for (let i = 0; i < pairs.length; i += 2) {
  const directory = pairs[i];
  const run = basename(directory);
  const visits = events.filter((event) => event.run === run);
  const scenario = visits[0]?.scenario;
  const fault = visits.find((event) => event.event === "fault");
  const evidence = visits.find((event) => ["evidence", "unavailable"].includes(event.event));
  const commandLog = join(directory, "commands.jsonl");
  const commands = existsSync(commandLog) ? records(commandLog) : [];
  let start, firstFault, firstEvidence, finish, answer;
  let tokens = 0;
  const calls = new Set();
  const turn = await measure(pairs[i + 1], ({ timestamp, type, payload }) => {
    const at = Date.parse(timestamp);
    if (type === "event_msg" && payload.type === "task_started") start = at;
    if (type === "token_usage_record") tokens = payload.turn_token_usage.total_tokens;
    if (type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type))
      calls.add(payload.call_id);
    const checkpoint = () => ({
      at_ms: at - start,
      total_tokens: tokens,
      tool_calls: calls.size,
      cli_calls: commands.filter((command) => command.end <= at).length,
    });
    if (
      type === "response_item" &&
      ["function_call_output", "custom_tool_call_output"].includes(payload.type)
    ) {
      const content = JSON.stringify(payload.output);
      if (!firstFault && fault && at >= fault.at && content.includes(cues[scenario]))
        firstFault = checkpoint();
      if (!firstEvidence && evidence && at >= evidence.at) {
        const found =
          evidence.event === "unavailable"
            ? content.includes("Request history unavailable")
            : content.includes(evidence.reference) &&
              (!evidence.amount || content.includes(evidence.amount));
        if (found) firstEvidence = checkpoint();
      }
    }
    if (type === "event_msg" && payload.type === "task_complete") {
      finish = checkpoint();
      answer = payload.last_agent_message;
    }
  });
  const digest = createHash("sha256")
    .update(readFileSync(join(directory, "skill/SKILL.md")))
    .digest("hex");
  results.push({
    ...turn,
    session: run,
    scenario,
    guide_sha256: digest,
    cli_calls: commands.length,
    cli_errors: commands.filter((command) => command.status !== 0).length,
    actions: commands.map((command) => command.steps ?? command.action ?? command.command),
    server_events: visits.map((visit) => visit.event),
    writes: visits.filter((visit) => visit.event === "write").length,
    checkpoints: {
      fault_visible: firstFault ?? null,
      evidence_visible: firstEvidence ?? null,
      answer: finish,
    },
    answer_contains_evidence: evidence?.reference
      ? answer.includes(evidence.reference) &&
        (!evidence.amount || answer.includes(evidence.amount))
      : null,
  });
}
console.log(JSON.stringify(results, null, 2));
