// Snowflake IDs in the daemon's layout (internal/bridge/id.go): 41 bits of
// milliseconds since 2026-01-01T00:00:00Z, a 10-bit worker and a 12-bit
// sequence. Each bundle that imports this module, the worker or a Firefox page
// script, is one generator with a random worker; its IDs increase strictly,
// also when the clock goes back.
const epoch = 1_767_225_600_000;
const worker = BigInt(crypto.getRandomValues(new Uint16Array(1))[0]! & 0x3ff);
let last = 0;
let sequence = 0;

// Returns a new Snowflake ID in lowercase base 36, like the daemon.
export function snowflake(): string {
  const now = Date.now();
  if (now > last) {
    last = now;
    sequence = 0;
  } else if (++sequence > 0xfff) {
    last += 1;
    sequence = 0;
  }
  return ((BigInt(last - epoch) << 22n) | (worker << 12n) | BigInt(sequence)).toString(36);
}
