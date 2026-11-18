import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  latestReleaseEndpoint,
  releaseUpdate,
  startReleaseCheck,
} from "../extension/src/releases.ts";

const day = 24 * 60 * 60 * 1000;
function background(t, initial = {}) {
  const alarms = [];
  const changes = [];
  const requests = [];
  const settings = structuredClone(initial);
  let nextReply = () => Response.json({ tag_name: "v2.10.0", draft: false, prerelease: false });
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => structuredClone(settings),
        set: async (values) => Object.assign(settings, structuredClone(values)),
      },
      onChanged: { addListener: (listener) => changes.push(listener) },
    },
    alarms: {
      create: async (name, options) => {
        assert.equal(name, "check-release");
        assert.equal(options.periodInMinutes, 60);
      },
      onAlarm: { addListener: (listener) => alarms.push(listener) },
    },
  };
  t.after(() => {
    globalThis.chrome = originalChrome;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return nextReply(options);
  });
  startReleaseCheck();
  return {
    settings,
    requests,
    alarm: () => alarms.at(-1)({ name: "check-release" }),
    toggle: (enabled) => {
      const previous = settings.checkForReleases;
      settings.checkForReleases = enabled;
      changes.at(-1)({ checkForReleases: { oldValue: previous, newValue: enabled } }, "local");
    },
    reply: (callback) => {
      nextReply = callback;
    },
  };
}

test("release checks start automatically and use a persisted daily request limit", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2 * day });
  const { settings, requests, alarm } = background(t);
  await setImmediate();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, latestReleaseEndpoint);
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.referrerPolicy, "no-referrer");
  assert.equal(requests[0].options.redirect, "error");
  assert.deepEqual(settings.releaseCache, {
    attemptedAt: 2 * day,
    latest: "2.10.0",
    unavailable: false,
  });
  startReleaseCheck();
  alarm();
  t.mock.timers.tick(day - 1);
  await setImmediate();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  alarm();
  alarm();
  await setImmediate();
  assert.equal(requests.length, 2);
});

test("offline and invalid replies keep the last stable release and wait before retrying", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2 * day });
  const { settings, requests, alarm, reply } = background(t, {
    releaseCache: { attemptedAt: day, latest: "2.1.0" },
  });
  reply(() => {
    throw new TypeError("offline");
  });
  await setImmediate();
  assert.deepEqual(settings.releaseCache, {
    attemptedAt: 2 * day,
    latest: "2.1.0",
    unavailable: true,
  });
  alarm();
  await setImmediate();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(day);
  reply(() => Response.json({ tag_name: "v2.11.0-rc.1", draft: false, prerelease: true }));
  alarm();
  await setImmediate();
  assert.equal(requests.length, 2);
  assert.equal(settings.releaseCache.latest, "2.1.0");
  assert.equal(settings.releaseCache.unavailable, true);
});

test("turning off release checks stops new requests and aborts the current one", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2 * day });
  const { settings, requests, alarm, reply, toggle } = background(t, {
    checkForReleases: false,
  });
  await setImmediate();
  assert.deepEqual(requests, []);
  const response = Promise.withResolvers();
  reply(() => response.promise);
  toggle(true);
  await setImmediate();
  assert.equal(requests.length, 1);
  toggle(false);
  assert.equal(requests[0].options.signal.aborted, true);
  response.resolve(Response.json({ tag_name: "v2.2.0", draft: false, prerelease: false }));
  await setImmediate();
  assert.equal(settings.releaseCache.latest, undefined);
  reply(() => Response.json({ tag_name: "v2.2.0", draft: false, prerelease: false }));
  toggle(true);
  await setImmediate();
  assert.equal(requests.length, 2);
  assert.equal(settings.releaseCache.latest, "2.2.0");
  toggle(false);
  toggle(true);
  await setImmediate();
  assert.equal(requests.length, 2, "a completed check still counts toward the daily limit");
  toggle(false);
  t.mock.timers.tick(day);
  alarm();
  await setImmediate();
  assert.equal(requests.length, 2);
});

test("only installed stable versions older than the GitHub release produce an update notice", () => {
  assert.equal(releaseUpdate("2.10.0", "2.9.0", "2.0.9"), "releaseUpdateBoth");
  assert.equal(releaseUpdate("2.10.0", "2.9.0", "2.10.0"), "releaseUpdateExtension");
  assert.equal(releaseUpdate("2.10.0", "2.11.0", "1.9.9"), "releaseUpdateDaemon");
  assert.equal(releaseUpdate("2.10.0", "2.10.0", "dev"), undefined);
  assert.equal(releaseUpdate("2.10.0", "2.10.0"), undefined);
});
