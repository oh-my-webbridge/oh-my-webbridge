import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { jwtVerify } from "jose";
import {
  addonsMozillaOrg,
  approvalNotes,
  chromeWebStore,
  submitChrome,
  submitFirefox,
} from "../scripts/stores.mjs";

const exec = promisify(execFile);

// A local store API. `answer` maps each request to [status, JSON body]; the
// server records every request with its JSON or multipart fields.
async function fakeStore(t, answer) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const type = req.headers["content-type"] ?? "";
    let body = bytes;
    if (type.startsWith("multipart/form-data")) {
      const fields = await new Request("http://store", {
        method: "POST",
        headers: { "content-type": type },
        body: bytes,
      }).formData();
      body = {};
      for (const [name, value] of fields)
        body[name] =
          typeof value === "string" ? value : { name: value.name, text: await value.text() };
    } else if (type === "application/json") body = JSON.parse(bytes.toString());
    const request = { method: req.method, path: req.url, headers: req.headers, body };
    requests.push(request);
    const [status, json] = answer(request, requests);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  t.after(() => server.close());
  return { api: `http://127.0.0.1:${server.address().port}`, requests };
}

const item = "/v2/publishers/publisher-id/items/item-id";
const chromeStore = (api) =>
  chromeWebStore({ api, token: "access-token", publisher: "publisher-id", item: "item-id" });
const revision = (state, version) => ({
  state,
  distributionChannels: [{ deployPercentage: 100, crxVersion: version }],
});
const fast = { interval: 0, attempts: 3 };

test("Chrome Web Store submission uploads the package, waits for processing and submits it", async (t) => {
  let polls = 0;
  const { api, requests } = await fakeStore(t, ({ method, path }) => {
    if (path === `${item}:fetchStatus`)
      return [
        200,
        requests.some((r) => r.method === "POST")
          ? { lastAsyncUploadState: ++polls < 2 ? "IN_PROGRESS" : "SUCCEEDED" }
          : { publishedItemRevisionStatus: revision("PUBLISHED", "0.2.0") },
      ];
    if (method === "POST" && path === `/upload${item}:upload?uploadType=media`)
      return [200, { uploadState: "IN_PROGRESS" }];
    if (method === "POST" && path === `${item}:publish`)
      return [
        200,
        {
          state: "PENDING_REVIEW",
          warningInfo: {
            warnings: [{ reason: "BROAD_HOSTS", description: "Review takes longer." }],
          },
        },
      ];
    return [404, { error: { status: "NOT_FOUND" } }];
  });
  const zip = Buffer.from("PK package");
  assert.deepEqual(await submitChrome(chromeStore(api), "0.2.1", zip, fast), [
    "Chrome Web Store: submitted 0.2.1 (PENDING_REVIEW)",
    "Chrome Web Store warning: BROAD_HOSTS: Review takes longer.",
  ]);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    [
      `GET ${item}:fetchStatus`,
      `POST /upload${item}:upload?uploadType=media`,
      `GET ${item}:fetchStatus`,
      `GET ${item}:fetchStatus`,
      `POST ${item}:publish`,
    ],
  );
  assert.ok(requests.every((r) => r.headers.authorization === "Bearer access-token"));
  assert.equal(requests[1].headers["content-type"], "application/zip");
  assert.deepEqual(requests[1].body, zip);
  assert.deepEqual(requests[4].body, { publishType: "DEFAULT_PUBLISH" });
});

