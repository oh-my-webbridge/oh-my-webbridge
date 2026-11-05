// Places a recorded page in a light window frame on a soft background. Frame
// layers are SVG rendered with resvg; ffmpeg composes videos, resvg alone
// composes stills.
import { Resvg } from "@resvg/resvg-js";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { scale, viewport } from "./stage.mjs";

const run = promisify(execFile);

// Canvas geometry in output pixels. The page keeps its aspect ratio.
const canvas = { width: 1600 };
const frame = { x: 80, y: 72, width: 1440, bar: 76, radius: 20 };
const content = {
  x: frame.x,
  y: frame.y + frame.bar,
  width: frame.width,
  height: Math.round((frame.width * viewport.height) / viewport.width),
};
canvas.height = content.y + content.height + 112;
// Output pixels per CSS pixel of the recorded page.
const unit = content.width / viewport.width;

// Window titles of Chinese recordings fall back to PingFang.
const font = "Helvetica Neue, Helvetica, Arial, PingFang TC, PingFang SC, sans-serif";

// The favicon and toolbar icons use the small masters, as the browser does at these sizes.
export const icon = {
  mark: resolve("packages/brand/icons/mark.svg"),
  live: resolve("packages/brand/icons/small/toolbar-live.svg"),
  toolbar: (state) => resolve(`packages/brand/icons/small/toolbar-${state}.svg`),
  lucide: (name) => resolve(`node_modules/lucide-static/icons/${name}.svg`),
};

const escape = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const dataUrl = async (path, type) =>
  `data:${type};base64,${(await readFile(path)).toString("base64")}`;

function render(svg) {
  return new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" },
    shapeRendering: 2,
    textRendering: 1,
  })
    .render()
    .asPng();
}

const svg = (body, width = canvas.width, height = canvas.height) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;

function background() {
  const { x, y, width, radius } = frame;
  const height = frame.bar + content.height;
  return `
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#F4F5F7"/><stop offset="1" stop-color="#E1E4E9"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0" r="0.9">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.85"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </radialGradient>
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="34"/><feOffset dy="30" result="wide"/>
    <feFlood flood-color="#101318" flood-opacity="0.16"/><feComposite in2="wide" operator="in" result="far"/>
    <feGaussianBlur in="SourceAlpha" stdDeviation="2.5"/><feOffset dy="1.5" result="tight"/>
    <feFlood flood-color="#101318" flood-opacity="0.12"/><feComposite in2="tight" operator="in" result="near"/>
    <feMerge><feMergeNode in="far"/><feMergeNode in="near"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="${canvas.width}" height="${canvas.height}" fill="url(#bg)"/>
<rect width="${canvas.width}" height="${canvas.height}" fill="url(#glow)"/>
<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="#FFFFFF" filter="url(#shadow)"/>`;
}

// The title bar: window controls, one tab with its favicon and title, the
// address field, and the extension's toolbar icon.
async function titleBar({ title, host, favicon, toolbar }) {
  const { x, y, width, bar, radius } = frame;
  const field = { x: x + 444, width: width - 444 - 120 };
  return `
<defs>
  <clipPath id="top"><rect x="${x}" y="${y}" width="${width}" height="${bar + radius}" rx="${radius}"/></clipPath>
  <filter id="lift" x="-10%" y="-30%" width="120%" height="160%">
    <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.10"/>
  </filter>
  <!-- A title longer than the tab fades out before the tab's right edge, as in the browser. -->
  <linearGradient id="title-fade" gradientUnits="userSpaceOnUse" x1="${x + 376}" x2="${x + 404}" y1="0" y2="0">
    <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <mask id="title"><rect x="${x + 116}" y="${y}" width="304" height="${bar}" fill="url(#title-fade)"/></mask>
</defs>
<g clip-path="url(#top)"><rect x="${x}" y="${y}" width="${width}" height="${bar}" fill="#F3F3F5"/></g>
<rect x="${x}" y="${y + bar - 1}" width="${width}" height="1" fill="#000000" fill-opacity="0.08"/>
${["#FF5F57", "#FEBC2E", "#28C840"]
  .map(
    (fill, index) =>
      `<circle cx="${x + 32 + index * 24}" cy="${y + bar / 2}" r="7.5" fill="${fill}" stroke="#000000" stroke-opacity="0.12" stroke-width="0.75"/>`,
  )
  .join("")}
<rect x="${x + 116}" y="${y + 14}" width="304" height="${bar - 28}" rx="11" fill="#FFFFFF" filter="url(#lift)"/>
<image x="${x + 132}" y="${y + bar / 2 - 11}" width="22" height="22" href="${await dataUrl(favicon, "image/svg+xml")}"/>
<text x="${x + 166}" y="${y + bar / 2 + 6}" font-family="${font}" font-size="17" font-weight="500" fill="#1D1D1F" mask="url(#title)">${escape(title)}</text>
<rect x="${field.x}" y="${y + 18}" width="${field.width}" height="${bar - 36}" rx="11" fill="#E8E8EB"/>
<text x="${field.x + field.width / 2}" y="${y + bar / 2 + 6}" text-anchor="middle" font-family="${font}" font-size="16.5" fill="#48484A">${escape(host)}</text>
<image x="${x + width - 76}" y="${y + bar / 2 - 16}" width="32" height="32" href="${await dataUrl(icon.toolbar(toolbar), "image/svg+xml")}"/>`;
}

function contentMask() {
  const { width, height } = content;
  const r = frame.radius;
  return svg(
    `<rect width="${width}" height="${height}" fill="#000000"/><path d="M0 0H${width}V${height - r}a${r} ${r} 0 0 1-${r} ${r}H${r}a${r} ${r} 0 0 1-${r}-${r}Z" fill="#FFFFFF"/>`,
    width,
    height,
  );
}

