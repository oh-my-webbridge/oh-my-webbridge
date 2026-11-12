// Page side of the Firefox extension, bundled as dist/extension-firefox/page.js.
// The background injects it into the ISOLATED world of a document and calls
// globalThis.__omwPage(op, args). Operations take the arguments of the Chrome
// action with the same name and return the same JSON. The element references of
// the last snapshot live in this world, keyed by a per-snapshot generation: a
// replaced document takes them along, and a page restored from the
// back-forward cache drops them.
import { snowflake } from "../id.js";
import { resolveElements } from "../locators.js";
import { fail, fault, stringArg, type Json } from "../protocol.js";
import {
  checkGetProperty,
  checkStorageCommand,
  type PageArgs,
  type PageFile,
  type PageResult,
} from "./page-api.js";

const interactiveRoles = new Set([
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
]);
const maxLines = 4000;
const maxBytes = 192_000;
const maxText = 1000;
// Elements that never render content.
const skipped = new Set([
  "base",
  "datalist",
  "head",
  "link",
  "meta",
  "noscript",
  "param",
  "script",
  "source",
  "style",
  "template",
  "title",
  "track",
]);
// Elements whose children are not part of the tree.
const leaves = new Set([
  "audio",
  "canvas",
  "embed",
  "frame",
  "iframe",
  "img",
  "input",
  "meter",
  "object",
  "option",
  "progress",
  "svg",
  "textarea",
  "video",
]);
// Elements without an ARIA role that still form a generic block.
const blockGeneric = new Set(["center", "div", "dl", "figcaption", "listing", "pre", "xmp"]);
const ariaRoles = new Set([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "mark",
  "marquee",
  "math",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "meter",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);
const nameFromContent = new Set([
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "DisclosureTriangle",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "rowheader",
  "switch",
  "tab",
  "term",
  "tooltip",
  "treeitem",
]);
const requiredRoles = new Set([
  "columnheader",
  "combobox",
  "gridcell",
  "listbox",
  "radiogroup",
  "rowheader",
  "searchbox",
  "spinbutton",
  "textbox",
  "tree",
  "treegrid",
]);
const checkedRoles = new Set(["checkbox", "menuitemcheckbox", "menuitemradio", "radio", "switch"]);
const rangeRoles = new Set(["meter", "progressbar", "scrollbar", "slider", "spinbutton"]);
// Input types whose value is not text the user typed.
const valuelessInputs = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "reset",
  "submit",
]);
// Single-line fields. Enter does not submit a form that has more than one of
// them and no submit button.
const implicitSubmitBlockers = new Set([
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "time",
  "url",
  "week",
]);
const mouseButtons = new Map([
  ["left", { button: 0, buttons: 1 }],
  ["middle", { button: 1, buttons: 4 }],
  ["right", { button: 2, buttons: 2 }],
]);
const scrollDirections = new Map([
  ["down", [0, 1]],
  ["up", [0, -1]],
  ["right", [1, 0]],
  ["left", [-1, 0]],
]);
const supportedKeys = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Tab",
  "Shift+Tab",
  "Control+a",
  "Meta+a",
]);
const keyCodes = new Map([
  ["Backspace", 8],
  ["Tab", 9],
  ["Enter", 13],
  ["Delete", 46],
  ["a", 65],
]);

type Entry = { node: Node; role: string };
type Point = { x: number; y: number; target: Element };
type Pointer = {
  x: number;
  y: number;
  button: number;
  buttons: number;
  detail: number;
  related: Element | null;
};

let generation = "";
let refs = new Map<string, Node>();
let hovered: Element | undefined;

function clearRefs(): void {
  generation = "";
  refs = new Map();
}
function messageOf(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? error.message : String(error);
}
function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