test("Chrome Web Store submission keeps the store's versions and pending submissions", async (t) => {
  let status;
  const { api, requests } = await fakeStore(t, ({ method, path }) => {
    if (path === `${item}:fetchStatus`) return [200, status];
    if (method === "POST" && path.startsWith(`/upload${item}:upload`))
      return [200, { uploadState: "SUCCEEDED", crxVersion: "0.2.1" }];
    if (method === "POST" && path === `${item}:publish`) return [200, { state: "PENDING_REVIEW" }];
    return [404, {}];
  });
  const store = chromeStore(api);
  const uploads = () => requests.filter((r) => r.method === "POST").length;
  for (const [current, line] of [
    [
      { submittedItemRevisionStatus: revision("PENDING_REVIEW", "0.2.1") },
      "Chrome Web Store: 0.2.1 is already submitted (PENDING_REVIEW)",
    ],
    [
      { publishedItemRevisionStatus: revision("PUBLISHED", "0.2.1") },
      "Chrome Web Store: 0.2.1 is already published (PUBLISHED)",
    ],
    [
      {
        publishedItemRevisionStatus: {
          state: "PUBLISHED",
          distributionChannels: [{ crxVersion: "0.2.0" }, { crxVersion: "0.2.1" }],
        },
      },
      "Chrome Web Store: 0.2.1 is already published (PUBLISHED)",
    ],
  ]) {
    status = current;
    assert.deepEqual(await submitChrome(store, "0.2.1", Buffer.from("zip"), fast), [line]);
  }
  for (const state of ["REJECTED", "CANCELLED"]) {
    status = { submittedItemRevisionStatus: revision(state, "0.2.1") };
    await assert.rejects(
      submitChrome(store, "0.2.1", Buffer.from("zip"), fast),
      new RegExp(
        `the submission of 0\\.2\\.1 is ${state}; resolve it in the developer dashboard`,
        "u",
      ),
    );
  }
  for (const state of ["PENDING_REVIEW", "STAGED"]) {
    status = { submittedItemRevisionStatus: revision(state, "0.2.0") };
    await assert.rejects(
      submitChrome(store, "0.2.1", Buffer.from("zip"), fast),
      new RegExp(`0\\.2\\.0 is ${state}; cancel or publish it`, "u"),
    );
  }
  assert.equal(uploads(), 0);
  status = { submittedItemRevisionStatus: revision("REJECTED", "0.2.0") };
  assert.deepEqual(await submitChrome(store, "0.2.1", Buffer.from("zip"), fast), [
    "Chrome Web Store: submitted 0.2.1 (PENDING_REVIEW)",
  ]);
  assert.equal(uploads(), 2);
});

test("Chrome Web Store submission stops at a failed upload or a refused request", async (t) => {
  let upload;
  let processing;
  const { api, requests } = await fakeStore(t, ({ method, path }) => {
    if (path === `${item}:fetchStatus`)
      return [
        200,
        requests.some((r) => r.method === "POST") ? { lastAsyncUploadState: processing } : {},
      ];
    if (method === "POST" && path.startsWith(`/upload${item}:upload`)) return upload;
    return [404, {}];
  });
  const store = chromeStore(api);
  upload = [200, { uploadState: "FAILED" }];
  await assert.rejects(
    submitChrome(store, "0.2.1", Buffer.from("zip"), fast),
    /the upload of 0\.2\.1 ended in FAILED/u,
  );
  upload = [200, { uploadState: "IN_PROGRESS" }];
  processing = "FAILED";
  await assert.rejects(
    submitChrome(store, "0.2.1", Buffer.from("zip"), fast),
    /the upload of 0\.2\.1 ended in FAILED/u,
  );
  processing = "IN_PROGRESS";
  await assert.rejects(
    submitChrome(store, "0.2.1", Buffer.from("zip"), fast),
    /the upload of 0\.2\.1 is still processing/u,
  );
  upload = [200, { uploadState: "SUCCEEDED", crxVersion: "0.2.0" }];
  await assert.rejects(
    submitChrome(store, "0.2.1", Buffer.from("zip"), fast),
    /the uploaded package is 0\.2\.0, not 0\.2\.1/u,
  );
  upload = [400, { error: { status: "INVALID_ARGUMENT", message: "version must increase" } }];
  await assert.rejects(
    submitChrome(store, "0.2.1", Buffer.from("zip"), fast),
    /Chrome Web Store POST \/upload\/v2\/publishers\/publisher-id\/items\/item-id:upload: HTTP 400 .*version must increase/u,
  );
  assert.ok(!requests.some((r) => r.path.endsWith(":publish")));
});

