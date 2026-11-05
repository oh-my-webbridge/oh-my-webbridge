// Records the documentation media into dist/media as <scene>.mp4 and <scene>.png:
//
//   node scripts/media/record.mjs [--language <language>] [scene ...]
//
// --language sets the extension interface language: en (the default), zh-TW
// or zh-CN. Recordings in another language than English are named
// <scene>.<language>.mp4, for example setup.zh-tw.mp4.
//
// Each scene in scripts/media/scenes runs on a fresh stage (stage.mjs). It needs
// CHROME_BIN pointing at Chrome for Testing, ffmpeg on PATH, a built
// dist/extension and dist/omw, and nothing else listening on 127.0.0.1:17373.
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { isLanguage } from "../../extension/src/i18n.ts";
import { openStage } from "./stage.mjs";

const { values, positionals } = parseArgs({
  options: { language: { type: "string", default: "en" } },
  allowPositionals: true,
});
const { language } = values;
if (!isLanguage(language)) throw new Error(`unknown language ${language}`);

const directory = resolve("scripts/media/scenes");
const scenes = (await readdir(directory))
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => file.slice(0, -".mjs".length))
  .sort();
const selected = positionals.length > 0 ? positionals : scenes;
const output = resolve("dist/media");

for (const scene of selected) {
  if (!scenes.includes(scene))
    throw new Error(`unknown scene ${scene}; scenes: ${scenes.join(", ")}`);
  const module = await import(pathToFileURL(join(directory, `${scene}.mjs`)).href);
  const name = language === "en" ? scene : `${scene}.${language.toLowerCase()}`;
  const work = resolve("dist/media-work", name);
  const started = Date.now();
  const stage = await openStage(work, { ...module.options, language });
  try {
    await module.default({ name, stage, output, work });
  } finally {
    await stage.close();
  }
  console.log(`${name}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
