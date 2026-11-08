import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { SignJWT } from "jose";
import { verifyReleaseAssets } from "./release-assets.mjs";

const exec = promisify(execFile);
const repository = "https://github.com/oh-my-webbridge/oh-my-webbridge";
const sourceName = (version) => `oh-my-webbridge-${version}`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Both store APIs explain a refused request in the response body, so a failed
// release step reports it with the method and path. A missing resource
// resolves to null when the caller expects that answer.
async function request(store, url, init, { optional = false } = {}) {
  const response = await fetch(url, init);
  if (optional && response.status === 404) return null;
  const body = await response.text();
  if (!response.ok)
    throw Error(
      `${store} ${init.method ?? "GET"} ${new URL(url).pathname}: HTTP ${response.status} ${body.slice(0, 2000)}`,
    );
  return body ? JSON.parse(body) : {};
}

const form = (fields) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields))
    if (value instanceof Blob) data.append(name, value, value.name);
    else data.append(name, value);
  return data;
};

// Chrome Web Store API v2 for one item. The token is a short-lived access
// token of the publisher service account with the chromewebstore scope.
export function chromeWebStore({
  token,
  publisher,
  item,
  api = "https://chromewebstore.googleapis.com",
}) {
  const name = `publishers/${publisher}/items/${item}`;
  const call = (path, init = {}) =>
    request("Chrome Web Store", `${api}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
  const revision = (status) =>
    status && {
      state: status.state,
      versions: (status.distributionChannels ?? []).map((channel) => channel.crxVersion),
    };
  return {
    async status() {
      const status = await call(`/v2/${name}:fetchStatus`);
      return {
        published: revision(status.publishedItemRevisionStatus),
        submitted: revision(status.submittedItemRevisionStatus),
        upload: status.lastAsyncUploadState,
        takenDown: Boolean(status.takenDown),
        warned: Boolean(status.warned),
      };
    },
    async upload(zip) {
      const upload = await call(`/upload/v2/${name}:upload?uploadType=media`, {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: zip,
      });
      return { state: upload.uploadState, version: upload.crxVersion };
    },
    async publish() {
      const published = await call(`/v2/${name}:publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }),
      });
      return {
        state: published.state,
        warnings: (published.warningInfo?.warnings ?? []).map(
          (w) => `${w.reason}: ${w.description}`,
        ),
      };
    },
  };
}

const pendingStates = ["PENDING_REVIEW", "STAGED"];
const doneStates = [...pendingStates, "PUBLISHED", "PUBLISHED_TO_TESTERS"];

// Uploads the package and submits it for review; the store publishes it after
// approval. A version the store has published, or has in review or staged, is
// left as it is, so reruns of a release are safe. A rejected or cancelled
// submission of the version, and another version in review or staged, stop the
// submission for a decision in the developer dashboard.
export async function submitChrome(store, version, zip, { interval = 5000, attempts = 60 } = {}) {
  const { published, submitted } = await store.status();
  if (published?.versions.includes(version))
    return [`Chrome Web Store: ${version} is already published (${published.state})`];
  if (submitted?.versions.includes(version)) {
    if (doneStates.includes(submitted.state))
      return [`Chrome Web Store: ${version} is already submitted (${submitted.state})`];
    throw Error(
      `Chrome Web Store: the submission of ${version} is ${submitted.state}; resolve it in the developer dashboard`,
    );
  }
  if (pendingStates.includes(submitted?.state))
    throw Error(
      `Chrome Web Store: ${submitted.versions.join(", ")} is ${submitted.state}; cancel or publish it in the developer dashboard before submitting ${version}`,
    );
  let upload = await store.upload(zip);
  for (let attempt = 1; upload.state === "IN_PROGRESS"; attempt++) {
    if (attempt > attempts)
      throw Error(`Chrome Web Store: the upload of ${version} is still processing`);
    await sleep(interval);
    upload = { state: (await store.status()).upload };
  }
  if (upload.state !== "SUCCEEDED")
    throw Error(`Chrome Web Store: the upload of ${version} ended in ${upload.state}`);
  if (upload.version && upload.version !== version)
    throw Error(`Chrome Web Store: the uploaded package is ${upload.version}, not ${version}`);
  const submission = await store.publish();
  return [
    `Chrome Web Store: submitted ${version} (${submission.state})`,
    ...submission.warnings.map((warning) => `Chrome Web Store warning: ${warning}`),
  ];
}