const addon = "/addons/addon/oh-my-webbridge@oh-my-webbridge.github.io";
const amoStore = (api) =>
  addonsMozillaOrg({
    api,
    issuer: "user:1:2",
    secret: "api-secret",
    addon: "oh-my-webbridge@oh-my-webbridge.github.io",
  });
const listed = (fields) => ({
  id: 7,
  version: "0.2.1",
  channel: "listed",
  file: { status: "unreviewed" },
  source: null,
  ...fields,
});
const submission = (approval) => ({
  version: "0.2.1",
  xpi: new File(["xpi bytes"], "omw-0.2.1-firefox-mv3-unsigned.xpi"),
  source: new File(["source bytes"], "oh-my-webbridge-0.2.1-source.zip"),
  approvalNotes: approval,
  releaseNotes: "[Release notes for 0.2.1](https://example.invalid/v0.2.1)",
});

test("AMO submission validates the add-on, creates the listed version and attaches the source", async (t) => {
  const { api, requests } = await fakeStore(t, ({ method, path }) => {
    if (method === "GET" && path === `${addon}/versions/v0.2.1/`)
      return [404, { detail: "Not found." }];
    if (method === "POST" && path === "/addons/upload/")
      return [201, { uuid: "u1", processed: false }];
    if (method === "GET" && path === "/addons/upload/u1/")
      return [
        200,
        {
          uuid: "u1",
          processed: true,
          valid: true,
          version: "0.2.1",
          validation: { messages: [{ type: "warning", message: "innerHTML" }] },
        },
      ];
    if (method === "POST" && path === `${addon}/versions/`) return [201, listed()];
    if (method === "PATCH" && path === `${addon}/versions/7/`)
      return [200, listed({ source: "https://addons.example/source.zip" })];
    return [404, {}];
  });
  const notes = approvalNotes({
    version: "0.2.1",
    commit: "0123456789abcdef0123456789abcdef01234567",
    node: "24.15.0",
    pnpm: "11.28.5",
    go: "1.27.3",
  });
  assert.match(
    notes,
    /oh-my-webbridge-0\.2\.1-source\.zip is `git archive` of commit 0123456789abcdef/u,
  );
  assert.match(
    notes,
    /unzip oh-my-webbridge-0\.2\.1-source\.zip && cd oh-my-webbridge-0\.2\.1\n  git init -q/u,
  );
  assert.deepEqual(await submitFirefox(amoStore(api), submission(notes), fast), [
    "addons.mozilla.org: submitted 0.2.1 with its source code (version 7, unreviewed)",
  ]);
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    [
      `GET ${addon}/versions/v0.2.1/`,
      "POST /addons/upload/",
      "GET /addons/upload/u1/",
      `POST ${addon}/versions/`,
      `PATCH ${addon}/versions/7/`,
    ],
  );
  assert.deepEqual(requests[1].body, {
    upload: { name: "omw-0.2.1-firefox-mv3-unsigned.xpi", text: "xpi bytes" },
    channel: "listed",
  });
  assert.deepEqual(requests[3].body, {
    upload: "u1",
    approval_notes: notes,
    release_notes: { "en-US": "[Release notes for 0.2.1](https://example.invalid/v0.2.1)" },
  });
  assert.deepEqual(requests[4].body, {
    source: { name: "oh-my-webbridge-0.2.1-source.zip", text: "source bytes" },
  });
  const ids = new Set();
  for (const r of requests) {
    const [scheme, token] = r.headers.authorization.split(" ");
    assert.equal(scheme, "JWT");
    const { payload } = await jwtVerify(token, new TextEncoder().encode("api-secret"), {
      issuer: "user:1:2",
      algorithms: ["HS256"],
    });
    assert.ok(payload.exp - payload.iat <= 300, "AMO rejects tokens valid for over five minutes");
    ids.add(payload.jti);
  }
  assert.equal(ids.size, requests.length, "each request signs a new token");
});

