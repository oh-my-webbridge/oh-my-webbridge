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
