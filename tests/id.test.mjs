import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const epoch = 1_767_225_600_000;

// A fresh generator: each import of the bundle has its own worker and sequence.
async function generator(t) {
  const result = await build({
    entryPoints: ["extension/src/id.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#${t.name}`
  );
}
// BigInt() reads decimal and hex only.
const decode = (id) =>
  [...id].reduce((total, digit) => total * 36n + BigInt(parseInt(digit, 36)), 0n);
const parts = (id) => {
  const value = decode(id);
  return {
    time: Number(value >> 22n),
    worker: Number((value >> 12n) & 0x3ffn),
    sequence: Number(value & 0xfffn),
  };
};

test("snowflake IDs hold the time since 2026, the worker and a sequence", async (t) => {
  const { snowflake } = await generator(t);
  const now = epoch + 3_600_000;
  t.mock.method(Date, "now", () => now);
  const [first, second] = [snowflake(), snowflake()];
  assert.match(first, /^[0-9a-z]{1,13}$/u);
  assert.deepEqual(parts(first), { ...parts(first), time: now - epoch, sequence: 0 });
  assert.deepEqual(parts(second), { ...parts(first), sequence: 1 });
});

test("snowflake IDs increase when a millisecond runs out or the clock goes back", async (t) => {
  const { snowflake } = await generator(t);
  let now = epoch + 1000;
  t.mock.method(Date, "now", () => now);
  let previous = decode(snowflake());
  for (let i = 0; i < 5000; i++) {
    if (i === 4096) now -= 1000;
    const id = decode(snowflake());
    assert.ok(id > previous, `${id} after ${previous} at step ${i}`);
    previous = id;
  }
  assert.equal(previous >> 22n, 1001n, "IDs past 4096 in a millisecond use the next one");
});
