// The activity layer drawn on a page while an agent controls it. Chrome runs
// applyActivity through Runtime.evaluate and Firefox through
// scripting.executeScript, so it is self-contained: it reads nothing from this
// module and keeps its state in the DOM.

export type Rect = { x: number; y: number; width: number; height: number };
export type ActivityState = {
  // false removes the layer and restores the page's favicons.
  show: boolean;
  // An action is running: the viewport edge glows.
  busy: boolean;
  // The element the running action targets, in viewport coordinates.
  target?: Rect;
  // Short action name shown above the target, for example "Click".
  label?: string;
  session: string;
  // PNG data URL shown as the favicon while the page is controlled.
  favicon: string;
  // Screenshots and PDFs hide the layer while they capture.
  hidden?: boolean;
  // Time in ms after which the layer removes itself unless painted again.
  lease: number;
};

export function applyActivity(state: ActivityState): void {
  const tag = "omw-activity";
  const root = document.documentElement;
  if (!root) return;
  let host = root.querySelector<HTMLElement>(`:scope > ${tag}`);
  const head = document.head ?? root;
  const icons = (): HTMLLinkElement[] =>
    Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel]")).filter(
      (link) => /(^|\s)icon(\s|$)/iu.test(link.rel) && !link.hasAttribute("data-omw-icon"),
    );
  const remove = (): void => {
    const current = root.querySelector<HTMLElement>(`:scope > ${tag}`);
    if (current) window.clearInterval(Number(current.getAttribute("data-omw-timer")));
    current?.remove();
    document.querySelector("link[data-omw-icon]")?.remove();
    // Re-inserting a restored link makes the browser read it again.
    for (const link of Array.from(
      document.querySelectorAll<HTMLLinkElement>("link[data-omw-rel]"),
    )) {
      link.rel = link.getAttribute("data-omw-rel") ?? "icon";
      link.removeAttribute("data-omw-rel");
      link.replaceWith(link);
    }
  };
  if (!state.show) {
    remove();
    return;
  }
  if (!host) {
    host = document.createElement(tag);
    const created = host;
    const timer = window.setInterval(() => {
      if (Date.now() > Number(created.getAttribute("data-omw-lease"))) remove();
    }, 5000);
    host.setAttribute("data-omw-timer", String(timer));
    host.setAttribute("aria-hidden", "true");
    host.inert = true;
    for (const [name, value] of [
      ["all", "initial"],
      ["position", "fixed"],
      ["inset", "0"],
      ["z-index", "2147483647"],
      ["pointer-events", "none"],
      ["contain", "strict"],
    ])
      host.style.setProperty(name!, value!, "important");
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    // A critically damped spring sampled for linear(); 400 ms settles it.
    const spring =
      "linear(0, 0.049 5%, 0.156 10%, 0.283 15%, 0.408 20%, 0.522 25%, 0.62 30%, 0.702 35%, 0.769 40%, 0.864 50%, 0.922 60%, 0.956 70%, 0.976 80%, 0.987 90%, 1)";
    sheet.replaceSync(`
      :host { color-scheme: light dark; font: 500 12px/16px system-ui, -apple-system, "Segoe UI", sans-serif; }
      .glow { position: fixed; inset: 0; opacity: 0; transition: opacity 600ms ease-out;
        box-shadow: inset 0 0 0 2px rgb(255 176 32 / 0.6), inset 0 0 36px 4px rgb(255 176 32 / 0.22); }
      .glow[data-busy] { opacity: 1; transition-duration: 180ms; animation: breathe 2.4s ease-in-out infinite alternate; }
      @keyframes breathe { from { filter: none; } to { filter: saturate(1.6) brightness(1.08); } }
      .frame { position: fixed; left: 0; top: 0; width: 0; height: 0; opacity: 0; box-sizing: border-box;
        border: 2px solid rgb(255 176 32); border-radius: 10px; background: rgb(255 176 32 / 0.07);
        box-shadow: 0 0 0 4px rgb(255 176 32 / 0.18);
        transition: translate 400ms ${spring}, width 400ms ${spring}, height 400ms ${spring}, opacity 180ms ease-out; }
      .frame[data-on] { opacity: 1; }
      .label { position: absolute; left: -2px; bottom: calc(100% + 6px); white-space: nowrap; padding: 4px 8px;
        border-radius: 8px; color: #fff; background: rgb(16 19 24 / 0.9); box-shadow: 0 8px 24px rgb(16 19 24 / 0.2); }
      .frame[data-below] .label { bottom: auto; top: calc(100% + 6px); }
      .chip { position: fixed; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 6px; padding: 5px 10px;
        border-radius: 999px; color: #fff; background: rgb(16 19 24 / 0.8); box-shadow: 0 8px 24px rgb(16 19 24 / 0.18);
        -webkit-backdrop-filter: blur(20px) saturate(180%); backdrop-filter: blur(20px) saturate(180%); }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #ffb020; box-shadow: 0 0 0 2px rgb(255 176 32 / 0.3); }
      /* The agent's pointer: its tip is the point the action uses. The arrow and the session tag
         each follow the page under them: ink with a white edge on light pages, the reverse on
         dark pages. The amber tag keeps its color. */
      .pointer { position: fixed; left: 0; top: 0; opacity: 0;
        transition: translate 400ms ${spring}, opacity 180ms ease-out; }
      .pointer[data-on] { opacity: 1; }
      .arrow { position: absolute; left: -2px; top: -2px; overflow: visible; filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.28)); }
      .arrow path { fill: #101318; stroke: #fff; stroke-width: 2.5px; stroke-linejoin: round; paint-order: stroke;
        transition: fill 240ms ease-out, stroke 240ms ease-out; }
      .arrow[data-tone="dark"] path { fill: #f2f3f5; stroke: #101318; }
      .tag { position: absolute; left: 14px; top: 16px; display: flex; align-items: center; gap: 5px; padding: 3px 8px 3px 6px;
        border-radius: 3px 9px 9px 9px; color: #101318; background: #ffb020; font-weight: 600; font-size: 11px; line-height: 14px;
        letter-spacing: 0.01em; white-space: nowrap; transition: box-shadow 240ms ease-out;
        box-shadow: inset 0 0 0 0.5px rgb(16 19 24 / 0.08), 0 1px 2px rgb(0 0 0 / 0.14), 0 4px 12px -2px rgb(0 0 0 / 0.24); }
      .tag[data-tone="dark"] { box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.14), 0 4px 12px -2px rgb(0 0 0 / 0.24); }
      .tag svg { flex: none; fill: none; stroke: currentColor; }
      @media (prefers-reduced-motion: reduce) {
        .glow[data-busy] { animation: none; }
        .frame, .pointer { transition: opacity 180ms ease-out; }
      }
      @media (prefers-reduced-transparency: reduce) { .chip { background: rgb(16 19 24); backdrop-filter: none; } }
    `);
    shadow.adoptedStyleSheets = [sheet];
    const part = (name: string): HTMLElement => {
      const element = document.createElement("div");
      element.className = name;
      shadow.append(element);
      return element;
    };
    part("glow");
    const frame = part("frame");
    const label = document.createElement("div");
    label.className = "label";
    frame.append(label);
    const chip = part("chip");
    const dot = document.createElement("span");
    dot.className = "dot";
    chip.append(dot, document.createElement("span"));
    const svg = (
      box: string,
      width: number,
      height: number,
      ...shapes: [string, Record<string, string>][]
    ): SVGSVGElement => {
      const ns = "http://www.w3.org/2000/svg";
      const element = document.createElementNS(ns, "svg");
      for (const [name, value] of [
        ["viewBox", box],
        ["width", String(width)],
        ["height", String(height)],
        ["aria-hidden", "true"],
      ])
        element.setAttribute(name!, value!);
      for (const [tag, attributes] of shapes) {
        const shape = document.createElementNS(ns, tag);
        for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
        element.append(shape);
      }
      return element;
    };
    const pointer = part("pointer");
    const arrow = svg("0 0 24 24", 24, 24, [
      "path",
      {
        d: "M4.68 3.11L17.15 8.28A2 2 0 0 1 17.05 12.01L13.77 13.15A1 1 0 0 0 13.15 13.77L12.01 17.05A2 2 0 0 1 8.28 17.15L3.11 4.68A1.2 1.2 0 0 1 4.68 3.11Z",
      },
    ]);
    arrow.classList.add("arrow");
    const nameTag = document.createElement("div");
    nameTag.className = "tag";
    nameTag.append(
      svg(
        "0 0 12 10",
        12,
        10,
        [
          "path",
          {
            d: "M1.4 1.4L5.2 5L1.4 8.6",
            "stroke-width": "1.9",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
          },
        ],
        [
          "rect",
          {
            x: "7",
            y: "7.1",
            width: "4.4",
            height: "1.9",
            rx: "0.95",
            fill: "currentColor",
            stroke: "none",
          },
        ],
      ),
      document.createElement("span"),
    );
    pointer.append(arrow, nameTag);
    root.append(host);
  }
  host.setAttribute("data-omw-lease", String(state.lease));
  const shadow = host.shadowRoot!;
  host.style.setProperty("display", state.hidden ? "none" : "block", "important");
  shadow.querySelector(".glow")!.toggleAttribute("data-busy", state.busy);
  const frame = shadow.querySelector<HTMLElement>(".frame")!;
  if (state.target) {
    const pad = 4;
    frame.style.translate = `${state.target.x - pad}px ${state.target.y - pad}px`;
    frame.style.width = `${state.target.width + 2 * pad}px`;
    frame.style.height = `${state.target.height + 2 * pad}px`;
    frame.toggleAttribute("data-below", state.target.y < 32);
    frame.querySelector(".label")!.textContent = state.label ?? "";
    frame.toggleAttribute("data-on", true);
  } else frame.toggleAttribute("data-on", false);
  shadow.querySelector(".chip span:last-child")!.textContent = state.session;
  const pointer = shadow.querySelector<HTMLElement>(".pointer")!;
  const nameTag = shadow.querySelector<HTMLElement>(".tag")!;
  nameTag.querySelector("span")!.textContent = state.session;
  // The pointer moves to each target and stays at the last one between actions. Its tip lands
  // on the horizontal centre, a little below the vertical centre of taller targets, so the
  // arrow leaves the text of a field or a button readable.
  if (state.target) {
    const { x: left, y: top, width, height } = state.target;
    const x = Math.min(Math.max(left + width / 2, 4), window.innerWidth - 24);
    const drop = Math.min(Math.max(height / 2 - 8, 0), 12);
    const y = Math.min(Math.max(top + height / 2 + drop, 4), window.innerHeight - 40);
    // The first placement jumps there; later ones glide.
    const shown = pointer.hasAttribute("data-on");
    if (!shown) pointer.style.transition = "none";
    pointer.style.translate = `${x}px ${y}px`;
    if (!shown) {
      void pointer.offsetWidth;
      pointer.style.transition = "";
    }
    pointer.toggleAttribute("data-on", true);
    // Reads the first opaque background under a point; the layer itself ignores hit testing.
    const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const luminance = (px: number, py: number): number => {
      let rgb = [255, 255, 255];
      for (const element of document.elementsFromPoint(px, py)) {
        paint.clearRect(0, 0, 1, 1);
        paint.fillStyle = getComputedStyle(element).backgroundColor;
        paint.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
        if (a! > 127) {
          rgb = [r!, g!, b!];
          break;
        }
      }
      const linear = (c: number): number =>
        c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4;
      return 0.2126 * linear(rgb[0]!) + 0.7152 * linear(rgb[1]!) + 0.0722 * linear(rgb[2]!);
    };
    // 0.179 is where white and ink text have equal contrast; the band around it keeps a tone
    // steady on mid-tone backgrounds.
    const settle = (part: Element, points: [number, number][]): void => {
      const light = points.reduce((sum, [px, py]) => sum + luminance(px, py), 0) / points.length;
      const tone = part.getAttribute("data-tone");
      if (!tone) part.setAttribute("data-tone", light < 0.179 ? "dark" : "light");
      else if (tone === "light" && light < 0.13) part.setAttribute("data-tone", "dark");
      else if (tone === "dark" && light > 0.25) part.setAttribute("data-tone", "light");
    };
    settle(shadow.querySelector(".arrow")!, [
      [x + 3, y + 3],
      [x + 9, y + 9],
      [x + 15, y + 6],
    ]);
    const tagWidth = nameTag.offsetWidth;
    settle(
      nameTag,
      [0.15, 0.5, 0.85].map((share): [number, number] => [x + 14 + share * tagWidth, y + 26]),
    );
  }
  if (!document.querySelector("link[data-omw-icon]")) {
    for (const link of icons()) {
      link.setAttribute("data-omw-rel", link.rel);
      link.rel = "omw-page-icon";
    }
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.type = "image/png";
    icon.href = state.favicon;
    icon.setAttribute("data-omw-icon", "");
    head.append(icon);
  }
}
