/**
 * Next.js inlines `process.env.NEXT_PUBLIC_*` at build time and next.config.mjs
 * always defines them; a missing value means the module runs outside Next.js.
 */
export function requiredEnv(name: string, value: string | undefined): string {
  if (value === undefined)
    throw new Error(`${name} is not defined; run the docs through next.config.mjs.`);
  return value;
}
