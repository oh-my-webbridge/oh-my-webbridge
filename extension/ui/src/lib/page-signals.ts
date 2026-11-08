// What the popup reads from the active tab to rank prompt suggestions. The
// counts stay in the popup.
export type PageSignals = {
  // The lang attribute of the document, such as "en" or "zh-Hant".
  lang: string;
  // Tables with at least two rows.
  tables: number;
  // Inputs, text areas and selects that a person fills in.
  fields: number;
  // Preformatted blocks, which hold code on most sites.
  code: number;
  videos: number;
  // Images at least 120 pixels wide.
  images: number;
  articles: number;
  // Characters of text in the body.
  text: number;
  // Characters of the current selection.
  selection: number;
  search: boolean;
  // A citation_title meta tag, which paper pages carry for Google Scholar.
  citation: boolean;
  // JSON-LD @type values and og:type, in lower case.
  types: string[];
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// Runs in the page through chrome.scripting, so it uses no outer bindings.
function collect(): PageSignals {
  const all = (selector: string): Element[] => Array.from(document.querySelectorAll(selector));
  const types = new Set<string>();
  const visit = (value: Json): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const type = value["@type"];
    for (const name of Array.isArray(type) ? type : [type])
      if (typeof name === "string") types.add(name.toLowerCase());
    const graph = value["@graph"];
    if (graph) visit(graph);
  };
  for (const script of all('script[type="application/ld+json"]').slice(0, 20)) {
    try {
      visit(JSON.parse(script.textContent ?? "") as Json);
    } catch {
      // The page ships malformed JSON-LD; its other signals still count.
    }
  }
  const og = document.querySelector('meta[property="og:type"]')?.getAttribute("content");
  if (og) types.add(og.toLowerCase());
  return {
    lang: document.documentElement.lang,
    tables: all("table").filter((table) => (table as HTMLTableElement).rows.length >= 2).length,
    fields: all(
      "input:not([type=hidden],[type=submit],[type=button],[type=reset],[type=image]),textarea,select",
    ).length,
    code: all("pre").length,
    videos: all("video").length,
    images: all("img").filter((image) => (image as HTMLImageElement).naturalWidth >= 120).length,
    articles: all("article").length,
    text: document.body?.textContent?.length ?? 0,
    selection: getSelection()?.toString().length ?? 0,
    search: document.querySelector("input[type=search],[role=search]") !== null,
    citation: document.querySelector('meta[name="citation_title"]') !== null,
    types: [...types],
  };
}

// Reads the signals of a tab. Pages that extensions cannot script, such as
// browser pages and extension stores, and pages that do not answer within
// 500 ms, for example behind an alert, give undefined.
export async function readPage(tabId: number): Promise<PageSignals | undefined> {
  const injected = chrome.scripting
    .executeScript({ target: { tabId }, func: collect })
    .then(([frame]) => frame?.result)
    .catch(() => undefined);
  const late = new Promise<undefined>((resolve) => setTimeout(resolve, 500));
  return Promise.race([injected, late]);
}
