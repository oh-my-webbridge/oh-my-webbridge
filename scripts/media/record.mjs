// Records the documentation media into dist/media as <scene>.mp4 and <scene>.png:
//
//   node scripts/media/record.mjs [scene ...]
//
// Each scene in scripts/media/scenes runs on a fresh stage (stage.mjs). It needs
// CHROME_BIN pointing at Chrome for Testing, ffmpeg on PATH, a built
// dist/extension and dist/omw, and nothing else listening on 127.0.0.1:17373.
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openStage } from "./stage.mjs";

const directory = resolve("scripts/media/scenes");
const scenes = (await readdir(directory))
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => file.slice(0, -".mjs".length))
  .sort();
const selected = process.argv.length > 2 ? process.argv.slice(2) : scenes;
const output = resolve("dist/media");

for (const name of selected) {
  if (!scenes.includes(name))
    throw new Error(`unknown scene ${name}; scenes: ${scenes.join(", ")}`);
  const scene = await import(pathToFileURL(join(directory, `${name}.mjs`)).href);
  const work = resolve("dist/media-work", name);
  const started = Date.now();
  const stage = await openStage(work, scene.options);
  try {
    await scene.default({ name, stage, output, work });
  } finally {
    await stage.close();
  }
  console.log(`${name}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
