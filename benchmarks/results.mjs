const text = (value) => (typeof value === "string" ? value : JSON.stringify(value));

export function observed(value) {
  return value && typeof value === "object" && "benchmarkValue" in value
    ? value.benchmarkValue
    : value;
}
export function output(value, wire) {
  return { benchmarkValue: value, wireBytes: Buffer.byteLength(text(wire)) };
}
export function mcpValue(packet, isPW) {
  const source = packet.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const json = isPW
    ? source.match(/### Result\n([\s\S]*?)(?:\n### |$)/u)?.[1]
    : source.match(/```json\n([\s\S]*?)\n```/u)?.[1];
  if (json === undefined) throw Error(`MCP returned no result section: ${source.slice(0, 500)}`);
  return output(JSON.parse(json), packet);
}
