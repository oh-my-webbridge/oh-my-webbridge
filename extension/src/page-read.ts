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
  const boundary = (index: number): number => {
    const left = text.charCodeAt(index - 1);
    const right = text.charCodeAt(index);
    return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff
      ? index - 1
      : index;
  };
  const start = boundary(offset);
  const end = boundary(Math.min(text.length, start + size));
  const complete = end === text.length;
  return { text: text.slice(start, end), complete, nextOffset: complete ? null : end };
}
