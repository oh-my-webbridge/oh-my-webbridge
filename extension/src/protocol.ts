export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type Args = {
  preset?: "anti-ad" | "zen" | "none";
  environment?: boolean;
  zen?: { images?: boolean; fonts?: boolean; css?: boolean; javascript?: boolean };
  url?: string;
  newTab?: boolean;
  group_title?: string;
  active?: boolean;
  tabId?: number;
  tab?: number;
  selector?: string;
  value?: string;
  code?: string;
  method?: string;
  params?: JsonObject;
  sessionId?: string;
  format?: "png" | "jpeg";
  quality?: number;
  fullPage?: boolean;
  path?: string;
  // Absolute paths; the daemon sends Firefox the file contents instead.
  files?: string[] | { name: string; mimeType: string; data: string }[];
  paper_format?: string;
  landscape?: boolean;
  scale?: number;
  print_background?: boolean;
  cmd?: string;
  filter?: string;
  requestId?: string;
  handle?: string;
  query?: string;
  text?: string;
  keys?: string;
  key?: string;
  x?: number;
  y?: number;
  button?: "left" | "right" | "middle";
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  state?: "visible" | "hidden";
  from?: string;
  to?: string;
  accept?: boolean;
  promptText?: string;
  contextId?: number;
  by?: "role" | "text" | "label" | "placeholder" | "alt" | "title" | "testid" | "css" | "xpath";
  name?: string;
  property?: string;
  attribute?: string;
  nth?: number;
  kind?: "local" | "session";
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
  latitude?: number;
  longitude?: number;
  colorScheme?: "dark" | "light";
  offline?: boolean;
  filename?: string;
  frameId?: string;
  expression?: string;
  load?: "load" | "domcontentloaded";
  diff?: boolean;
  interactive?: boolean;
  maxDepth?: number;
  steps?: { action: string; args?: Args }[];
  data?: JsonObject;
};
export type Browser = "chrome" | "firefox";
// The first frame on /extension. sessions lists the session names the
// extension holds (at most 128) so the daemon can restore session routing.
export type Hello = {
  type: "hello";
  protocol: 1;
  browser: Browser;
  browserVersion?: string;
  sessions: string[];
};
export type Command = { action: string; session: string; args?: Args; timeoutMs?: number };
export type Request = { type: "request"; id: string; command: Command; deadline: number };
// signal aborts when the request reaches its deadline or is cancelled. deadline
// is the request deadline in epoch milliseconds.
export type Budget = { signal: AbortSignal; check: () => void; deadline: number };
export type Fault = { code: string; message: string };
export function fail(code: string, message: string): never {
  throw { code, message } satisfies Fault;
}
export function fault(error: object | string | number | boolean | null | undefined): Fault {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    return { code: String(error.code), message: String(error.message) };
  }
  return {
    code: "browser_error",
    message: error instanceof Error ? error.message : (JSON.stringify(error) ?? "browser error"),
  };
}
export function stringArg(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !value) fail("invalid_args", `${name} is required`);
  return value;
}
// The deadline or a cancellation ended the command, and the browser may already
// have acted. reason is the abort reason that bridge.ts gives the request's
// signal, such as "the session was closed".
export function expired(reason?: unknown): never {
  const cause = typeof reason === "string" ? reason : "request deadline reached";
  fail("outcome_unknown", `${cause}; observe before retrying`);
}
// Resolves after ms, or fails with outcome_unknown when the request ends first.
export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  const stop = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => stop.resolve(false), ms);
  const abort = (): void => stop.resolve(true);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const aborted = await stop.promise;
  clearTimeout(timer);
  signal.removeEventListener("abort", abort);
  if (aborted) expired(signal.reason);
}
// wait stops polling this long before the request deadline, so that its own
// answer reaches the daemon before the daemon answers the deadline.
const waitReserve = 500;
function waitTimedOut(): never {
  fail("wait_timeout", "the wait condition did not hold before the deadline");
}
// Runs one check of a wait condition. wait does not change the page, so a
// condition that has not held when the reserve begins is a known result, even
// when a slow check is still running; that check is abandoned. Under a
// deadline of a second or less the reserve is half of the remaining time, so
// wait checks at least once.
export async function waitCheck<T>(budget: Budget, check: () => Promise<T>): Promise<T> {
  budget.check();
  const remaining = budget.deadline - Date.now();
  const left = remaining - Math.min(waitReserve, remaining / 2);
  if (left <= 0) waitTimedOut();
  const reserve = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    try {
      waitTimedOut();
    } catch (error) {
      reserve.reject(error);
    }
  }, left);
  try {
    return await Promise.race([check(), reserve.promise]);
  } finally {
    clearTimeout(timer);
  }
}
// Sleeps until wait checks its condition again.
export async function nextPoll(budget: Budget): Promise<void> {
  const left = budget.deadline - waitReserve - Date.now();
  if (left <= 0) waitTimedOut();
  await pause(Math.min(75, left), budget.signal);
}
