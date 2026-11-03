---
name: oh-my-webbridge-design
description: Presentation rules for the oh-my-webbridge browser extension pages (popup, setup page and settings page), the activity layer drawn on pages an agent controls, the brand icons, and the documentation site. Readers are developers who run local agents and glance at the extension to confirm state.
version: 2026-11-03
---

# oh-my-webbridge design

## 1. Scope and priority

Applies to:

- The popup of the Chrome and Firefox extensions.
- Full-page extension views: the setup page and the settings page.
- The activity layer that the extension draws over a page while an agent controls it.
- Toolbar icons, the app icon and the page favicon used while a page is controlled.
- The documentation site and the README media.

Does not apply to: terminal output of the CLI and agent-facing text formats.

Priority for conflicts: facts and user requirements; accessibility and usability; the reader's current task; platform conventions (Chrome, Firefox, macOS); brand expression; decoration.

## 2. Brand and readers

- [MUST] State is the main content. Every surface shows connection state and control state before anything else, with color and a text label together. Color alone never carries state.
- [SHOULD] Quiet. The interface uses one accent color (`--omw-blue`) for actions and links, and one signal color (`--omw-live`) only for "an agent is controlling this page". No other saturated color appears unless it reports an error or success.
- [SHOULD] Native. Surfaces follow macOS system conventions: system font, grouped inset lists, large continuous corner radii, hairline separators instead of heavy borders, translucent material only for floating chrome.
- [SHOULD] Readers are developers who scan, not read. Copy is short, uses the imperative for actions, and names commands in monospace.
- Copy tone: plain and specific. Name the thing and the next step ("Run omw pair in a terminal"). No exclamation marks, no praise, no filler such as "simply" or "seamless".

## 3. Page structure and composition

### Popup

- [MUST] Fixed width 360px. Height follows content up to 560px; longer content scrolls inside the main region, the header stays fixed.
- [SHOULD] Order: status header (icon, product name, state label, one primary action when the state needs one), current-page row (control state of the active tab), main region, footer row with secondary actions.
- [SHOULD] Padding 16px on all sides; 12px between rows. The main region holds a single component (for example tabs with examples). No nested cards.
- [SHOULD] When the extension cannot work (not paired, daemon unreachable), the popup shows only the status header with a single action that opens the full-page view. Other regions are hidden.

### Setup page

- [SHOULD] Single centered column, max width 640px, top padding 72px on desktop and 32px below 640px viewport width.
- [SHOULD] First viewport: app icon (64px), page title (display role), one-sentence subtitle, then the step list. The current step is expanded; completed steps collapse to one line with a check; later steps show only their title in muted text.
- [SHOULD] Each step body: one short instruction, the command or input, and its live status line. A step completes when the extension observes the result, so there is no "Next" button.
- [SHOULD] End position: a closing step that shows a usable example, then a link row to the settings page and documentation.

### Settings page

- [SHOULD] Grouped inset list (Apple Settings pattern): max width 640px, groups separated by 32px, each group is one rounded surface (`rounded-2xl`, `bg-card`) with rows divided by hairlines inset 16px from the left.
- [SHOULD] Row: label left, control right, optional one-line description under the label in the caption role. Destructive or rarely used rows sit in the last group, collapsed behind an "Advanced" disclosure.

### Activity layer

- [MUST] The layer never intercepts input: `pointer-events: none`, hidden from assistive technology, and removed completely when control ends.
- [MUST] The layer is absent from screenshots and PDFs that the agent captures.
- [SHOULD] Parts: an edge glow while an action runs, a focus frame with a small action label around the element an action targets, and the favicon swap while the page is controlled.

### Documentation pages

- [SHOULD] Fumadocs docs layout: sidebar, article, table of contents. Article width follows Fumadocs defaults.
- [SHOULD] Feature pages open with one demo video or image directly under the title, then the reference text. Media fills the article width with `rounded-2xl` corners and a hairline border.
- [SHOULD] The documentation home is a docs page, not a marketing page: title, one-line description, how the parts connect, demo video, what an agent can do, then links to the main sections as a plain list.

## 4. Visual rules

### Type

