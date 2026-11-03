import { FiltersEngine } from "@ghostery/adblocker";
import { fail, type Args } from "./protocol.js";

export type Preset = {
  name: "anti-ad" | "zen" | "none";
  environment: boolean;
  images: boolean;
  fonts: boolean;
  css: boolean;
  javascript: boolean;
};
export function presetConfig(args: Args = {}, previous?: Preset): Preset {
  const name = args.preset ?? previous?.name ?? "anti-ad";
  if (!["anti-ad", "zen", "none"].includes(name))
    fail("invalid_args", "preset: anti-ad, zen or none");
  for (const value of [args.environment, ...Object.values(args.zen ?? {})].filter(
    (value) => value !== undefined,
  ))
    if (typeof value !== "boolean") fail("invalid_args", "preset switches must be booleans");
  return {
    name,
    environment: args.environment ?? previous?.environment ?? false,
    // true means block this resource, with conservative Zen defaults.
    images: args.zen?.images ?? previous?.images ?? true,
    fonts: args.zen?.fonts ?? previous?.fonts ?? true,
    css: args.zen?.css ?? previous?.css ?? false,
    javascript: args.zen?.javascript ?? previous?.javascript ?? false,
  };
}

// One engine per background instance, loaded from the bundled filters.bin on
// first use and dropped 30 s after the last filtering tab lets it go.
let enginePromise: Promise<FiltersEngine> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
export function engine(): Promise<FiltersEngine> {
  enginePromise ??= (async () => {
    const response = await fetch(chrome.runtime.getURL("filters.bin"));
    if (!response.ok) throw Error(`bundled filters: ${response.status}`);
    return FiltersEngine.deserialize(new Uint8Array(await response.arrayBuffer()));
  })();
  return enginePromise;
}
// Lets the next engine() call load the lists again, after a failed load.
export function forgetEngine(): void {
  enginePromise = undefined;
}
export function releaseEngineWhenIdle(inUse: () => boolean): void {
  clearTimeout(idle);
  idle = setTimeout(() => {
    if (!inUse()) enginePromise = undefined;
  }, 30000);
}
