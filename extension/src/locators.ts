// Serialized into the selected execution context. Keep every dependency local.
export function resolveElements(selector: string): Element[] {
  const nth = selector.match(/\s*>>\s*nth=(-?\d+)$/u);
  if (nth) selector = selector.slice(0, nth.index);
  const roots: (Document | ShadowRoot)[] = [document];
  const elements: Element[] = [];
  for (let index = 0; index < roots.length; index++) {
    for (const element of roots[index]!.querySelectorAll("*")) {
      elements.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const prefix = selector.match(/^(css|xpath|text|label|placeholder|alt|title|testid)=(.*)$/su);
  const mode = prefix?.[1] ?? "css";
  const query = prefix?.[2] ?? selector;
  let matches: Element[];
  if (mode === "xpath") {
    const result = document.evaluate(query, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
    matches = Array.from({ length: result.snapshotLength }, (_, i) =>
      result.snapshotItem(i),
    ).filter((node): node is Element => node instanceof Element);
  } else if (mode === "css")
    matches = roots.flatMap((root) => Array.from(root.querySelectorAll(query)));
  else {
    const exact = query.startsWith('"') && query.endsWith('"');
    const value = exact ? (JSON.parse(query) as string) : query;
    const match = (text: string | null): boolean =>
      exact ? text === value : (text ?? "").toLocaleLowerCase().includes(value.toLocaleLowerCase());
    // Text of these elements never shows on the page: scripts, styles,
    // templates, the document head, and noscript while scripting is enabled.
    // Chrome then creates no box for noscript, Firefox hides it.
    const unrendered = new Set<Element>();
    for (const element of elements)
      if (
        !unrendered.has(element) &&
        (["head", "script", "style", "template", "title"].includes(element.localName) ||
          (element.localName === "noscript" && !element.getClientRects().length))
      ) {
        unrendered.add(element);
        for (const inner of element.querySelectorAll("*")) unrendered.add(inner);
      }
    const texts = new Map<Node, string>();
    // textContent without the text inside unrendered elements.
    const renderedText = (node: Node): string => {
      let text = texts.get(node);
      if (text !== undefined) return text;
      text = "";
      for (const child of node.childNodes)
        if (child instanceof Text) text += child.data;
        else if (child instanceof Element && !unrendered.has(child)) text += renderedText(child);
      texts.set(node, text);
      return text;
    };
    matches = elements.filter((element) => {
      if (mode === "text")
        return (
          !unrendered.has(element) &&
          match(renderedText(element).trim()) &&
          !Array.from(element.children).some(
            (child) => !unrendered.has(child) && match(renderedText(child).trim()),
          )
        );
      if (mode === "label") {
        const labels =
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
            ? Array.from(element.labels ?? [])
                .map((label) => renderedText(label))
                .join(" ")
            : "";
        return (
          (match(element.getAttribute("aria-label")) && !!element.getAttribute("aria-label")) ||
          (!!labels && match(labels))
        );
      }
      return (
        match(element.getAttribute(mode === "testid" ? "data-testid" : mode)) &&
        element.hasAttribute(mode === "testid" ? "data-testid" : mode)
      );
    });
  }
  if (nth) {
    const index = Number(nth[1]);
    const selected = matches.at(index);
    return selected ? [selected] : [];
  }
  return matches;
}

export function locatorExpression(selector: string): string {
  return `(${resolveElements.toString()})(${JSON.stringify(selector)})`;
}