// Children in the flat tree: the open shadow root instead of the light
// children, and assigned nodes in place of a slot.
function flatChildren(node: Node): Node[] {
  if (node instanceof Element && node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
  if (node instanceof HTMLSlotElement) {
    const assigned = node.assignedNodes();
    return assigned.length ? assigned : Array.from(node.childNodes);
  }
  return Array.from(node.childNodes);
}
function composedParent(node: Node): Element | null {
  const parent = node.parentNode;
  return parent instanceof ShadowRoot ? parent.host : node.parentElement;
}
function ancestors(element: Element): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = element; node; node = composedParent(node)) chain.push(node);
  return chain;
}
function editingHost(element: Element): boolean {
  if (!(element instanceof HTMLElement) || !element.isContentEditable) return false;
  const parent = composedParent(element);
  return !(parent instanceof HTMLElement && parent.isContentEditable);
}
// Focusable by the user: an element with a tabindex attribute, a natively
// focusable element, or an editing host.
function focusable(element: Element): element is HTMLElement | SVGElement {
  return (
    (element instanceof HTMLElement || element instanceof SVGElement) &&
    !element.matches(":disabled") &&
    (element.hasAttribute("tabindex") ||
      element.matches(
        "a[href], area[href], button, input:not([type=hidden]), select, textarea, iframe, summary",
      ) ||
      editingHost(element))
  );
}
function visible(element: Element): boolean {
  return !!element.getClientRects().length && getComputedStyle(element).visibility !== "hidden";
}
function deepActive(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
function bodyText(): string {
  const body: HTMLElement | null = document.body;
  if (!body) fail("element_missing", "document has no body");
  return body.innerText;
}

// Roles follow HTML-AAM and ARIA, named like Chrome's accessibility tree where
// Chrome has names of its own (RootWebArea, StaticText, image, Iframe).
function inputRole(input: HTMLInputElement): string {
  switch (input.type) {
    case "button":
    case "color":
    case "file":
    case "image":
    case "reset":
    case "submit":
      return "button";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "range":
      return "slider";
    case "number":
      return "spinbutton";
    case "search":
      return input.list ? "combobox" : "searchbox";
  }
  return input.list ? "combobox" : "textbox";
}
function sectioned(element: Element): boolean {
  return (element.parentElement?.closest("article, aside, main, nav, section") ?? null) !== null;
}
function implicitRole(element: Element): string | undefined {
  const tag = element.localName;
  switch (tag) {
    case "a":
    case "area":
      return element.hasAttribute("href") ? "link" : undefined;
    case "address":
    case "details":
    case "fieldset":
    case "hgroup":
    case "optgroup":
      return "group";
    case "article":
      return "article";
    case "aside":
      return "complementary";
    case "audio":
    case "canvas":
    case "video":
      return "generic";
    case "blockquote":
      return "blockquote";
    case "button":
      return "button";
    case "caption":
      return "caption";
    case "code":
      return "code";
    case "dd":
      return "definition";
    case "del":
    case "s":
      return "deletion";
    case "dfn":
    case "dt":
      return "term";
    case "dialog":
      return "dialog";
    case "em":
      return "emphasis";
    case "figure":
      return "figure";
    case "footer":
      return sectioned(element) ? "sectionfooter" : "contentinfo";
    case "form":
      return "form";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "header":
      return sectioned(element) ? "sectionheader" : "banner";
    case "hr":
      return "separator";
    case "frame":
    case "iframe":
      return "Iframe";
    case "img":
      return element.getAttribute("alt") === "" ? undefined : "image";
    case "input":
      return element instanceof HTMLInputElement ? inputRole(element) : undefined;
    case "ins":
      return "insertion";
    case "li":
      return "listitem";
    case "main":
      return "main";
    case "mark":
      return "mark";
    case "math":
      return "math";
    case "menu":
    case "ol":
    case "ul":
      return "list";
    case "meter":
      return "meter";
    case "nav":
      return "navigation";
    case "option":
      return "option";
    case "output":
      return "status";
    case "p":
      return "paragraph";
    case "progress":
      return "progressbar";
    case "search":
      return "search";
    case "section":
      return ownName(element) ? "region" : "generic";
    case "select":
      return element instanceof HTMLSelectElement && (element.multiple || element.size > 1)
        ? "listbox"
        : "combobox";
    case "strong":
      return "strong";
    case "sub":
      return "subscript";
    case "summary":
      return "DisclosureTriangle";
    case "sup":
      return "superscript";
    case "svg":
      return "image";
    case "table":
      return "table";
    case "tbody":
    case "tfoot":
    case "thead":
      return "rowgroup";
    case "td":
      return "cell";
    case "textarea":
      return "textbox";
    case "th":
      return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
    case "time":
      return "time";
    case "tr":
      return "row";
  }
  return blockGeneric.has(tag) ? "generic" : undefined;
}
// undefined means the element adds no node of its own; its children still do.
function roleOf(element: Element): string | undefined {
  const explicit = (element.getAttribute("role") ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .find((token) => ariaRoles.has(token));
  if (explicit === "none" || explicit === "presentation")
    return focusable(element) ? implicitRole(element) : undefined;
  if (explicit) return explicit === "img" ? "image" : explicit;
  const role = implicitRole(element);
  if (role === undefined && (focusable(element) || ownName(element) || editingHost(element)))
    return "generic";
  return role;
}

// Visits the accessible nodes of this document in tree order, starting with
// the RootWebArea at depth 0. Hidden subtrees are skipped; elements without a
// role pass their depth on to their children. visit returns false to stop.
function walkTree(maxDepth: number, visit: (entry: Entry, depth: number) => boolean): void {
  let stopped = false;
  const step = (node: Node, depth: number, shown: boolean): void => {
    if (stopped || depth > maxDepth) return;
    if (node instanceof Text) {
      if (shown && node.data.trim()) stopped = !visit({ node, role: "StaticText" }, depth);
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.localName;
    if (skipped.has(tag) || node.getAttribute("aria-hidden") === "true") return;
    if (node instanceof HTMLInputElement && node.type === "hidden") return;
    const style = getComputedStyle(node);
    if (style.display === "none") return;
    const nodeShown = style.visibility !== "hidden" && style.visibility !== "collapse";
    const role = roleOf(node);
    let next = depth;
    if (nodeShown && role && !(style.display === "contents" && role === "generic")) {
      stopped = !visit({ node, role }, depth);
      next = depth + 1;
    }
    if (leaves.has(tag)) return;
    // A closed details element renders only its summary.
    const children =
      node instanceof HTMLDetailsElement && !node.open
        ? Array.from(node.children)
            .filter((child) => child.localName === "summary")
            .slice(0, 1)
        : flatChildren(node);
    for (const child of children) step(child, next, nodeShown);
  };
  if (maxDepth < 0 || !visit({ node: document.documentElement, role: "RootWebArea" }, 0)) return;
  for (const child of flatChildren(document.documentElement)) step(child, 1, true);
}

// Accessible names follow a subset of accname-1.2: aria-labelledby,
// aria-label, native labels, content for roles named by their content, title
// and placeholder.
function ownName(element: Element): string {
  return labelledBy(element) || collapse(element.getAttribute("aria-label") ?? "");
}
function labelledBy(element: Element): string {
  const ids = element.getAttribute("aria-labelledby");
  const root = element.getRootNode();
  if (!ids || !(root instanceof Document || root instanceof ShadowRoot)) return "";
  return collapse(
    ids
      .split(/\s+/u)
      .map((id) => {
        const target = id ? root.getElementById(id) : null;
        return target ? referencedText(target) : "";
      })
      .join(" "),
  );
}
function referencedText(element: Element): string {
  const label = collapse(element.getAttribute("aria-label") ?? "");
  if (label) return label;
  return controlText(element) ?? contentText(element, true);
}
// The text an embedded control contributes to a name.
function controlText(element: Element): string | undefined {
  if (element instanceof HTMLInputElement)
    return valuelessInputs.has(element.type) ? undefined : element.value;
  if (element instanceof HTMLTextAreaElement) return element.value;
  if (element instanceof HTMLSelectElement) return element.selectedOptions[0]?.label ?? "";
  return undefined;
}
function imageText(element: Element): string | undefined {
  if (element instanceof HTMLImageElement || element instanceof HTMLAreaElement)
    return collapse(element.alt);
  if (element instanceof SVGSVGElement) {
    const title = Array.from(element.children).find((child) => child.localName === "title");
    return collapse(title?.textContent ?? "");
  }
  return undefined;
}
// Rendered text of an element's content: text nodes, aria-label and values of
// embedded controls, image alternatives, and spaces around block children.
// Stops after maxText characters.
function contentText(root: Element, includeHidden: boolean, skip?: Element): string {
  const parts: string[] = [];
  let length = 0;
  const add = (text: string): void => {
    parts.push(text);
    length += text.length;
  };
  const walk = (node: Node): void => {
    for (const child of flatChildren(node)) {
      if (length > maxText) return;
      if (child instanceof Text) {
        add(child.data);
        continue;
      }
      if (!(child instanceof Element) || child === skip || skipped.has(child.localName)) continue;
      if (child.localName === "br") {
        add(" ");
        continue;
      }
      const style = getComputedStyle(child);
      if (
        !includeHidden &&
        (child.getAttribute("aria-hidden") === "true" ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse")
      )
        continue;
      const block = !style.display.startsWith("inline") && style.display !== "contents";
      if (block) add(" ");
      const own =
        collapse(child.getAttribute("aria-label") ?? "") || controlText(child) || imageText(child);
      if (own) add(own);
      else walk(child);
      if (block) add(" ");
    }
  };
  walk(root);
  return collapse(parts.join("")).slice(0, maxText);
}
function labelsText(control: Element, labels: NodeListOf<HTMLLabelElement> | null): string {
  return collapse(
    Array.from(labels ?? [], (label) => contentText(label, false, control)).join(" "),
  );
}
function nativeName(element: Element): string {
  if (element instanceof HTMLInputElement) {
    if (element.type === "button") return collapse(element.value);
    if (element.type === "submit") return collapse(element.value) || "Submit";
    if (element.type === "reset") return collapse(element.value) || "Reset";
    if (element.type === "image")
      return (
        collapse(element.alt) || collapse(element.value) || collapse(element.title) || "Submit"
      );
    return labelsText(element, element.labels);
  }
  if (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLMeterElement ||
    element instanceof HTMLOutputElement ||
    element instanceof HTMLProgressElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  )
    return labelsText(element, element.labels);
  if (element instanceof HTMLFieldSetElement) {
    const legend = Array.from(element.children).find((child) => child instanceof HTMLLegendElement);
    return legend ? contentText(legend, false) : "";
  }
  if (element instanceof HTMLTableElement)
    return element.caption ? contentText(element.caption, false) : "";
  if (element instanceof HTMLOptionElement || element instanceof HTMLOptGroupElement)
    return collapse(element.label);
  return imageText(element) ?? "";
}
function accessibleName(element: Element, role: string): string {
  const name =
    ownName(element) ||
    nativeName(element) ||
    (nameFromContent.has(role) ? contentText(element, false) : "") ||
    collapse(element.getAttribute("title") ?? "") ||
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? collapse(element.placeholder)
      : "");
  return name.slice(0, maxText);
}
function nameOf(entry: Entry): string {
  if (entry.node instanceof Text) return collapse(entry.node.data).slice(0, maxText);
  if (entry.role === "RootWebArea") return collapse(document.title).slice(0, maxText);
  return entry.node instanceof Element ? accessibleName(entry.node, entry.role) : "";
}

function numeric(text: string): Json | undefined {
  if (!text.trim()) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : text;
}
function valueOf(element: Element, role: string): Json | undefined {
  if (element instanceof HTMLInputElement) {
    if (role === "slider" || role === "spinbutton") return numeric(element.value);
    if (element.type === "password")
      return element.value ? "\u2022".repeat(element.value.length) : undefined;
    return controlText(element) || undefined;
  }
  if (element instanceof HTMLTextAreaElement) return element.value || undefined;
  if (element instanceof HTMLSelectElement)
    return role === "combobox" ? element.selectedOptions[0]?.label || undefined : undefined;
  if (element instanceof HTMLProgressElement)
    return element.position < 0 ? undefined : element.value;
  if (element instanceof HTMLMeterElement) return element.value;
  const now = element.getAttribute("aria-valuenow");
  if (now !== null && rangeRoles.has(role)) return numeric(now);
  if (editingHost(element)) return collapse(element.textContent ?? "") || undefined;
  return undefined;
}
function checkedOf(element: Element): string {
  if (
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
  )
    return element.type === "checkbox" && element.indeterminate ? "mixed" : String(element.checked);
  const state = element.getAttribute("aria-checked");
  return state === "true" || state === "mixed" ? state : "false";
}
function propsOf(element: Element, role: string): string {
  const props: string[] = [];
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true")
    props.push("disabled=true");
  if (requiredRoles.has(role)) {
    const required =
      ("required" in element && element.required === true) ||
      element.getAttribute("aria-required") === "true";
    props.push("required=" + String(required));
  }
  if (checkedRoles.has(role)) props.push("checked=" + checkedOf(element));
  const expanded = element.getAttribute("aria-expanded");
  if (expanded === "true" || expanded === "false") props.push("expanded=" + expanded);
  else if (element instanceof HTMLSelectElement && role === "combobox")
    props.push("expanded=false");
  else if (role === "DisclosureTriangle" && element.parentElement instanceof HTMLDetailsElement)
    props.push("expanded=" + String(element.parentElement.open));
  if (role === "option")
    props.push(
      "selected=" +
        String(
          element instanceof HTMLOptionElement
            ? element.selected
            : element.getAttribute("aria-selected") === "true",
        ),
    );
  else if (role === "tab" || role === "treeitem")
    props.push("selected=" + String(element.getAttribute("aria-selected") === "true"));
  return props.join(" ");
}

// Same line format, reference numbering and limits as extension/src/snapshot.ts.
function snapshot(args: PageArgs): { tree: string; truncated: boolean } {
  clearRefs();
  generation = snowflake();
  const lines: string[] = [];
  let size = 0;
  let truncated = false;
  walkTree(Math.min(64, args.maxDepth ?? 64), (entry, depth) => {
    if (args.interactive && !interactiveRoles.has(entry.role)) return true;
    if (lines.length >= maxLines || size >= maxBytes) {
      truncated = true;
      return false;
    }
    const ref = "@e" + generation + "." + String(lines.length);
    refs.set(ref, entry.node);
    const element =
      entry.node instanceof Element && entry.role !== "RootWebArea" ? entry.node : undefined;
    const name = nameOf(entry);
    const value = element ? valueOf(element, entry.role) : undefined;
    const props = element ? propsOf(element, entry.role) : "";
    const line =
      "  ".repeat(Math.min(depth, 20)) +
      ref +
      " " +
      entry.role +
      (name ? " " + JSON.stringify(name) : "") +
      (value === undefined ? "" : " value=" + JSON.stringify(value).slice(0, maxText)) +
      (props ? " [" + props + "]" : "");
    lines.push(line);
    size += line.length;
    return true;
  });
  return { tree: lines.join("\n"), truncated };
}
function find(args: PageArgs): Json {
  const query = stringArg(args.query, "query").toLocaleLowerCase();
  const snap = snapshot(args);
  return {
    matches: snap.tree
      .split("\n")
      .filter((line) => line.toLocaleLowerCase().includes(query))
      .slice(0, 100),
    truncated: snap.truncated,
  };
}

function refNode(selector: string): Node {
  const node = refs.get(selector);
  if (!node) fail("stale_ref", "element reference expired; take a fresh snapshot");
  if (!node.isConnected) fail("stale_ref", "element no longer exists");
  return node;
}
// role=ROLE[name="NAME"] >>nth=N matches the role and exact name computed for
// the snapshot.
function roleNodes(selector: string): Node[] {
  const match = selector.match(/^role=([^[]+?)(?:\[name=(.+)\])?(?:\s*>>\s*nth=(-?\d+))?$/u);
  if (!match) fail("invalid_args", 'role syntax: role=button[name="Submit"] >>nth=0');
  const [, role, quoted, nth] = match;
  let name: Json | undefined;
  if (quoted !== undefined) {
    try {
      name = JSON.parse(quoted);
    } catch {
      fail("invalid_args", "role name must be a JSON string");
    }
    if (typeof name !== "string") fail("invalid_args", "role name must be a JSON string");
  }
  const matches: Node[] = [];
  walkTree(Infinity, (entry) => {
    if (entry.role === role && (name === undefined || nameOf(entry) === name))
      matches.push(entry.node);
    return true;
  });
  if (nth === undefined) return matches;
  const selected = matches.at(Number(nth));
  return selected ? [selected] : [];
}
function located(selector: string): Node[] {
  if (selector.startsWith("@e")) return [refNode(selector)];
  if (selector.startsWith("role=")) return roleNodes(selector);
  try {
    return resolveElements(selector);
  } catch (error) {
    fail("invalid_args", selector + ": " + messageOf(error));
  }
}
// A StaticText reference acts on the element that contains the text.
function elementOf(node: Node): Element {
  if (node instanceof Element) return node;
  const parent = composedParent(node);
  if (!parent) fail("stale_ref", "element no longer exists");
  return parent;
}
function elementAt(selector: string): Element {
  const node = located(selector)[0];
  if (!node) fail("element_missing", "no element matches " + selector);
  return elementOf(node);
}

const locateCommands = new Set([
  "get",
  "is",
  "click",
  "dblclick",
  "fill",
  "check",
  "uncheck",
  "focus",
  "hover",
  "scroll",
  "key_type",
]);
function locate(args: PageArgs): Json {
  const cmd = args.cmd ?? "get";
  if (!locateCommands.has(cmd)) fail("invalid_args", "locate cmd must be an element action");
  const by = args.by ?? "css";
  const value = stringArg(args.value, "value");
  let selector =
    by === "role"
      ? "role=" + value + (args.name ? "[name=" + JSON.stringify(args.name) + "]" : "")
      : by + "=" + value;
  if (args.nth !== undefined) {
    if (!Number.isInteger(args.nth)) fail("invalid_args", "nth must be an integer");
    selector += " >>nth=" + String(args.nth);
  }
  return run(cmd, { ...args, selector, value: args.text, property: args.property ?? "text" });
}

function get(args: PageArgs): Json {
  const property = args.property ?? "text";
  checkGetProperty(property);
  if (property === "title") return { value: document.title };
  if (property === "url") return { value: location.href };
  const selector = stringArg(args.selector, "selector");
  if (property === "count") return { value: located(selector).length };
  const element = elementAt(selector);
  switch (property) {
    case "text":
      return { value: element instanceof HTMLElement ? element.innerText : element.textContent };
    case "html":
      return { value: element.innerHTML };
    case "value": {
      const value = "value" in element ? element.value : null;
      return { value: typeof value === "string" || typeof value === "number" ? value : null };
    }
    case "attr":
      return { value: element.getAttribute(args.attribute ?? "") };
    case "box": {
      const box = element.getBoundingClientRect();
      return { value: { x: box.x, y: box.y, width: box.width, height: box.height } };
    }
    case "styles": {
      const style = getComputedStyle(element);
      return {
        value: Object.fromEntries(Array.from(style, (key) => [key, style.getPropertyValue(key)])),
      };
    }
  }
  fail("invalid_args", "unsupported get property " + property);
}
function is(args: PageArgs): Json {
  const property = args.property ?? "visible";
  if (!["visible", "enabled", "checked", "editable"].includes(property))
    fail("invalid_args", "unsupported state property");
  const element = elementAt(stringArg(args.selector, "selector"));
  if (property === "visible") return { value: visible(element) };
  if (property === "enabled") return { value: !element.matches(":disabled,[aria-disabled=true]") };
  if (property === "checked")
    return {
      value:
        ("checked" in element && element.checked === true) ||
        element.getAttribute("aria-checked") === "true",
    };
  return {
    value:
      (element instanceof HTMLElement && element.isContentEditable) ||
      (!("readOnly" in element && element.readOnly === true) &&
        !("disabled" in element && element.disabled === true) &&
        "value" in element),
  };
}
function focusOn(element: Element): void {
  if (element instanceof HTMLElement || element instanceof SVGElement) element.focus();
  const active = deepActive();
  // A shadow host that delegates focus passes it to an element inside.
  if (
    !active ||
    !(active === element || (element.shadowRoot !== null && ancestors(active).includes(element)))
  )
    fail("element_action_failed", "element is not focusable");
}
function check(args: PageArgs, expected: boolean): Json {
  const element = elementAt(stringArg(args.selector, "selector"));
  if (
    !(element instanceof HTMLInputElement) ||
    !["checkbox", "radio"].includes(element.type) ||
    (!expected && element.type === "radio")
  )
    fail("invalid_args", "expected checkbox (radio supports check only)");
  if (element.checked !== expected) {
    element.focus();
    element.click();
  }
  if (element.checked !== expected)
    fail("state_mismatch", "control did not reach requested checked state");
  return { success: true, checked: expected };
}
function selectOption(args: PageArgs): Json {
  const selector = stringArg(args.selector, "selector");
  const value = stringArg(args.value, "value");
  const element = elementAt(selector);
  if (!(element instanceof HTMLSelectElement)) fail("element_action_failed", "expected select");
  const option = Array.from(element.options).find((o) => o.value === value || o.text === value);
  if (!option) fail("element_action_failed", "option not found");
  element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { success: true, value: element.value };
}
function storage(args: PageArgs): Json {
  const cmd = args.cmd ?? "list";
  checkStorageCommand(cmd);
  const store = args.kind === "session" ? sessionStorage : localStorage;
  const name = args.name ?? "";
  if (cmd === "set") store.setItem(name, args.value ?? "");
  else if (cmd === "remove") store.removeItem(name);
  else if (cmd === "clear") store.clear();
  const entries = Array.from({ length: store.length }, (_, index): [string, string] => {
    const key = store.key(index) ?? "";
    return [key, store.getItem(key) ?? ""];
  });
  return {
    origin: location.origin,
    kind: args.kind ?? "local",
    value: cmd === "get" ? store.getItem(name) : Object.fromEntries(entries),
  };
}

// Text editing goes through document.execCommand: called from the ISOLATED
// world it produces trusted beforeinput and input events.
function edit(command: string, value?: string): void {
  if (!document.execCommand(command, false, value))
    fail("element_action_failed", "Firefox did not run " + command + " on the focused element");
}
function editable(element: Element): boolean {
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return (
    ((element instanceof HTMLInputElement && !valuelessInputs.has(element.type)) ||
      element instanceof HTMLTextAreaElement) &&
    !element.readOnly &&
    !element.disabled
  );
}
function editingHostOf(element: Element): HTMLElement | undefined {
  for (let node: Element | null = element; node; node = composedParent(node))
    if (node instanceof HTMLElement && editingHost(node)) return node;
  return undefined;
}
function selectNode(node: Node): void {
  const selection = getSelection();
  if (!selection) fail("element_action_failed", "document has no selection");
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}
function fill(args: PageArgs): Json {
  const selector = stringArg(args.selector, "selector");
  const value = args.value;
  if (typeof value !== "string") fail("invalid_args", "value must be a string");
  const element = elementAt(selector);
  let empty: boolean;
  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus();
    selectNode(element);
    empty = !element.textContent;
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    element.select();
    empty = !element.value;
  } else fail("element_action_failed", "element is not editable");
  if (value) edit("insertText", value);
  else if (!empty) edit("delete");
  return { success: true };
}
function keyType(args: PageArgs): Json {
  const text = stringArg(args.text, "text");
  if (args.selector) focusOn(elementAt(args.selector));
  // Firefox reports success for insertText even when nothing editable has focus.
  const active = deepActive();
  if (!active || !editable(active))
    fail("element_action_failed", "key_type needs a focused editable element; pass a selector");
  edit("insertText", text);
  return { success: true };
}

function submitImplicitly(input: HTMLInputElement): void {
  const form = input.form;
  if (!form) return;
  const controls = Array.from(form.elements);
  const button = controls.find(
    (control) =>
      (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) &&
      (control.type === "submit" || control.type === "image"),
  );
  if (button instanceof HTMLElement) {
    if (!button.matches(":disabled")) button.click();
    return;
  }
  const fields = controls.filter(
    (control) => control instanceof HTMLInputElement && implicitSubmitBlockers.has(control.type),
  );
  if (fields.length <= 1) form.requestSubmit();
}
function activatedByEnter(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLButtonElement ||
    (element instanceof HTMLAnchorElement && element.hasAttribute("href")) ||
    (element instanceof HTMLElement && element.localName === "summary") ||
    (element instanceof HTMLInputElement &&
      ["button", "image", "reset", "submit"].includes(element.type))
  );
}
function tabOrder(): (HTMLElement | SVGElement)[] {
  const found: (HTMLElement | SVGElement)[] = [];
  const visit = (node: Node): void => {
    for (const child of flatChildren(node)) {
      if (!(child instanceof Element) || skipped.has(child.localName)) continue;
      if (child instanceof HTMLElement && child.inert) continue;
      if (focusable(child) && child.tabIndex >= 0 && visible(child)) found.push(child);
      visit(child);
    }
  };
  visit(document);
  return [
    ...found.filter((element) => element.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex),
    ...found.filter((element) => element.tabIndex === 0),
  ];
}
function moveFocus(step: number): void {
  const order = tabOrder();
  const active = deepActive();
  const index = order.findIndex((element) => element === active);
  const next =
    index < 0 ? (step > 0 ? order[0] : order.at(-1)) : order.at((index + step) % order.length);
  next?.focus();
}
// The browser's default action for each supported key.
function keyAction(combo: string, target: Element): void {
  if (combo === "Backspace" || combo === "Delete") {
    if (editable(target)) edit(combo === "Backspace" ? "delete" : "forwardDelete");
  } else if (combo === "Control+a" || combo === "Meta+a") {
    const host = editingHostOf(target);
    const body: HTMLElement | null = document.body;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      target.select();
    else selectNode(host ?? body ?? document.documentElement);
  } else if (combo === "Enter") {
    if (target instanceof HTMLTextAreaElement) {
      if (editable(target)) edit("insertText", "\n");
    } else if (target instanceof HTMLElement && target.isContentEditable) edit("insertParagraph");
    else if (target instanceof HTMLInputElement && implicitSubmitBlockers.has(target.type))
      submitImplicitly(target);
    else if (activatedByEnter(target)) target.click();
  } else moveFocus(combo === "Shift+Tab" ? -1 : 1);
}
function sendKeys(args: PageArgs): Json {
  const keys = stringArg(args.keys ?? args.key, "keys");
  const parts = keys.split("+");
  const last = parts.at(-1) ?? "";
  const key = last === "A" ? "a" : last;
  const modifiers = parts.slice(0, -1);
  const combo = [...modifiers, key].join("+");
  if (!supportedKeys.has(combo))
    fail("unsupported", "send_keys " + keys + " is not available in Firefox");
  const target = deepActive() ?? document.documentElement;
  const init: KeyboardEventInit = {
    key,
    code: key === "a" ? "KeyA" : key,
    keyCode: keyCodes.get(key) ?? 0,
    bubbles: true,
    cancelable: true,
    composed: true,
    shiftKey: modifiers.includes("Shift"),
    ctrlKey: modifiers.includes("Control"),
    metaKey: modifiers.includes("Meta"),
  };
  // The page receives untrusted key events. The default action follows
  // unless the page cancels keydown or keypress.
  let proceed = target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (proceed && key === "Enter")
    proceed = target.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: 13 }));
  if (proceed) keyAction(combo, target);
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  return { success: true };
}

