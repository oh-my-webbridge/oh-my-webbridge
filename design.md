---
name: oh-my-webbridge-design
description: Presentation rules for the oh-my-webbridge extension views (compact panel, rail page with a multi-step flow or a settings list), the overlay drawn on agent-controlled pages, the brand icons, the documentation site and the demo media. Readers are developers who run local agents and look at the extension to confirm state.
version: 2026-11-05
---

# oh-my-webbridge design

## 1. Scope and priority

Applies to:

- The compact panel that opens from the toolbar icon.
- Rail pages: full-tab extension views with a side rail and one content column.
- The overlay that the extension draws on a page while an agent controls it.
- Toolbar icons, the app mark and the favicon of a controlled page.
- The documentation site, the README and the demo media.

Does not apply to: terminal output and text formats that agents read.

Priority for conflicts: facts and user requirements; accessibility; the reader's current task; platform conventions (Chrome, Firefox, macOS, Windows); brand expression; decoration.

## 2. Brand and readers

- [MUST] State comes first. Every view shows the connection state and the control state before other content, with a text label and a color together. Color alone never carries state.
- [SHOULD] Calm and technical. The brand is ink on paper: the primary color `--omw-primary` (#101318 ink, #f2f3f5 in the dark theme) marks the brand, primary actions, links and the selected item. The signal color `--omw-live` (amber, #ffb020) marks only "an agent controls this page". No other saturated color appears unless it reports an error or a success.
- [SHOULD] Commands are content. A command that the reader must run appears in a command well, set in the mono font, with a copy action.
- [SHOULD] Readers scan. Labels are short nouns or verb phrases. Help text is one sentence.
- Copy tone: plain, specific and literal. Name the thing and the next step ("Run omw pair in a terminal"). Follow [ste-writing](https://asd-ste100.org): one instruction for each sentence, active voice, no marketing words, no exclamation marks, no "simply", "seamless" or "powerful".

## 3. Page types and composition

### Compact panel

- [MUST] Fixed width 360px. The height follows the content up to 560px; longer content scrolls inside the panel body while the header stays fixed.
- [SHOULD] Order: header (mark, product name, connection label), current-tab row, one body component, footer row with secondary actions.
- [SHOULD] Padding 16px; 12px between rows. The body holds one component, for example the prompt composer. No nested cards.
- [SHOULD] When the connection cannot work, the panel shows the header, one sentence and one primary action that opens a rail page. Other regions are hidden.

### Rail page

- [SHOULD] Desktop (768px and wider): a 248px side rail on the left in `--omw-rail`, and a content column on `--omw-canvas`. The content column is at most 640px wide, with 48px top padding and 40px side padding.
- [SHOULD] Rail order from top: mark (28px) with the product name, the navigation list, flexible space, then the language menu, the documentation link and the version caption. Rail text uses `--omw-rail-ink`; secondary rail text uses `--omw-rail-ink-secondary`; the selected navigation item has a `--omw-rail-fill` background and `--omw-rail-ink` text.
- [SHOULD] Below 768px the rail becomes a 56px top bar with the mark, the navigation as a segmented control and the language menu. The content column then uses 20px side padding.
- [SHOULD] The content column starts with a title in the Title-L role and one caption line. Do not repeat the navigation label as a separate heading.

### Multi-step flow

- [SHOULD] A progress line under the title shows completed steps out of all steps, with a thin progress bar in `--omw-primary`.
- [SHOULD] Steps are rows in one surface, separated by hairlines. Each row has a 28px marker on the left: the step number while open, a check on `--omw-success` when done, a spinner while the step waits for a result.
- [SHOULD] Only the current step shows its body. Done steps collapse to their title and a one-line result. Later steps show only their title in `--omw-ink-secondary`.
- [SHOULD] A step completes when the extension observes the result. There is no "Next" button.
- [SHOULD] The last step shows a usable example and ends the flow. After all steps are done, the progress line reads as complete and stays.

### Settings list

- [SHOULD] Grouped inset lists: each group has a caption title above one rounded surface (`--omw-surface`, 14px radius, hairline border). Rows are separated by hairlines inset 16px from the left. Groups are 28px apart.
- [SHOULD] Row: label on the left, control on the right, an optional one-line description under the label in the Caption role.
- [SHOULD] Rarely used or destructive rows sit in the last group behind a disclosure.

### Page overlay

- [MUST] The overlay never intercepts input (`pointer-events: none`), is hidden from assistive technology, and is removed completely when control ends.
- [MUST] The overlay is absent from screenshots and PDFs that the agent takes.
- [SHOULD] Parts: an amber edge glow while an action runs; an amber focus frame around the element that an action targets, with a dark label above it that names the action; the agent's pointer, which moves to the centre of each target and stays at the last one, with an amber tag that shows a prompt symbol and the session name; a dark chip in the bottom right corner with an amber dot and the session name; the live toolbar icon as the favicon.
- [SHOULD] The pointer arrow and its tag each read the background under them: on light backgrounds the arrow is ink with a white edge, on dark backgrounds white with an ink edge. Mid-tone backgrounds keep the current tone, and a change fades over 240ms.

### Documentation pages

- [SHOULD] Fumadocs docs layout under a sticky site header: brand on the left; repository, language menu and theme menu on the right. Sidebar, article and table of contents follow Fumadocs defaults.
- [SHOULD] A feature page shows one demo video or image directly under the title, then the reference text. Media fills the article width with a 14px radius and a hairline border.
- [SHOULD] The documentation home is a docs page, not a landing page: title, one-line description, a demo video, how the parts connect, then links to the main sections as a plain list.

## 4. Visual rules

### Type

- [MUST] Use the system font stacks `--omw-font-sans` and `--omw-font-mono`. The extension does not load web fonts.
- [SHOULD] Roles (size / line height / weight / tracking), as `type-<role>` utilities in `extension/ui/src/styles.css`:
  - Title-L: 28px / 34px / 650 / -0.02em. The first heading of a rail page.
  - Title: 17px / 24px / 600 / -0.01em. Step titles and the panel product name.
  - Body: 14px / 20px / 400 / 0. Default text.
  - Caption: 12px / 16px / 500 / 0.01em. Group captions, secondary lines, help under a row. Group captions use uppercase only for Latin scripts.
  - Code: 13px / 20px / 500 mono. Commands, codes and tokens.
- [SHOULD] Emphasize with weight, not with size or color. Numbers that update in place use `tabular-nums`.
- [SHOULD] Chinese text uses the same roles. Do not apply negative tracking or uppercase to CJK text (`:lang(zh)` resets them).

### Color

- [MUST] Text contrast is at least 4.5:1 against its surface; icons, focus rings and control borders at least 3:1. Checked pairs: `--omw-primary` on `--omw-surface` 18.6:1, `--omw-ink-secondary` on `--omw-canvas` 5.6:1, `--omw-rail-ink-secondary` on `--omw-rail` 9.4:1, `--omw-live-ink` on `--omw-surface` 6.3:1.
- [SHOULD] Light and dark themes follow the operating system. Tokens switch through the `.dark` class on `html`.
- [SHOULD] State colors: connected uses a `--omw-success` dot; controlling uses a `--omw-live` dot and `--omw-live-ink` text; not paired and paused use `--omw-ink-secondary`; errors use `--omw-danger`.
- [SHOULD] Surfaces: canvas `--omw-canvas`, raised surfaces `--omw-surface`, selected controls `--omw-primary-tint`. The command well is `--omw-ink` with `--omw-canvas` text in the light theme and `--omw-fill` on `--omw-surface` in the dark theme.

### Space, radius, depth

- [SHOULD] 4px spacing grid. Common gaps: 4, 8, 12, 16, 20, 28, 40.
- [SHOULD] Radii: controls 10px (`--radius: 0.625rem`), surfaces and media 14px, the app mark 22% of its size, step markers and flags fully round.
- [SHOULD] Depth: surfaces use a hairline border and no shadow. Floating elements (menus, toasts, overlay labels) use `--omw-shadow-float`.

### Icons, flags and media

- [MUST] Interface icons come from `lucide-react` at 16px, with the default stroke width. Decorative icons have `aria-hidden`.
- [SHOULD] Brand icons come from `packages/brand/icons`. Do not redraw the mark inline.
- [SHOULD] Language menus show a 16px round flag from `@sankyu/react-circle-flags` before each language name. The flag is decorative: the language name, written in that language, is the label.
- [SHOULD] Demo media: a 16:10 page recorded at 2x density in the light theme, in a light window frame with a soft shadow on a pale neutral backdrop (`scripts/media/compose.mjs`). No system cursor and no audio; the agent's pointer and the focus frame mark where the agent acts. Each clip has a poster image and loops. Feature clips are shorter than 15 seconds; the home demo shows one whole task and is shorter than 60 seconds. A reel joins clips with title cards: white text on `--omw-rail`, Title-L role, one line each.

### Controls and states

- [SHOULD] Use coss primitives with their default variants. One primary button for each view. Secondary actions use `variant="ghost"` or `variant="outline"`.
- [MUST] Every focusable element shows a visible focus ring in both themes.
- [SHOULD] Loading: a spinner inside the control or step marker that started the work; the rest of the view stays usable. Empty: one line of muted text and, if useful, one action. Error: the message under the affected control in `--omw-danger`, with the next step. Disabled: 50% opacity, no hover change.
- [SHOULD] A command well has the command on the left and an icon copy button on the right. Copy feedback changes the icon to a check for 1.5 seconds.

### Motion

- [SHOULD] Springs from `motion`: `{ type: "spring", bounce: 0, duration: 0.35 }`. Elements that follow a target (the focus frame) settle in 0.4 seconds.
- [SHOULD] A step opens and closes with height and opacity together. Status labels cross-fade. The progress bar animates its width.
- [SHOULD] The edge glow fades in over 180ms when an action starts and fades out over 600ms after it ends. It pulses at most once every 2 seconds.
- [SHOULD] The popup prompt shows a new suggestion every 6 seconds. The old text leaves upward over 150ms and the new text arrives from below over 250ms, both with opacity and a 4px blur, and two four-point stars in `--omw-primary` flare once at the corners over 900ms. The pointer or the focus on the prompt holds the current suggestion; editing ends the turns.
- [MUST] With `prefers-reduced-motion: reduce`, replace movement with opacity changes and remove pulsing.

## 5. Available primitives

Pages use only the names below. Page-specific styles use Tailwind utilities with these tokens and do not change the layout, type or surfaces of coss components. Overlay classes live inside its shadow root.

| Role                       | Implementation                                                        | Source                                                                               | Usage condition                              | Status      |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- | ----------- |
| Brand palette, font stacks | `--omw-*` custom properties                                           | `packages/brand/theme.css`                                                           | Every surface                                | Implemented |
| Component tokens           | coss tokens mapped to `--omw-*`                                       | `extension/ui/src/styles.css`                                                        | Extension views                              | Implemented |
| Docs tokens                | Fumadocs tokens mapped to `--omw-*`                                   | `docs/app/tokens.css`                                                                | Documentation site                           | Implemented |
| Buttons                    | `Button` with `variant` and `size`                                    | `extension/ui/src/components/ui/button.tsx`                                          | Actions                                      | Implemented |
| Tabs                       | `Tabs`, `TabsList`, `TabsTab`, `TabsPanel`                            | `extension/ui/src/components/ui/tabs.tsx`                                            | Switching groups of examples                 | Implemented |
| Prompt composer            | `PromptComposer`, `Textarea`                                          | `extension/ui/src/components/prompt-composer.tsx`, `ui/textarea.tsx`                 | A prompt that shows suggestions in turn      | Implemented |
| Menu                       | `Menu`, `MenuTrigger`, `MenuPopup`, `MenuRadioGroup`, `MenuRadioItem` | `extension/ui/src/components/ui/menu.tsx`                                            | Language menu                                | Implemented |
| Code input                 | `OTPField`                                                            | `extension/ui/src/components/ui/otp-field.tsx`                                       | Six-digit codes                              | Implemented |
| Switch row                 | `Switch` in a settings row                                            | `extension/ui/src/components/ui/switch.tsx`                                          | Boolean preferences                          | Implemented |
| Disclosure                 | `Collapsible`                                                         | `extension/ui/src/components/ui/collapsible.tsx`                                     | Rarely used groups                           | Implemented |
| Feedback                   | `toastManager`, `Spinner`                                             | `extension/ui/src/components/ui/toast.tsx`, `spinner.tsx`                            | Short results, loading                       | Implemented |
| Rail page shell            | `RailPage`                                                            | `extension/ui/src/components/rail-page.tsx`                                          | Every rail page                              | Implemented |
| Step list                  | `Steps`, `Step`                                                       | `extension/ui/src/components/steps.tsx`                                              | Multi-step flows                             | Implemented |
| Command well               | `CommandRow`                                                          | `extension/ui/src/components/command-row.tsx`                                        | Commands to run                              | Implemented |
| Status label               | `StatusLabel`, `ConnectionLabel`                                      | `extension/ui/src/components/status-label.tsx`                                       | Connection and control state                 | Implemented |
| Language menu              | `LanguageMenu`                                                        | `extension/ui/src/components/language-menu.tsx`, `docs/components/language-menu.tsx` | Choosing the interface language              | Implemented |
| App and toolbar icons      | `mark.svg`, `toolbar-*.svg`                                           | `packages/brand/icons/`                                                              | Mark, toolbar state, controlled-page favicon | Implemented |

The mark is a terminal window with a prompt and an amber pointer on an ink tile. Toolbar icon variants: `toolbar-connected` (ink tile, white pointer), `toolbar-live` (ink tile, amber pointer; also the favicon of a controlled page), `toolbar-offline` (gray tile), `toolbar-error` (gray tile with a red corner dot), `toolbar-paused` (gray tile with pause bars). Sizes up to 32px use the small masters in `icons/small`, which drop the prompt and enlarge the pointer. The wordmark `omw_` (`wordmark.svg`, `wordmark-dark.svg`) names the product in the docs header and the README.

## 6. Copy and number formats

- [SHOULD] Titles use sentence case. Buttons use a verb and an object ("Open setup", "Copy prompt"). Titles and buttons have no final period. Sentences have one.
- [SHOULD] Help text is one sentence. If a step needs a command, the command well carries it; the text names the result.
- [SHOULD] Errors state what failed and the next step.
- [SHOULD] Durations use the largest whole unit ("5 minutes"). Times use the interface language.
- [MUST] Do not show tokens in full. Show the first 4 and the last 4 characters with an ellipsis.
- [SHOULD] Chinese text uses full-width punctuation and a space between Chinese and Latin text or numbers. Product, command and protocol names stay in Latin script.

## 7. Anti-patterns

- [SHOULD] A centered hero with a card grid as the default structure.
- [SHOULD] Cards inside cards.
- [SHOULD] Decorative icon tiles or colored icon backgrounds. Step markers and flags are the only round containers.
- [SHOULD] Font sizes, font weights or color literals outside the primitives.
- [SHOULD] Small low-contrast text for primary information.
- [SHOULD] Pill labels for ordinary metadata.
- [SHOULD] Gradients other than the overlay glow and the demo media backdrop.
- [SHOULD] Text that repeats a label, or text that says what the interface "lets you" do.
- [SHOULD] The signal color on anything that does not mean "an agent controls this page". The pointer of the mark and the cursor of the wordmark are the brand's only exceptions.

## 8. Implementation and integration

- Style entry: `extension/ui/src/styles.css` imports Tailwind and `@oh-my-webbridge/brand/theme.css`, then maps coss tokens. `docs/app/tokens.css` maps the same brand theme to Fumadocs tokens.
- Fonts: system stacks only in the extension. The docs site uses the same stacks.
- Theme: the extension sets `.dark` on `html` from `prefers-color-scheme` and follows changes. The docs site uses its theme menu, which sets the same class.
- Components: coss primitives under `extension/ui/src/components/ui` are not edited; compositions live in `extension/ui/src/components`.

## Glossary

| Concept                              | Name                  |
| ------------------------------------ | --------------------- |
| Panel from the toolbar icon          | compact panel (popup) |
| Full-tab extension view              | rail page             |
| Overlay on controlled pages          | activity layer        |
| Amber state color                    | live                  |
| Brand symbol                         | mark                  |
| Box with a command and a copy button | command well          |
