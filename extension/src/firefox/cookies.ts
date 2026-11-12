import { fail, stringArg, type Args, type Json, type JsonObject } from "../protocol.js";

const sameSites = { Strict: "strict", Lax: "lax", None: "no_restriction" } as const;
function cookieUrl(cookie: chrome.cookies.Cookie): string {
  return `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./u, "")}${cookie.path}`;
}
// Same fields as Chrome's Network.Cookie for the ones both browsers know.
function view(cookie: chrome.cookies.Cookie): JsonObject {
  const sameSite = Object.entries(sameSites).find(([, value]) => value === cookie.sameSite)?.[0];
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expirationDate ?? -1,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    session: cookie.session,
    ...(sameSite ? { sameSite } : {}),
    ...(cookie.partitionKey?.topLevelSite
      ? { partitionKey: { topLevelSite: cookie.partitionKey.topLevelSite } }
      : {}),
  };
}
function isSameSite(value: string): value is keyof typeof sameSites {
  return Object.hasOwn(sameSites, value);
}
function optional(data: JsonObject, key: string, type: "string"): string | undefined;
function optional(data: JsonObject, key: string, type: "number"): number | undefined;
function optional(data: JsonObject, key: string, type: "boolean"): boolean | undefined;
function optional(data: JsonObject, key: string, type: string): Json | undefined {
  const value = data[key];
  if (value !== undefined && typeof value !== type)
    fail("invalid_args", `cookie ${key} must be a ${type}`);
  return value;
}
// Firefox partitions third-party cookies by top-level site; an empty
// partitionKey selects every partition, matching what the page can see.
async function all(url: string, storeId: string): Promise<chrome.cookies.Cookie[]> {
  return chrome.cookies.getAll({ url, storeId, partitionKey: {} });
}
// storeId is the cookie store of the tab. Without it Firefox uses the
// background's store, the default one, also for a tab in a container.
export async function cookies(url: string, storeId: string, args: Args): Promise<object> {
  const cmd = args.cmd ?? "list";
  if (cmd === "set") {
    const data = args.data ?? {};
    const sameSite = optional(data, "sameSite", "string");
    if (sameSite !== undefined && !isSameSite(sameSite))
      fail("invalid_args", "cookie sameSite must be Strict, Lax or None");
    const domain = optional(data, "domain", "string");
    const path = optional(data, "path", "string");
    const secure = optional(data, "secure", "boolean");
    const httpOnly = optional(data, "httpOnly", "boolean");
    const expires = optional(data, "expires", "number");
    await chrome.cookies.set({
      url,
      storeId,
      name: stringArg(optional(data, "name", "string"), "cookie name"),
      value: optional(data, "value", "string") ?? "",
      ...(domain === undefined ? {} : { domain }),
      ...(path === undefined ? {} : { path }),
      ...(secure === undefined ? {} : { secure }),
      ...(httpOnly === undefined ? {} : { httpOnly }),
      ...(expires === undefined ? {} : { expirationDate: expires }),
      ...(sameSite === undefined ? {} : { sameSite: sameSites[sameSite] }),
    });
    return { success: true };
  }
  if (cmd === "delete" || cmd === "clear") {
    const name = cmd === "delete" ? stringArg(args.name, "name") : undefined;
    for (const cookie of await all(url, storeId))
      if (name === undefined || cookie.name === name)
        await chrome.cookies.remove({
          url: cookieUrl(cookie),
          name: cookie.name,
          storeId: cookie.storeId,
          ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
        });
    return { success: true };
  }
  if (cmd !== "list") fail("invalid_args", "cookies cmd must be list/set/delete/clear");
  return { cookies: (await all(url, storeId)).map(view) };
}
