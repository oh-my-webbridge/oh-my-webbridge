import type { Args, Json } from "../protocol.js";

// Contract between the Firefox background and page.js, which runs in the
// ISOLATED world of each targeted document and works on the DOM only.
export type PageFile = { name: string; mimeType: string; data: string };
export type PageArgs = Omit<Args, "files"> & { files?: PageFile[] };
export type PageFailure = { ok: false; code: string; message: string };
export type PageResult = { ok: true; value: Json } | PageFailure;
export type PageEntry = (op: string, args: PageArgs) => Promise<PageResult>;

declare global {
  // Installed by page.js once per document.
  var __omwPage: PageEntry | undefined;
}
