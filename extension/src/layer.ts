import { attached, sendRoot } from "./cdp.js";
import { topDocument } from "./frames.js";
import { applyActivity, type ActivityState, type Rect } from "./overlay.js";

const source = applyActivity.toString();

// Chrome draws the activity layer through the tab's debugger session. Drawing
// never attaches the debugger on its own.
export async function paintChrome(tabId: number, state: ActivityState): Promise<void> {
  if (!attached(tabId)) return;
  const result = await sendRoot<{ exceptionDetails?: { text: string } }>(
    tabId,
    "Runtime.evaluate",
    { expression: `(${source})(${JSON.stringify(state)})` },
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
}

// The viewport rectangle of a content quad from DOM.getContentQuads, or
// undefined while a frame is selected: its coordinates are not the top page's.
export function quadRect(tabId: number, quad: number[]): Rect | undefined {
  if (!topDocument(tabId)) return undefined;
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