// addons.mozilla.org API v5 for one add-on, signed in with an API key (the JWT
// issuer) and its secret.
export function addonsMozillaOrg({
  issuer,
  secret,
  addon,
  api = "https://addons.mozilla.org/api/v5",
}) {
  const key = new TextEncoder().encode(secret);
  // AMO accepts a token for at most five minutes after it is issued. Each
  // request signs a new one, so long validation waits stay signed in.
  const authorization = async () =>
    `JWT ${await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(issuer)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(key)}`;
  const call = async (path, init = {}, options) =>
    request(
      "addons.mozilla.org",
      `${api}${path}`,
      { ...init, headers: { authorization: await authorization(), ...init.headers } },
      options,
    );
  const upload = (u) => ({
    uuid: u.uuid,
    processed: u.processed,
    valid: u.valid,
    version: u.version,
    errors: (u.validation?.messages ?? [])
      .filter((message) => message.type === "error")
      .map((message) => message.message),
  });
  const version = (v) => ({
    id: v.id,
    version: v.version,
    channel: v.channel,
    status: v.file?.status,
    source: Boolean(v.source),
  });
  return {
    async version(number) {
      const found = await call(
        `/addons/addon/${addon}/versions/v${number}/`,
        {},
        { optional: true },
      );
      return found && version(found);
    },
    async versions() {
      const page = await call(
        `/addons/addon/${addon}/versions/?filter=all_with_unlisted&page_size=5`,
      );
      return page.results.map(version);
    },
    async upload(xpi) {
      return upload(
        await call("/addons/upload/", {
          method: "POST",
          body: form({ upload: xpi, channel: "listed" }),
        }),
      );
    },
    async uploadStatus(uuid) {
      return upload(await call(`/addons/upload/${uuid}/`));
    },
    async createVersion({ upload: uuid, approvalNotes, releaseNotes }) {
      return version(
        await call(`/addons/addon/${addon}/versions/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            upload: uuid,
            approval_notes: approvalNotes,
            release_notes: { "en-US": releaseNotes },
          }),
        }),
      );
    },
    async attachSource(id, source) {
      return version(
        await call(`/addons/addon/${addon}/versions/${id}/`, {
          method: "PATCH",
          body: form({ source }),
        }),
      );
    },
  };
}

// Uploads the add-on to the listed channel, waits for validation, creates the
// version with notes for the reviewers and attaches the source archive. A
// listed version AMO already has keeps its notes; it only receives the source
// archive when it has none, which completes an interrupted submission. Version
// numbers are unique across channels, so the number in another channel stops
// the submission.
export async function submitFirefox(
  amo,
  { version, xpi, source, approvalNotes, releaseNotes },
  { interval = 5000, attempts = 120 } = {},
) {
  const existing = await amo.version(version);
  if (existing && existing.channel !== "listed")
    throw Error(
      `addons.mozilla.org: ${version} already exists in the ${existing.channel} channel and cannot be listed`,
    );
  if (existing?.source)
    return [
      `addons.mozilla.org: ${version} already exists (${existing.channel}, ${existing.status})`,
    ];
  let created = existing;
  if (!created) {
    let upload = await amo.upload(xpi);
    for (let attempt = 1; !upload.processed; attempt++) {
      if (attempt > attempts)
        throw Error(`addons.mozilla.org: validation of ${version} is still running`);
      await sleep(interval);
      upload = await amo.uploadStatus(upload.uuid);
    }
    if (!upload.valid)
      throw Error(
        `addons.mozilla.org rejected ${version}${upload.errors.length ? `: ${upload.errors.join("; ")}` : ` without error messages (upload ${upload.uuid})`}`,
      );
    if (upload.version !== version)
      throw Error(`addons.mozilla.org: the uploaded add-on is ${upload.version}, not ${version}`);
    created = await amo.createVersion({ upload: upload.uuid, approvalNotes, releaseNotes });
  }
  const submitted = await amo.attachSource(created.id, source);
  return [
    `addons.mozilla.org: submitted ${version} with its source code (version ${submitted.id}, ${submitted.status})`,
  ];
}

// Notes for the AMO reviewers: where the source comes from and how to rebuild
// and exercise the add-on.
export function approvalNotes({ version, commit, node, pnpm, go }) {
  const directory = sourceName(version);
  return `Source code: ${directory}-source.zip is \`git archive\` of commit ${commit} (${repository}). The extension code is TypeScript bundled and minified with esbuild; the popup and setup pages are React built with Vite and Tailwind CSS.

Build (Node.js ${node}, pnpm ${pnpm}; macOS or Linux):

  unzip ${directory}-source.zip && cd ${directory}
  git init -q
  corepack enable       # package.json pins pnpm@${pnpm}
  pnpm install --frozen-lockfile --filter . --filter ./extension/ui --filter ./packages/brand
  pnpm run build

The add-on is written to dist/extension-firefox/. \`git init\` is required: Tailwind CSS applies .gitignore only inside a Git repository, and without it the generated CSS and the hashed asset names differ. The build reads the filter lists from third_party/filters in the archive and needs no network access after pnpm install. dist/extension-firefox.sha256.json lists the SHA-256 of worker.js, page.js, the manifest and the page assets.

The innerHTML warnings come from React DOM, in its handling of dangerouslySetInnerHTML. The extension source does not use dangerouslySetInnerHTML.

Testing needs the omw daemon from the same archive (Go ${go}):

  CGO_ENABLED=0 go build -o omw ./cmd/omw
  ./omw start
  ./omw pair            # type the six-digit code into the setup page
  ./omw call --browser firefox test navigate '{"url":"https://example.com"}'
  ./omw call test read_page
  ./omw call test close_session

The extension connects only to ws://127.0.0.1:17373 (the daemon) and sends no data elsewhere. <all_urls> lets page actions, screenshots and the blocking preset work in the tabs a session uses. userScripts is optional and is requested from the setup or settings page; only evaluate and wait with an expression use it.`;
}

const required = (name) => {
  const value = process.env[name];
  if (!value) throw Error(`${name} is not set`);
  return value;
};

// The stores receive the assets of the published GitHub Release, the files
// users download: each must match GitHub's digest and SHA256SUMS. The release
// must come from the checked-out commit, the commit of the source archive.
export async function releaseAssets(version, names, directory) {
  const repo = process.env.GITHUB_REPOSITORY ?? "oh-my-webbridge/oh-my-webbridge";
  const tag = `v${version}`;
  const gh = async (...args) =>
    (await exec("gh", args, { encoding: "buffer", maxBuffer: 256 << 20 })).stdout;
  const release = JSON.parse((await gh("api", `repos/${repo}/releases/tags/${tag}`)).toString());
  const download = async (name) => {
    const asset = release.assets.find((a) => a.name === name);
    if (!asset) throw Error(`release ${tag} has no ${name}`);
    const bytes = await gh(
      "api",
      `repos/${repo}/releases/assets/${asset.id}`,
      "-H",
      "Accept: application/octet-stream",
    );
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest)
      throw Error(`${name} downloaded from release ${tag} does not match its digest`);
    return bytes;
  };
  verifyReleaseAssets(release.assets, (await download("SHA256SUMS")).toString());
  const provenance = JSON.parse((await download("provenance.json")).toString());
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  if (provenance.version !== version || provenance.commit !== commit)
    throw Error(
      `release ${tag} holds ${provenance.version} from ${provenance.commit}, not ${version} from ${commit}`,
    );
  await mkdir(directory, { recursive: true });
  const files = {};
  for (const name of names) {
    files[name] = join(directory, name);
    await writeFile(files[name], await download(name));
  }
  return { provenance, files };
}

// `git archive` of the checked-out commit, with the top directory that the
// reviewer notes enter.
export async function sourceArchive(version, directory) {
  const archive = resolve(directory, `${sourceName(version)}-source.zip`);
  await mkdir(directory, { recursive: true });
  await exec("git", [
    "archive",
    "--format=zip",
    `--prefix=${sourceName(version)}/`,
    "-o",
    archive,
    "HEAD",
  ]);
  return archive;
}

const storeDirectory = "dist/stores";
const file = async (path) => new File([await readFile(path)], basename(path));

async function chrome(command, version) {
  const store = chromeWebStore({
    token: required("CWS_ACCESS_TOKEN"),
    publisher: required("CWS_PUBLISHER"),
    item: required("CWS_ITEM"),
  });
  if (command === "status") return [`Chrome Web Store: ${JSON.stringify(await store.status())}`];
  const zip = `omw-${version}-chrome-mv3.zip`;
  const { files } = await releaseAssets(version, [zip], storeDirectory);
  return submitChrome(store, version, await readFile(files[zip]));
}

async function firefox(command, version) {
  const manifest = JSON.parse(await readFile("extension/manifest.firefox.json", "utf8"));
  const amo = addonsMozillaOrg({
    issuer: required("AMO_JWT_ISSUER"),
    secret: required("AMO_JWT_SECRET"),
    addon: manifest.browser_specific_settings.gecko.id,
  });
  if (command === "status")
    return (await amo.versions()).map(
      (v) => `addons.mozilla.org: ${v.version} (${v.channel}, ${v.status}, source ${v.source})`,
    );
  const xpi = `omw-${version}-firefox-mv3-unsigned.xpi`;
  const { provenance, files } = await releaseAssets(version, [xpi], storeDirectory);
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  return submitFirefox(amo, {
    version,
    xpi: await file(files[xpi]),
    source: await file(await sourceArchive(version, storeDirectory)),
    approvalNotes: approvalNotes({
      version,
      commit: provenance.commit,
      node: provenance.node.replace(/^v/u, ""),
      pnpm: pkg.packageManager.replace(/^pnpm@/u, ""),
      go: provenance.go.match(/\bgo(\d\S*)/u)[1],
    }),
    releaseNotes: `[Release notes for ${version}](${repository}/releases/tag/v${version})`,
  });
}

// node scripts/stores.mjs chrome|firefox status|submit
async function main() {
  const [store, command] = process.argv.slice(2);
  const run = { chrome, firefox }[store];
  if (!run || !["status", "submit"].includes(command))
    throw Error("usage: node scripts/stores.mjs chrome|firefox status|submit");
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  for (const line of await run(command, version)) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