// Pointer input is dispatched as untrusted events. element.click() runs the
// activation behavior of links, buttons and form controls.
function fire(target: Element, type: string, at: Pointer): boolean {
  const boundary = type.endsWith("enter") || type.endsWith("leave");
  const init: PointerEventInit = {
    bubbles: !boundary,
    cancelable: !boundary,
    composed: !boundary,
    clientX: at.x,
    clientY: at.y,
    button: at.button,
    buttons: at.buttons,
    detail: at.detail,
    relatedTarget: at.related,
  };
  return target.dispatchEvent(
    type.startsWith("pointer")
      ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true })
      : new MouseEvent(type, init),
  );
}
function deepest(hit: Element, x: number, y: number): Element {
  let target = hit;
  for (;;) {
    const root = target.shadowRoot;
    const inner = root?.elementFromPoint(x, y);
    if (!root || !inner || inner === target || !root.contains(inner)) return target;
    target = inner;
  }
}
// Same visibility rule as Chrome: the center of the element's visible part
// must hit the element or one of its descendants.
function pointFor(element: Element): Point {
  element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const box = element.getBoundingClientRect();
  const x = (Math.max(0, box.left) + Math.min(box.right, window.innerWidth)) / 2;
  const y = (Math.max(0, box.top) + Math.min(box.bottom, window.innerHeight)) / 2;
  const root = element.getRootNode();
  const hit =
    (root instanceof ShadowRoot ? root.elementFromPoint(x, y) : null) ??
    document.elementFromPoint(x, y);
  if (!box.width || !box.height)
    fail("element_hidden", "element has no box: it is not rendered or has no size");
  if (!hit || !(hit === element || element.contains(hit)))
    fail("element_action_failed", "element is covered: another element is at its center");
  return { x, y, target: deepest(hit, x, y) };
}
function pointAt(x: number | undefined, y: number | undefined): Point {
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y))
    fail("invalid_args", "selector or finite x/y coordinates required");
  const hit = document.elementFromPoint(x, y);
  if (!hit) fail("element_missing", "no element at " + String(x) + "," + String(y));
  return { x, y, target: deepest(hit, x, y) };
}
function moveTo({ x, y, target }: Point): void {
  const at = (related: Element | null): Pointer => ({
    x,
    y,
    button: 0,
    buttons: 0,
    detail: 0,
    related,
  });
  const previous = hovered?.isConnected ? hovered : undefined;
  if (previous !== target) {
    const left = previous ? ancestors(previous) : [];
    const entered = ancestors(target);
    if (previous) {
      fire(previous, "pointerout", at(target));
      fire(previous, "mouseout", at(target));
      for (const node of left)
        if (!entered.includes(node)) {
          fire(node, "pointerleave", at(target));
          fire(node, "mouseleave", at(target));
        }
    }
    fire(target, "pointerover", at(previous ?? null));
    fire(target, "mouseover", at(previous ?? null));
    for (const node of entered.toReversed())
      if (!left.includes(node)) {
        fire(node, "pointerenter", at(previous ?? null));
        fire(node, "mouseenter", at(previous ?? null));
      }
    hovered = target;
  }
  fire(target, "pointermove", at(null));
  fire(target, "mousemove", at(null));
}
// A mouse press moves focus to the closest focusable ancestor, or clears it.
function focusFrom(target: Element): void {
  for (let node: Element | null = target; node; node = composedParent(node))
    if (focusable(node) || editingHost(node)) {
      if (deepActive() !== node && (node instanceof HTMLElement || node instanceof SVGElement))
        node.focus();
      return;
    }
  const active = deepActive();
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}
function click(args: PageArgs, count: number): Json {
  const pressed = mouseButtons.get(args.button ?? "left");
  if (!pressed) fail("invalid_args", "button must be left, right or middle");
  const point = args.selector ? pointFor(elementAt(args.selector)) : pointAt(args.x, args.y);
  const { x, y, target } = point;
  moveTo(point);
  for (let detail = 1; detail <= count; detail++) {
    const at = (buttons: number): Pointer => ({
      x,
      y,
      button: pressed.button,
      buttons,
      detail,
      related: null,
    });
    const pointerDown = fire(target, "pointerdown", at(pressed.buttons));
    if (pointerDown && fire(target, "mousedown", at(pressed.buttons))) focusFrom(target);
    fire(target, "pointerup", at(0));
    if (pointerDown) fire(target, "mouseup", at(0));
    if (pressed.button === 1) fire(target, "auxclick", at(0));
    else if (pressed.button === 2) fire(target, "contextmenu", at(0));
    else if (target instanceof HTMLElement) target.click();
    else fire(target, "click", at(0));
  }
  if (count === 2 && pressed.button === 0)
    fire(target, "dblclick", { x, y, button: 0, buttons: 0, detail: 2, related: null });
  return { success: true };
}
function hover(args: PageArgs): Json {
  moveTo(pointFor(elementAt(stringArg(args.selector, "selector"))));
  return { success: true };
}
function scrollableFrom(start: Element, dx: number, dy: number): Element | undefined {
  for (let node: Element | null = start; node; node = composedParent(node)) {
    if (node === document.documentElement || node === document.body) return undefined;
    const style = getComputedStyle(node);
    const scrolls = (overflow: string): boolean => /^(auto|scroll|overlay)$/u.test(overflow);
    if (
      (dy !== 0 && scrolls(style.overflowY) && node.scrollHeight > node.clientHeight) ||
      (dx !== 0 && scrolls(style.overflowX) && node.scrollWidth > node.clientWidth)
    )
      return node;
  }
  return undefined;
}
function scroll(args: PageArgs): Json {
  if (args.selector) {
    elementAt(args.selector).scrollIntoView({ block: "center", behavior: "instant" });
    return { success: true };
  }
  const amount = args.amount ?? 600;
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000)
    fail("invalid_args", "amount must be 0–100000");
  const direction = scrollDirections.get(args.direction ?? "down");
  if (!direction) fail("invalid_args", "direction must be up, down, left or right");
  const x = args.x ?? 200;
  const y = args.y ?? 200;
  if (!Number.isFinite(x) || !Number.isFinite(y)) fail("invalid_args", "x and y must be finite");
  const dx = (direction[0] ?? 0) * amount;
  const dy = (direction[1] ?? 0) * amount;
  const hit = document.elementFromPoint(x, y);
  const scroller = hit ? scrollableFrom(deepest(hit, x, y), dx, dy) : undefined;
  (scroller ?? window).scrollBy({ left: dx, top: dy, behavior: "instant" });
  return { success: true };
}

