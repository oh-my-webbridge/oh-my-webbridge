import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Use a fresh receipt scenario on the local recovery fixture.
const [port, session, log] = process.argv.slice(2);
assert.ok(/^\d+$/.test(port) && /^[a-z0-9-]+$/.test(session) && log);
const events = () =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.run === session);
assert.equal(events().length, 0, "Use a fresh fixture session");
function call(action, args, error) {
  const deadline = error === "wait_timeout" ? ["--timeout-ms", "4000"] : [];
  const reply = spawnSync(
    "omw",
    ["call", "--browser", "chrome", ...deadline, session, action, JSON.stringify(args)],
    { encoding: "utf8" },
  );
  if (reply.error) throw reply.error;
  const body = JSON.parse(reply.stdout);
  if (error) {
    assert.notEqual(reply.status, 0);
    assert.equal(body.error?.code, error, reply.stdout);
  } else {
    assert.equal(reply.status, 0, reply.stdout);
  }
  return body;
}
assert.deepEqual(call("list_tabs", {}).result.tabs, [], "Use a session with no held tabs");
try {
  call("navigate", { url: `http://127.0.0.1:${port}/${session}/` });
  call("wait", { text: "Request copy" });
  const click = { action: "click", args: { selector: 'role=button[name="Request copy"]' } };
  const marker = "Batch step applied";
  const markPage = {
    action: "evaluate",
    args: { code: `document.title = ${JSON.stringify(marker)}` },
  };
  const shape = call("batch", { steps: [markPage, {}] }, "invalid_args");
  const applied = call("evaluate", { code: "document.title" }).result.value === marker;
  if (applied) assert.match(shape.error.message, /^batch step 2 of 2 \(undefined\):/);
  else assert.match(shape.error.message, /^batch step 2 of 2: action must be a non-empty string/);
  const failed = call(
    "batch",
    { steps: [click, { action: "wait", args: { text: "Receipt delivered successfully" } }] },
    "wait_timeout",
  );
  assert.match(failed.error.message, /step 2 of 2/i);
  assert.equal(events().filter((event) => event.event === "write").length, 1);
  call("click", { selector: 'role=link[name="Request history"]' });
  call("wait", { text: "April statement copy · Received" });
  const page = call("read_page", {});
  const receipt = events().find((event) => event.event === "evidence");
  assert.ok(receipt && JSON.stringify(page.result).includes(receipt.reference));
  assert.equal(events().filter((event) => event.event === "write").length, 1);
  console.log(
    JSON.stringify({
      malformed_step: shape.error,
      earlier_marker_applied: applied,
      timed_out_step: failed.error,
      writes: 1,
      receipt_verified: true,
    }),
  );
} finally {
  call("close_session", {});
}
