import { appendFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

const { channels } = await (
  await fetch(
    "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json",
  )
).json();
const platform =
  process.platform === "darwin" ? (process.arch === "arm64" ? "mac-arm64" : "mac-x64") : "linux64";
const asset = channels.Stable.downloads.chrome.find((download) => download.platform === platform);
if (!asset || new URL(asset.url).hostname !== "storage.googleapis.com")
  throw new Error("missing official Chrome for Testing download");
const root = join(process.env.RUNNER_TEMP, "omw-test-chrome");
await mkdir(root, { recursive: true });
execFileSync("curl", ["-fsSL", "--retry", "3", asset.url, "-o", `${root}.zip`], {
  stdio: "inherit",
});
execFileSync("unzip", ["-q", `${root}.zip`, "-d", root], {
  stdio: "inherit",
});
const binary = platform.startsWith("mac")
  ? `chrome-${platform}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  : "chrome-linux64/chrome";
await appendFile(process.env.GITHUB_ENV, `CHROME_BIN=${resolve(root, binary)}\n`);
console.log(`Chrome for Testing ${channels.Stable.version} (${platform})`);

if (process.env.OMW_CHROMEDRIVER === "true") {
  const driver = channels.Stable.downloads.chromedriver.find((d) => d.platform === platform);
  if (!driver || new URL(driver.url).hostname !== "storage.googleapis.com")
    throw Error("no matching official ChromeDriver");
  execFileSync("curl", ["-fsSL", "--retry", "3", driver.url, "-o", `${root}-driver.zip`], {
    stdio: "inherit",
  });
  execFileSync("unzip", ["-qo", `${root}-driver.zip`, "-d", root], { stdio: "inherit" });
  await appendFile(
    process.env.GITHUB_ENV,
    `CHROMEDRIVER_BIN=${resolve(root, `chromedriver-${platform}/chromedriver`)}\n`,
  );
}