// A floating panel anchored under the toolbar icon, such as the popup.
async function popover({ image, width: cssWidth, height: cssHeight }) {
  const width = cssWidth * unit;
  const height = cssHeight * unit;
  const x = frame.x + frame.width - 24 - width;
  const y = frame.y + frame.bar - 6;
  return `
<defs>
  <clipPath id="panel"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="16"/></clipPath>
  <filter id="float" x="-30%" y="-20%" width="160%" height="150%">
    <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#101318" flood-opacity="0.22"/>
  </filter>
</defs>
<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="16" fill="#FFFFFF" filter="url(#float)"/>
<image x="${x}" y="${y}" width="${width}" height="${height}" clip-path="url(#panel)" preserveAspectRatio="none" href="${await dataUrl(image, "image/png")}"/>
<rect x="${x + 0.5}" y="${y + 0.5}" width="${width - 1}" height="${height - 1}" rx="15.5" fill="none" stroke="#000000" stroke-opacity="0.10"/>`;
}

/**
 * A still: `image` is a page capture at viewport size times scale. `window` is
 * { title, host, favicon, toolbar }; `panel` adds a popover such as the popup.
 */
export async function composeStill({ image, output, window, panel }) {
  const type = image.endsWith(".png") ? "image/png" : "image/jpeg";
  const page = `
<defs><clipPath id="page"><path d="M${content.x} ${content.y}H${content.x + content.width}V${content.y + content.height - frame.radius}a${frame.radius} ${frame.radius} 0 0 1-${frame.radius} ${frame.radius}H${content.x + frame.radius}a${frame.radius} ${frame.radius} 0 0 1-${frame.radius}-${frame.radius}Z"/></clipPath></defs>
<image x="${content.x}" y="${content.y}" width="${content.width}" height="${content.height}" clip-path="url(#page)" preserveAspectRatio="none" href="${await dataUrl(image, type)}"/>`;
  const body = [background(), page, await titleBar(window), panel ? await popover(panel) : ""];
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, render(svg(body.join(""))));
}

/**
 * A video from a recording of stage.record(). `timeline` lists title bar
 * states, each { at, ...window } with `at` in seconds; the first starts at 0.
 */
export async function composeVideo({ recording, output, timeline, work }) {
  await mkdir(work, { recursive: true });
  const { frames, duration } = recording;
  const list = frames.flatMap((current, index) => {
    const next = frames[index + 1]?.time ?? duration;
    return [
      `file '${current.file}'`,
      `duration ${Math.max(next - current.time, 0.001).toFixed(4)}`,
    ];
  });
  list.push(`file '${frames.at(-1).file}'`);
  await writeFile(join(work, "frames.txt"), list.join("\n") + "\n");
  await writeFile(join(work, "background.png"), render(svg(background())));
  await writeFile(join(work, "mask.png"), render(contentMask()));
  const bars = [];
  for (const [index, state] of timeline.entries()) {
    const file = join(work, `bar-${index}.png`);
    await writeFile(file, render(svg(await titleBar(state))));
    bars.push({ file, from: state.at, to: timeline[index + 1]?.at ?? duration + 1 });
  }
  const looped = (file) => ["-loop", "1", "-framerate", "60", "-i", file];
  const filters = [
    `[1:v]fps=60,scale=${content.width}:${content.height}:flags=lanczos,format=rgba[page]`,
    "[2:v]format=gray[mask]",
    "[page][mask]alphamerge[shaped]",
    `[0:v][shaped]overlay=${content.x}:${content.y}:shortest=1[v0]`,
    ...bars.map(
      (bar, index) =>
        `[v${index}][${index + 3}:v]overlay=0:0:shortest=1:enable='between(t,${bar.from.toFixed(3)},${bar.to.toFixed(3)})'[v${index + 1}]`,
    ),
    `[v${bars.length}]format=yuv420p[out]`,
  ];
  await mkdir(dirname(output), { recursive: true });
  await run(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      ...looped(join(work, "background.png")),
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      join(work, "frames.txt"),
      ...looped(join(work, "mask.png")),
      ...bars.flatMap((bar) => looped(bar.file)),
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      // The looped frame layers never end; the recording sets the length.
      "-t",
      duration.toFixed(3),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "22",
      "-r",
      "60",
      "-movflags",
      "+faststart",
      output,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

// The recorded frame shown at `time` seconds.
export function frameAt(recording, time) {
  return recording.frames.findLast((candidate) => candidate.time <= time) ?? recording.frames[0];
}

/**
 * Writes `name`.mp4 and its poster `name`.png. The poster is the frame at the
 * recording mark named `poster`, with the title bar state of that moment.
 * `gif` also writes a 720 px `name`.gif for places that cannot play video,
 * such as a README on GitHub.
 */
export async function saveVideo({ name, recording, timeline, output, work, gif = false }) {
  await composeVideo({
    recording,
    output: join(output, `${name}.mp4`),
    timeline,
    work: join(work, "compose"),
  });
  const time = recording.marks.poster ?? recording.duration / 2;
  const state = timeline.findLast((candidate) => candidate.at <= time) ?? timeline[0];
  await composeStill({
    image: frameAt(recording, time).file,
    output: join(output, `${name}.png`),
    window: state,
  });
  if (gif)
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      join(output, `${name}.mp4`),
      "-vf",
      "fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
      join(output, `${name}.gif`),
    ]);
}

export { canvas, content, scale, unit };
