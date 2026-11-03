import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform, env } from "node:process";
import type { Args, Browser, Json, Fault } from "../extension/src/protocol.js";

// `browser` sends every command to that browser's extension. Without it the
// daemon routes by the session's binding, then the only connected browser,
// then Chrome.
export async function connect(session: string, options: { browser?: Browser } = {}) {
  const { browser } = options;
  if (browser !== undefined && browser !== "chrome" && browser !== "firefox")
    throw new Error(`unsupported browser: ${String(browser)}`);
  const dir =
    env.OMW_HOME ??
    (platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "oh-my-webbridge")
      : join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "oh-my-webbridge"));
  const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as {
    token: string;
    address: string;
  };
  if (config.address !== "127.0.0.1:17373") throw new Error("unsupported daemon address");
  async function call<T = Json>(
    action: string,
    args: Args = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const response = await fetch(`http://${config.address}/command`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session, action, args, timeoutMs, ...(browser ? { browser } : {}) }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs + 5000)])
        : AbortSignal.timeout(timeoutMs + 5000),
    });
    // Replies and command errors are JSON; the daemon answers a rejected token,
    // Host or Origin with plain text, and another service may hold the port.
    if (!response.headers.get("content-type")?.startsWith("application/json"))
      throw Object.assign(
        new Error(`HTTP ${response.status}: ${(await response.text()).trim().slice(0, 200)}`),
        { code: "http_error" },
      );
    const result = (await response.json()) as { result?: T; error?: Fault };
    if (!response.ok || result.error)
      throw Object.assign(new Error(result.error?.message ?? `HTTP ${response.status}`), {
        code: result.error?.code ?? "http_error",
      });
    return result.result as T;
  }
  return {
    session,
    browser,
    call,
    navigate: (url: string, newTab = false) =>
      call<{ tabId: number; url: string }>("navigate", { url, newTab }),
    preset: (
      preset: NonNullable<Args["preset"]>,
      options: Pick<Args, "zen" | "environment"> = {},
    ) => call("preset", { preset, ...options }),
    snapshot: () => call<{ tree: string; url: string; title: string }>("snapshot"),
    click: (selector: string) => call("click", { selector }),
    fill: (selector: string, value: string) => call("fill", { selector, value }),
    evaluate: <T = Json>(code: string) =>
      call<{ type: string; value: T }>("evaluate", { code }).then((result) => result.value),
    cdp: <T = Json>(method: string, params: Args["params"] = {}, sessionId?: string) =>
      call<T>("cdp", { method, params, sessionId }),
    close: () => call("close_session"),
  };
}
