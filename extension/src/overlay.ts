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
        box-shadow: inset 0 0 0 2px rgb(255 149 0 / 0.6), inset 0 0 36px 4px rgb(255 149 0 / 0.22); }
      .glow[data-busy] { opacity: 1; transition-duration: 180ms; animation: breathe 2.4s ease-in-out infinite alternate; }
      @keyframes breathe { from { filter: none; } to { filter: saturate(1.6) brightness(1.08); } }
      .frame { position: fixed; left: 0; top: 0; width: 0; height: 0; opacity: 0; box-sizing: border-box;
        border: 2px solid rgb(255 149 0); border-radius: 10px; background: rgb(255 149 0 / 0.07);
        box-shadow: 0 0 0 4px rgb(255 149 0 / 0.18);
        transition: translate 400ms ${spring}, width 400ms ${spring}, height 400ms ${spring}, opacity 180ms ease-out; }
      .frame[data-on] { opacity: 1; }
      .label { position: absolute; left: -2px; bottom: calc(100% + 6px); white-space: nowrap; padding: 4px 8px;
        border-radius: 8px; color: #fff; background: rgb(16 33 42 / 0.9); box-shadow: 0 8px 24px rgb(16 33 42 / 0.2); }
      .frame[data-below] .label { bottom: auto; top: calc(100% + 6px); }
      .chip { position: fixed; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 6px; padding: 5px 10px;
        border-radius: 999px; color: #fff; background: rgb(16 33 42 / 0.8); box-shadow: 0 8px 24px rgb(16 33 42 / 0.18);
        -webkit-backdrop-filter: blur(20px) saturate(180%); backdrop-filter: blur(20px) saturate(180%); }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #ff9500; box-shadow: 0 0 0 2px rgb(255 149 0 / 0.3); }
      @media (prefers-reduced-motion: reduce) {
        .glow[data-busy] { animation: none; }
        .frame { transition: opacity 180ms ease-out; }
      }
      @media (prefers-reduced-transparency: reduce) { .chip { background: rgb(16 33 42); backdrop-filter: none; } }
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