test("AMO submission stops at validation errors and a different version", async (t) => {
  let detail;
  const { api, requests } = await fakeStore(t, ({ method, path }) => {
    if (method === "GET" && path === `${addon}/versions/v0.2.1/`) return [404, {}];
    if (method === "POST" && path === "/addons/upload/") return [201, detail];
    if (method === "GET" && path === `/addons/upload/${detail.uuid}/`) return [200, detail];
    return [404, {}];
  });
  detail = {
    uuid: "u1",
    processed: true,
    valid: false,
    version: "0.2.1",
    validation: {
      messages: [
        { type: "error", message: "Duplicate version" },
        { type: "warning", message: "innerHTML" },
        { type: "error", message: "Invalid manifest" },
      ],
    },
  };
  await assert.rejects(
    submitFirefox(amoStore(api), submission("notes"), fast),
    /addons\.mozilla\.org rejected 0\.2\.1: Duplicate version; Invalid manifest$/u,
  );
  detail = { uuid: "u2", processed: true, valid: false, version: "0.2.1", validation: {} };
  await assert.rejects(
    submitFirefox(amoStore(api), submission("notes"), fast),
    /rejected 0\.2\.1 without error messages \(upload u2\)$/u,
  );
  detail = { uuid: "u3", processed: true, valid: true, version: "0.2.0" };
  await assert.rejects(
    submitFirefox(amoStore(api), submission("notes"), fast),
    /the uploaded add-on is 0\.2\.0, not 0\.2\.1/u,
  );
  detail = { uuid: "u4", processed: false };
  await assert.rejects(
    submitFirefox(amoStore(api), submission("notes"), fast),
    /validation of 0\.2\.1 is still running/u,
  );
  assert.ok(!requests.some((r) => r.path === `${addon}/versions/`));
});

test("AMO submission keeps an existing version and completes one without source code", async (t) => {
  let existing;
  const { api, requests } = await fakeStore(t, ({ method, path }) => {
    if (method === "GET" && path === `${addon}/versions/v0.2.1/`) return [200, existing];
    if (method === "PATCH" && path === `${addon}/versions/7/`)
      return [200, listed({ source: "https://addons.example/source.zip" })];
    return [404, {}];
  });
  existing = listed({ file: { status: "public" }, source: "https://addons.example/source.zip" });
  assert.deepEqual(await submitFirefox(amoStore(api), submission("notes"), fast), [
    "addons.mozilla.org: 0.2.1 already exists (listed, public)",
  ]);
  existing = listed();
  assert.deepEqual(await submitFirefox(amoStore(api), submission("notes"), fast), [
    "addons.mozilla.org: submitted 0.2.1 with its source code (version 7, unreviewed)",
  ]);
  existing = listed({ channel: "unlisted", file: { status: "public" } });
  await assert.rejects(
    submitFirefox(amoStore(api), submission("notes"), fast),
    /0\.2\.1 already exists in the unlisted channel and cannot be listed/u,
  );
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    [
      `GET ${addon}/versions/v0.2.1/`,
      `GET ${addon}/versions/v0.2.1/`,
      `PATCH ${addon}/versions/7/`,
      `GET ${addon}/versions/v0.2.1/`,
    ],
  );
});

// A checkout with one commit, the fake gh on PATH and a published v0.2.1
// release. `publish` writes the release assets; `run` calls releaseAssets
// and sourceArchive in the checkout.
async function releaseFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "omw-stores-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    FAKE_GH_STATE: join(dir, "gh-state.json"),
    GITHUB_REPOSITORY: "oh-my-webbridge/oh-my-webbridge",
  };
  const git = (...args) => exec("git", args, { cwd: dir, env });
  await writeFile(join(dir, "package.json"), '{ "version": "0.2.1" }\n');
  await git("init", "-q", "-b", "main");
  await git("add", ".");
  await git("commit", "-q", "-m", "fixture");
  const commit = (await git("rev-parse", "HEAD")).stdout.trim();
  await mkdir(join(dir, "bin"));
  await cp("tests/fixtures/fake-gh.mjs", join(dir, "bin/gh"));
  await chmod(join(dir, "bin/gh"), 0o755);
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const publish = async ({ assets, sums = assets }) => {
    await mkdir(join(dir, "uploaded"), { recursive: true });
    const manifest = Object.entries(sums)
      .map(([name, data]) => `${sha256(data)}  ${name}\n`)
      .join("");
    const files = {};
    const release = { id: 1, tag_name: "v0.2.1", draft: false, assets: [] };
    for (const [index, [name, data]] of Object.entries({
      ...assets,
      SHA256SUMS: manifest,
    }).entries()) {
      const id = 10 + index;
      files[id] = join(dir, "uploaded", name);
      await writeFile(files[id], data);
      release.assets.push({ id, name, state: "uploaded", digest: `sha256:${sha256(data)}` });
    }
    await writeFile(env.FAKE_GH_STATE, JSON.stringify({ releases: [release], files, calls: [] }));
    return files;
  };
  const stores = pathToFileURL(resolve("scripts/stores.mjs")).href;
  const run = () =>
    exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { releaseAssets, sourceArchive } from ${JSON.stringify(stores)};
