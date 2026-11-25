import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// One fresh worker turn per rollout. Export counters, never prompts or command output.
export async function measure(path, observe) {
  const responses = new Set();
  const calls = new Set();
  const commands = new Set();
  let run, model, effort, completion, turnId, usage;
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    const record = JSON.parse(line);
    observe?.(record);
    const { type, payload } = record;
    if (type === "session_meta") run = payload.agent_path?.split("/").at(-1);
    if (type === "turn_context") {
      assert.ok(!turnId || turnId === payload.turn_id, "Supply a single-turn rollout");
      ({ model, effort, turn_id: turnId } = payload);
    }
    if (type === "token_usage_record") {
      assert.equal(payload.turn_id, turnId);
      assert.ok(payload.response_id, "Usage record needs a response ID");
      responses.add(payload.response_id);
      usage = payload.turn_token_usage;
    }
    if (type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) {
      assert.ok(payload.call_id, "Tool call needs an ID");
      calls.add(payload.call_id);
    }
    if (
      type === "event_msg" &&
      payload.type === "item_completed" &&
      payload.item.type === "CommandExecution"
    ) {
      assert.ok(payload.item.id, "Completed command needs an ID");
      commands.add(payload.item.id);
    }
    if (type === "event_msg" && payload.type === "task_complete") completion = payload;
  }
  assert.ok(run && model && effort && completion && usage && responses.size, path);
  assert.equal(completion.turn_id, turnId);
  assert.equal(usage.total_tokens, usage.input_tokens + usage.output_tokens);
  return {
    run,
    model,
    effort,
    duration_ms: completion.duration_ms,
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    uncached_input_tokens: usage.input_tokens - usage.cached_input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_tokens: usage.reasoning_output_tokens,
    total_tokens: usage.total_tokens,
    model_responses: responses.size,
    tool_calls: calls.size,
    shell_executions: commands.size,
  };
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  assert.ok(paths.length, "Supply one or more completed single-turn Codex rollout files");
  const rows = [];
  for (const path of paths) rows.push(await measure(path));
  console.log(JSON.stringify(rows, null, 2));
}
