// Firefox WebExtension APIs and fields that @types/chrome does not declare.
// MDN documents each one under Mozilla/Add-ons/WebExtensions/API.

declare namespace chrome.tabs {
  interface Tab {
    // True while the tab shows a modal dialog (Firefox 63).
    attention?: boolean;
  }
  type CaptureTabOptions = {
    format?: "png" | "jpeg";
    quality?: number;
    // Document area in CSS pixels; may extend beyond the viewport.
    rect?: { x: number; y: number; width: number; height: number };
    scale?: number;
  };
  // Resolves with a data: URL of the captured image (Firefox 59).
  function captureTab(tabId: number, options?: CaptureTabOptions): Promise<string>;
}

declare namespace chrome.webRequest {
  interface WebRequestDetails {
    // URL of the document that loads the resource; absent for top-level documents.
    documentUrl?: string;
    // URL of the resource that triggered the request.
    originUrl?: string;
  }
  type StreamFilterData = { data: ArrayBuffer };
  interface StreamFilter {
    readonly error: string;
    ondata: ((event: StreamFilterData) => void) | null;
    onstop: (() => void) | null;
    onerror: (() => void) | null;
    write(data: ArrayBuffer | Uint8Array): void;
    close(): void;
    disconnect(): void;
  }
  // Requires webRequestBlocking and, in Manifest V3, webRequestFilterResponse.
  function filterResponseData(requestId: string): StreamFilter;
  // TLS details of an active request; undefined for an unknown requestId.
  function getSecurityInfo(requestId: string): Promise<object | undefined>;
}

declare namespace chrome.runtime {
  type BrowserInfo = { name: string; vendor: string; version: string; buildID: string };
  function getBrowserInfo(): Promise<BrowserInfo>;
  // frameId of a window or of an <iframe>/<frame> element, in content scripts.
  function getFrameId(target: Window | Element): number;
}