const assets = await releaseAssets("0.2.1", ["omw-0.2.1-chrome-mv3.zip"], "dist/stores");
console.log(JSON.stringify({ ...assets, source: await sourceArchive("0.2.1", "dist/stores") }));`,
      ],
      { cwd: dir, env },
    ).then(
      ({ stdout }) => ({ code: 0, value: JSON.parse(stdout) }),
      (error) => ({ code: error.code, stderr: error.stderr }),
    );
  return { dir, commit, publish, run };
}

test("store submissions use the verified assets of the published release and a source archive of the commit", async (t) => {
  const { dir, commit, publish, run } = await releaseFixture(t);
  const provenance = JSON.stringify({
    version: "0.2.1",
    commit,
    node: "v24.15.0",
    go: "go version go1.27.3 linux/amd64",
  });
  const assets = {
    "omw-0.2.1-chrome-mv3.zip": "chrome package",
    "omw-0.2.1-firefox-mv3-unsigned.xpi": "firefox add-on",
    "provenance.json": provenance,
  };
  await publish({ assets });
  const passed = await run();
  assert.equal(passed.code, 0, passed.stderr);
  assert.deepEqual(passed.value.provenance, JSON.parse(provenance));
  assert.equal(
    await readFile(join(dir, passed.value.files["omw-0.2.1-chrome-mv3.zip"]), "utf8"),
    "chrome package",
  );
  const entries = Object.keys(unzipSync(await readFile(passed.value.source)));
  assert.ok(entries.includes("oh-my-webbridge-0.2.1/package.json"), entries.join(", "));
  assert.ok(entries.every((entry) => entry.startsWith("oh-my-webbridge-0.2.1/")));
  assert.ok(passed.value.source.endsWith("/dist/stores/oh-my-webbridge-0.2.1-source.zip"));
  assert.match(
    approvalNotes({ version: "0.2.1", commit, node: "24.15.0", pnpm: "11.28.5", go: "1.27.3" }),
    /unzip oh-my-webbridge-0\.2\.1-source\.zip && cd oh-my-webbridge-0\.2\.1\n/u,
  );

  const files = await publish({ assets });
  await writeFile(files[10], "replaced package");
  assert.match(
    (await run()).stderr,
    /omw-0\.2\.1-chrome-mv3\.zip downloaded from release v0\.2\.1 does not match its digest/u,
  );
  await publish({ assets, sums: { ...assets, "omw-0.2.1-chrome-mv3.zip": "other package" } });
  assert.match((await run()).stderr, /uploaded digest mismatch: omw-0\.2\.1-chrome-mv3\.zip/u);
  const other = JSON.stringify({ ...JSON.parse(provenance), commit: "f".repeat(40) });
  await publish({ assets: { ...assets, "provenance.json": other } });
  assert.match(
    (await run()).stderr,
    new RegExp(`release v0\\.2\\.1 holds 0\\.2\\.1 from f{40}, not 0\\.2\\.1 from ${commit}`, "u"),
  );
  const { "omw-0.2.1-chrome-mv3.zip": _, ...withoutPackage } = assets;
  await publish({ assets: withoutPackage });
  assert.match((await run()).stderr, /release v0\.2\.1 has no omw-0\.2\.1-chrome-mv3\.zip/u);
});