- [MUST] Use the system font stacks `--omw-font-sans` and `--omw-font-mono`. Do not load web fonts in the extension.
- [SHOULD] Roles (size / line height / weight / tracking):
  - Display: 34px / 40px / 700 / -0.022em. Full-page title only.
  - Title: 22px / 28px / 600 / -0.016em. Step and group titles in full-page views.
  - Headline: 15px / 20px / 600 / -0.008em. Panel header and row labels that lead a group.
  - Body: 14px / 20px / 400 / -0.004em. Default text in all extension views.
  - Caption: 12px / 16px / 400 / 0. Secondary lines, timestamps, help under a row.
  - Code: 12.5px / 18px / 500 mono. Commands, codes, tokens.
- [SHOULD] Emphasize with weight, not with size or color. Numbers that update in place use `tabular-nums`.

### Color

- [MUST] Text contrast at least 4.5:1 against its surface; icons and focus rings at least 3:1.
- [SHOULD] Light and dark themes follow the operating system (`prefers-color-scheme`). Tokens switch through the `.dark` class on `html`.
- [SHOULD] State colors: connected uses `--omw-success` dot with the label "Connected"; controlling uses `--omw-live`; "Not paired" and "Paused" use `--omw-ink-secondary`; errors use `--omw-danger`.
- [SHOULD] Backgrounds: page canvas `--omw-canvas`, raised surfaces `--omw-surface`. Do not tint surfaces with the accent color except the selected state of a control (`--omw-blue-tint`).

### Space, radius, depth

- [SHOULD] 4px spacing grid. Common gaps: 4, 8, 12, 16, 24, 32.
- [SHOULD] Radii: controls 10px (`rounded-lg` with `--radius: 0.75rem` mapping), surfaces 16px (`rounded-2xl`), app icon 22% of its size.
- [SHOULD] Depth: surfaces use a hairline border (`--omw-hairline`) and no shadow. Floating elements (popovers, toasts, the activity label) use one soft shadow: `0 8px 24px rgb(0 0 0 / 0.12)`.
- [SHOULD] Translucent material (`backdrop-filter: blur(20px) saturate(180%)` over a 72% opaque surface) only for chrome that floats over scrolling content. With `prefers-reduced-transparency: reduce`, use the opaque surface.

### Icons and media

- [MUST] UI icons come from `lucide-react` at 16px in controls and step markers, with the default stroke width. Decorative icons have `aria-hidden`.
- [SHOULD] Brand icons come from `packages/brand/icons`. Do not redraw the glyph inline.
- [SHOULD] Demo media: a 16:10 page recorded at 2x density in light theme, set in a light window frame with a soft shadow on a pale gradient backdrop (`scripts/media/compose.mjs`). Videos have no cursor or audio; the focus frame marks where the agent acts. Every video has a poster image, loops and stays under 15 seconds.

### Controls and states

- [SHOULD] Use coss primitives with their default variants. Primary button: one per view. Secondary actions use `variant="ghost"` or `variant="outline"`.
- [MUST] Every focusable element shows the coss focus ring (`outline-ring`), visible in both themes.
- [SHOULD] Loading: a spinner inside the control that started the work; the rest of the view stays usable. Empty: one line of muted text and, if useful, one action. Error: the message under the affected control in `--omw-danger` with the next step. Disabled: 50% opacity, no hover change.
- [SHOULD] Commands render as a code row with a copy button on the right. Copy feedback changes the icon to a check for 1.5 seconds.

### Motion

- [SHOULD] Springs from `motion`: default `{ type: "spring", bounce: 0, duration: 0.35 }`; elements that move to follow a target (the focus frame) use `duration: 0.4`.
- [SHOULD] Step expand and collapse animate height and opacity together. Status labels cross-fade.
- [SHOULD] The edge glow fades in over 180ms when an action starts and fades out over 600ms after it ends. It does not pulse faster than one cycle per 2 seconds.
- [MUST] With `prefers-reduced-motion: reduce`, replace movement with opacity changes and remove pulsing.

## 5. Available primitives

Pages use only the names below. Page-specific styles use Tailwind utilities with these tokens and do not change the layout, typography or surfaces of coss components. Custom classes for the activity layer use the `omw-` prefix and live inside its shadow root.

