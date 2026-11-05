// OBU 0.1.12 emits two pagination counters absent from its tools/list schema.
// Keep strict validation and allow only these observed, typed fields. Preserve
// the original advertised schema in artifacts rather than patching upstream.
export function obuOutputSchema(schema) {
  if (
    !schema.properties?.displays ||
    !schema.properties?.duration_ms ||
    !schema.properties?.error_detail
  )
    return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      displays_shown: { type: "integer", minimum: 0 },
      displays_total: { type: "integer", minimum: 0 },
    },
  };
}
