import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Renderer } from "takumi-js/node";
import type { Locale } from "./i18n";

/**
 * Font families of the preview images. The renderer has no CJK glyphs: Simplified Chinese titles
 * use Noto Sans SC, Traditional Chinese titles Noto Sans TC. Both also cover Latin text.
 */
const fonts = {
  sc: { family: "Noto Sans SC Variable", dir: "noto-sans-sc" },
  tc: { family: "Noto Sans TC Variable", dir: "noto-sans-tc" },
} as const;

export function ogFontFamily(locale: Locale): string {
  return locale === "en" || locale === "zh-cn" ? fonts.sc.family : fonts.tc.family;
}

/** Registers every woff2 subset of a Fontsource package as one family, so each script finds glyphs. */
async function registerFont(
  renderer: Renderer,
  { family, dir }: (typeof fonts)["sc"] | (typeof fonts)["tc"],
) {
  // The bundler replaces `require.resolve` with a module id, so the files are found from the
  // package directory that runs `next build`.
  const path = join(process.cwd(), "node_modules", "@fontsource-variable", dir, "files");
  const files = (await readdir(path))
    .filter((file) => file.endsWith("-wght-normal.woff2"))
    .toSorted();
  if (files.length === 0) throw new Error(`No font files in ${path}`);
  await Promise.all(
    files.map(async (file, rank) =>
      renderer.registerFont({
        name: `${family} ${String(rank)}`,
        data: await readFile(join(path, file)),
        subsetOf: family,
        subsetRank: rank,
      }),
    ),
  );
}

let shared: Promise<Renderer> | undefined;

export function ogRenderer(): Promise<Renderer> {
  shared ??= (async () => {
    const renderer = new Renderer();
    await registerFont(renderer, fonts.sc);
    await registerFont(renderer, fonts.tc);
    return renderer;
  })();
  return shared;
}