| Role                       | Implementation                                                           | Source                                                    | Usage condition                                    | Status      |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------- | ----------- |
| Brand palette, font stacks | `--omw-*` custom properties                                              | `packages/brand/theme.css`                                | Every surface                                      | Implemented |
| Component tokens           | coss tokens (`--primary`, `--card`, `--border`, ...) mapped to `--omw-*` | `extension/ui/src/styles.css`                             | Extension pages                                    | Implemented |
| Buttons                    | `Button` with `variant` and `size`                                       | `extension/ui/src/components/ui/button.tsx`               | Actions                                            | Implemented |
| Tabs                       | `Tabs`, `TabsList`, `TabsTab`, `TabsPanel`                               | `extension/ui/src/components/ui/tabs.tsx`                 | Switching example groups                           | Implemented |
| Code input                 | `OTPField`                                                               | `extension/ui/src/components/ui/otp-field.tsx`            | Six-digit codes                                    | Implemented |
| Switch row                 | `Switch` inside a settings row                                           | `extension/ui/src/components/ui/switch.tsx`               | Boolean preferences                                | Implemented |
| Disclosure                 | `Collapsible`                                                            | `extension/ui/src/components/ui/collapsible.tsx`          | Advanced groups                                    | Implemented |
| Feedback                   | `toastManager` toasts, `Spinner`                                         | `extension/ui/src/components/ui/toast.tsx`, `spinner.tsx` | Transient results, loading                         | Implemented |
| Step list                  | `Steps`, `Step`                                                          | `extension/ui/src/components/steps.tsx`                   | Setup page steps                                   | Implemented |
| Command row                | `CommandRow`                                                             | `extension/ui/src/components/command-row.tsx`             | Copyable commands                                  | Implemented |
| Status label               | `StatusLabel`                                                            | `extension/ui/src/components/status-label.tsx`            | Connection and control state                       | Implemented |
| App and toolbar icons      | `mark.svg`, `toolbar-*.svg`                                              | `packages/brand/icons/`                                   | Brand mark, toolbar state, controlled-page favicon | Implemented |

Toolbar icon variants: `toolbar-connected` (blue, connected), `toolbar-live` (blue with orange corner dot, this page is controlled), `toolbar-offline` (gray, not paired or not connected), `toolbar-error` (gray with red corner dot, paired but the daemon cannot be reached), `toolbar-paused` (gray with pause bars).

## 6. Copy and number formats

- [SHOULD] Titles use sentence case. Buttons use a verb and an object ("Open setup", "Copy prompt"). Do not end titles or buttons with a period.
- [SHOULD] Help text is one sentence. If a step needs a command, the command is the help.
- [SHOULD] Errors state what failed and the next step in one sentence.
- [SHOULD] Durations use the largest whole unit ("5 minutes", "12 s" in dense rows). Times use the browser locale.
- [MUST] Do not show tokens in full. Show the first 4 and last 4 characters with an ellipsis, and reveal the full value only on an explicit action.

## 7. Anti-patterns

- [SHOULD] A centered hero with a card grid as the default page structure.
- [SHOULD] Cards inside cards.
- [SHOULD] Decorative icon tiles or colored icon backgrounds. Step markers are the only circular icon containers.
- [SHOULD] Font sizes, font weights or color literals outside the primitives.
- [SHOULD] Small low-contrast text for primary information.
- [SHOULD] Pill labels for ordinary metadata.
- [SHOULD] Gradients other than the app icon, the activity glow and the demo media backdrop.
- [SHOULD] Explanatory paragraphs that repeat a label, or text that describes what the interface "lets you" do.

## 8. Implementation and integration

- Style entry: `extension/ui/src/styles.css` imports Tailwind, `@oh-my-webbridge/brand/theme.css` and maps coss tokens. The docs site imports the same brand theme in its global stylesheet and maps Fumadocs tokens.
- Fonts: system stacks only; no font files are bundled.
- Theme: the extension sets `.dark` on `html` from `prefers-color-scheme` and follows changes. The docs site uses the Fumadocs theme switch, which sets the same class.
- Components: coss primitives under `extension/ui/src/components/ui` are not edited; compositions live in `extension/ui/src/components`.

## Glossary

| Concept                                 | Name           |
| --------------------------------------- | -------------- |
| Toolbar panel                           | popup          |
| Full-page extension view                | app page       |
| Overlay drawn on controlled pages       | activity layer |
| Orange state color for controlled pages | live           |
| Brand symbol                            | mark           |
