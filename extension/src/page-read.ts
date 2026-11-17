import { fail, type Args } from "./protocol.js";

export function readRange(args: Args): [number, number] {
  const { offset = 0, pageSize = 192_000 } = args;
  if (!Number.isSafeInteger(offset) || offset < 0)
    fail("invalid_args", "offset must be a non-negative safe integer");
  if (!Number.isSafeInteger(pageSize) || pageSize < 2 || pageSize > 192_000)
    fail("invalid_args", "pageSize must be an integer from 2 to 192000");
  return [offset, pageSize];
}

// Also serialized into the selected Chrome execution context. Slice there so
// the complete document never crosses the debugger connection.
export function readChunk(text: string, offset: number, size: number) {
  let end = Math.min(text.length, offset + size);
  if (
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  )
    end--;
  const complete = end === text.length;
  return { text: text.slice(offset, end), complete, nextOffset: complete ? null : end };
}