function fileBytes(file: PageFile): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(file.data);
  } catch (error) {
    fail("invalid_args", file.name + ": data is not base64 (" + messageOf(error) + ")");
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
// The daemon has replaced the host paths with the file contents.
function upload(args: PageArgs): Json {
  const files = args.files;
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.some(
      (file) =>
        typeof file.name !== "string" ||
        typeof file.mimeType !== "string" ||
        typeof file.data !== "string",
    )
  )
    fail("invalid_args", "files must be non-empty {name, mimeType, data} objects");
  const element = elementAt(stringArg(args.selector, "selector"));
  if (!(element instanceof HTMLInputElement) || element.type !== "file")
    fail("element_action_failed", "expected input type=file");
  if (files.length > 1 && !element.multiple)
    fail("invalid_args", "the file input accepts one file");
  const transfer = new DataTransfer();
  for (const file of files)
    transfer.items.add(new File([fileBytes(file)], file.name, { type: file.mimeType }));
  element.files = transfer.files;
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { success: true, fileCount: files.length };
}
// One check of a wait condition; the background repeats it until the deadline.
function wait(args: PageArgs): Json {
  let matched: boolean;
  if (args.selector) {
    const node = located(args.selector)[0];
    matched = node !== undefined && visible(elementOf(node));
  } else if (args.load)
    matched =
      args.load === "load" ? document.readyState === "complete" : document.readyState !== "loading";
  // A document that has no body yet does not contain the text.
  else if (args.text) matched = (document.body?.innerText ?? "").includes(args.text);
  else if (args.url) {
    const pattern =
      "^" +
      args.url
        .split("*")
        .map((part) => part.replace(/[.*+?^$(){}|[\]\\]/gu, "\\$&"))
        .join(".*") +
      "$";
    matched = new RegExp(pattern, "u").test(location.href);
  } else fail("invalid_args", "wait requires selector, expression, load, text or url");
  return { matched };
}
// Document coordinates in CSS pixels for tabs.captureTab.
// The element's box in viewport coordinates, for the activity layer's focus frame.
function box(args: PageArgs): Json {
  const bounds = elementAt(stringArg(args.selector, "selector")).getBoundingClientRect();
  return { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
}
function rect(args: PageArgs): Json {
  if (args.selector) {
    const box = elementAt(args.selector).getBoundingClientRect();
    return {
      x: box.x + window.scrollX,
      y: box.y + window.scrollY,
      width: box.width,
      height: box.height,
    };
  }
  if (args.fullPage) {
    const root = document.documentElement;
    const body: HTMLElement | null = document.body;
    return {
      x: 0,
      y: 0,
      width: Math.max(root.scrollWidth, body?.scrollWidth ?? 0),
      height: Math.max(root.scrollHeight, body?.scrollHeight ?? 0),
    };
  }
  const viewport = window.visualViewport;
  if (!viewport) fail("browser_error", "the window has no visual viewport");
  return {
    x: viewport.pageLeft,
    y: viewport.pageTop,
    width: viewport.width,
    height: viewport.height,
  };
}
function frame(args: PageArgs): Json {
  const element = elementAt(stringArg(args.selector, "selector"));
  if (!(element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement))
    fail("frame_missing", "select frame by selector/frameId/name/url");
  return { frameId: chrome.runtime.getFrameId(element) };
}

function run(op: string, args: PageArgs): Json {
  switch (op) {
    case "snapshot":
      return snapshot(args);
    case "find":
      return find(args);
    case "read_page":
      return { url: location.href, title: document.title, text: bodyText().slice(0, maxBytes) };
    case "locate":
      return locate(args);
    case "get":
      return get(args);
    case "is":
      return is(args);
    case "focus":
      focusOn(elementAt(stringArg(args.selector, "selector")));
      return { success: true };
    case "check":
      return check(args, true);
    case "uncheck":
      return check(args, false);
    case "select_option":
      return selectOption(args);
    case "storage":
      return storage(args);
    case "fill":
      return fill(args);
    case "key_type":
      return keyType(args);
    case "send_keys":
      return sendKeys(args);
    case "click":
    case "mouse_click":
      return click(args, 1);
    case "dblclick":
      return click(args, 2);
    case "hover":
      return hover(args);
    case "scroll":
      return scroll(args);
    case "upload":
      return upload(args);
    case "wait":
      return wait(args);
    case "rect":
      return rect(args);
    case "box":
      return box(args);
    case "frame":
      return frame(args);
    case "clear_refs":
      clearRefs();
      return { cleared: true };
  }
  fail("invalid_args", "unknown page operation: " + op);
}
async function page(op: string, args: PageArgs): Promise<PageResult> {
  try {
    return { ok: true, value: run(op, args) };
  } catch (error) {
    // The page refused a DOM call, as storage does when the site may not
    // store data or its quota is full. A DOMException has a numeric code of
    // its own.
    if (error instanceof DOMException)
      return {
        ok: false,
        code: "evaluation_failed",
        message: op + ": " + error.name + ": " + error.message,
      };
    const { code, message } = fault(error as Error);
    return { ok: false, code, message };
  }
}

if (!globalThis.__omwPage) {
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) clearRefs();
  });
  globalThis.__omwPage = page;
}
