import { addRef, clearRefs, enablePageEvents, send } from "./cdp.js";
import type { Args } from "./protocol.js";
import { scopes } from "./frames.js";

type AXNode = {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string | number | boolean };
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: { name: string; value: { value: string | number | boolean } }[];
};
export async function snapshot(
  tabId: number,
  options: Args = {},
): Promise<{ tree: string; truncated: boolean }> {
  const scope = scopes.get(tabId);
  // The references expire on the main frame's Page.frameNavigated (refEvent).
  await enablePageEvents(tabId);
  const result = await send<{ nodes: AXNode[] }>(
    tabId,
    "Accessibility.getFullAXTree",
    scope ? { frameId: scope.frameId } : {},
  );
  clearRefs(tabId);
  const generation = crypto.randomUUID().replaceAll("-", "");
  const byId = new Map(result.nodes.map((n) => [n.nodeId, n]));
  const lines: string[] = [];
  let count = 0;
  let size = 0;
  let truncated = false;
  const visit = (id: string, depth: number): void => {
    const n = byId.get(id);
    if (!n || depth > Math.min(64, options.maxDepth ?? 64) || truncated) return;
    const interactive = [
      "button",
      "link",
      "textbox",
      "combobox",
      "checkbox",
      "radio",
      "slider",
      "spinbutton",
      "menuitem",
      "tab",
      "switch",
    ].includes(n.role?.value ?? "");
    if (!n.ignored && (!options.interactive || interactive)) {
      if (count >= 4000 || size >= 192_000) {
        truncated = true;
        return;
      }
      const role = n.role?.value ?? "generic";
      const name = (n.name?.value ?? "").slice(0, 1000);
      const ref = n.backendDOMNodeId ? `@e${generation}.${count}` : "";
      if (ref && n.backendDOMNodeId) addRef(tabId, n.backendDOMNodeId, ref, scope);
      const props =
        n.properties
          ?.filter((p) =>
            ["checked", "selected", "expanded", "disabled", "required"].includes(p.name),
          )
          .map((p) => `${p.name}=${String(p.value.value)}`)
          .join(" ") ?? "";
      const line = `${"  ".repeat(Math.min(depth, 20))}${ref} ${role}${name ? ` ${JSON.stringify(name)}` : ""}${n.value ? ` value=${JSON.stringify(n.value.value).slice(0, 1000)}` : ""}${props ? ` [${props}]` : ""}`;
      lines.push(line);
      size += line.length;
      count++;
    }
    for (const child of n.childIds ?? []) visit(child, depth + (n.ignored ? 0 : 1));
  };
  if (result.nodes[0]) visit(result.nodes[0].nodeId, 0);
  return { tree: lines.join("\n"), truncated };
}
