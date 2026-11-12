import { fail, type Args, type Json } from "../protocol.js";

// Contract between the Firefox background and page.js, which runs in the
// ISOLATED world of each targeted document and works on the DOM only.
export type PageFile = { name: string; mimeType: string; data: string };
export type PageArgs = Omit<Args, "files"> & { files?: PageFile[] };
export type PageFailure = { ok: false; code: string; message: string };
export type PageResult = { ok: true; value: Json } | PageFailure;
export type PageEntry = (op: string, args: PageArgs) => Promise<PageResult>;

// The background checks these arguments before it runs page.js, and page.js
// checks them again before it reads the page.
const getProperties = ["text", "html", "value", "attr", "box", "styles", "count", "title", "url"];
const storageCommands = ["list", "get", "set", "remove", "clear"];
export function checkGetProperty(property: string): void {
  if (!getProperties.includes(property))
    fail("invalid_args", `get property must be one of ${getProperties.join(", ")}`);
}
export function checkStorageCommand(cmd: string): void {
  if (!storageCommands.includes(cmd))
    fail("invalid_args", `storage cmd must be one of ${storageCommands.join(", ")}`);
}

declare global {
  // Installed by page.js once per document.
  var __omwPage: PageEntry | undefined;
}
