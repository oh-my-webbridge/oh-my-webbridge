# Chrome Web Store listing: oh-my-webbridge

> Last updated: 2026-11-12

The values to enter in the Chrome Developer Dashboard for item [`gfhmonnkmdapbocacedanaplhgkofebi`](https://chromewebstore.google.com/detail/gfhmonnkmdapbocacedanaplhgkofebi). Update this file in the same pull request as a change to `extension/manifest.json`, to the data the extension reads or sends, or to the features listed below. The release workflow uploads `omw-<version>-chrome-mv3.zip`, which holds `dist/extension` only.

## Store listing

**Extension name**: `oh-my-webbridge`, from `extensionName` in `extension/_locales/en/messages.json`.

**Short description** (112 of 132 characters), from `extensionDescription`:

```text
Connects this browser to the omw daemon on this computer. Agents can then open tabs, read pages and act on them.
```

**Detailed description**. The store shows plain text, so the lists use bullets and line breaks:

```text
oh-my-webbridge connects this browser to omw, a daemon that runs on the same computer. An agent or a script that you run sends browser commands to omw, and the extension carries them out in tabs that the agent opens or that you let it use.

FEATURES
• Agents work in your browser profile, on the sites you are signed in to.
• Each agent session works in its own tabs, grouped under the session name.
• While an agent controls a tab, the toolbar icon turns amber and the page shows the session name, the element the agent acts on and the agent's pointer. Screenshots and PDFs leave them out.
• Agents can read pages, fill in forms, click, take screenshots and PDFs, download files and record network requests.
• Task tabs block ads and trackers with built-in filter lists.
• The popup names the session that controls the current tab and suggests prompts for the page.

HOW TO USE
1. Download omw from https://github.com/oh-my-webbridge/oh-my-webbridge/releases/latest and run omw start.
2. Run omw pair and enter the six-digit code on the setup page that opens after installation.
3. Install the agent skill with omw install-skill ~/.agents/skills, then give your agent a browser task.

PRIVACY
The extension connects to one address: the omw daemon at 127.0.0.1 on this computer. It reads a page to carry out a command from the daemon and sends the result only to the daemon. When you open the popup, it reads the active tab to suggest prompts; that data stays in the popup. The project runs no server, and the extension contains no analytics. The program that sent the command decides what happens to the result; an agent can pass page content to its model provider.

SUPPORT
Documentation: https://oh-my-webbridge.github.io/en/
Issues: https://github.com/oh-my-webbridge/oh-my-webbridge/issues
```

**Category**: Developer Tools

**Single purpose**:

```text
Carries out browser tasks that a local agent sends through the omw daemon on the same computer, in tabs of the user's own browser.
```

**Primary language**: English. The extension also ships Traditional Chinese (`zh_TW`) and Simplified Chinese (`zh_CN`) names and descriptions.

## Graphics

| Asset                | Required size       | Source                                                                           |
| -------------------- | ------------------- | -------------------------------------------------------------------------------- |
| Store icon           | 128×128 PNG         | `icons/mark-128.png` in the build, rendered from `packages/brand/icons/mark.svg` |
| Screenshot: popup    | 1280×800 or 640×400 | `popup.png` on the `assets` branch, 1600×1160                                    |
| Screenshot: activity | 1280×800 or 640×400 | `activity-form.png` on the `assets` branch, 1600×1160                            |
| Screenshot: reading  | 1280×800 or 640×400 | `activity-read.png` on the `assets` branch, 1600×1160                            |
| Screenshot: presets  | 1280×800 or 640×400 | `presets.png` on the `assets` branch, 1600×1160                                  |
| Small promo tile     | 440×280             | None                                                                             |

The `assets` branch images are 1600×1160; the store needs them exported at 1280×800 or 640×400.

## Permission justifications

| Permission           | Type             | Justification                                                                                                                                                                                                                                                                      |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debugger`           | permissions      | Reads and operates the tabs that an agent session opened or borrowed: page text, the accessibility tree, clicks and typing, screenshots, PDFs and network recording. The extension attaches only to those tabs and to tabs that an automation client on this computer connects to. |
| `tabs`               | permissions      | Reads the address and title of open tabs to list them for automation clients, to find the tab that a session borrows, to show the current tab's state in the popup and to expire element references when a controlled tab changes its address.                                     |
| `tabGroups`          | permissions      | Puts the tabs of each agent session in one collapsed tab group named after the session.                                                                                                                                                                                            |
| `downloads`          | permissions      | The `download` command saves a file from the page to the browser's download folder and reports where it was saved.                                                                                                                                                                 |
| `storage`            | permissions      | Keeps the daemon token and the settings on this computer, and keeps session state in session storage, which the browser clears when it restarts.                                                                                                                                   |
| `alarms`             | permissions      | Reconnects to the daemon every 30 seconds while it is offline, and renews the activity overlay on controlled tabs, which removes itself when it is not renewed.                                                                                                                    |
| `activeTab`          | permissions      | When you open the popup, reads the active tab to pick prompt suggestions for it.                                                                                                                                                                                                   |
| `scripting`          | permissions      | When you open the popup, counts the tables, form fields, code blocks, videos, images and articles of the active tab to pick prompt suggestions. The counts stay in the popup.                                                                                                      |
| `http://127.0.0.1/*` | host_permissions | Connects to the omw daemon on this computer at `127.0.0.1:17373` for pairing and status checks. The extension connects to no other address.                                                                                                                                        |

## Privacy and data use

Privacy policy URL: <https://oh-my-webbridge.github.io/en/privacy/> (source: `docs/content/docs/privacy.mdx`).

The extension handles the following data only to carry out a command from the daemon, or in the popup when you open it. It sends data only to the daemon at `127.0.0.1:17373` on the same computer.

| Data type (dashboard form)   | Handled | Purpose                                                                                              |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| Personally identifiable info | No      |                                                                                                      |
| Health info                  | No      |                                                                                                      |
| Financial and payment info   | No      |                                                                                                      |
| Authentication info          | Yes     | The `cookies` and `storage` commands read and write the cookies and page storage of a session's tab. |
| Personal communications      | No      |                                                                                                      |
| Location                     | No      |                                                                                                      |
| Web history                  | Yes     | Addresses and titles of open tabs, for the target list and for finding a tab to borrow.              |
| User activity                | No      |                                                                                                      |
| Website content              | Yes     | Page text, element values, screenshots, PDFs and network requests of the tabs a session uses.        |

Certifications:

- The data is not sold to third parties.
- The data is not used or transferred for purposes unrelated to the single purpose.
- The data is not used or transferred to determine creditworthiness or for lending.

## Distribution and contact

- Visibility: Public
- Homepage URL: <https://oh-my-webbridge.github.io/en/>
- Support URL: <https://github.com/oh-my-webbridge/oh-my-webbridge/issues>

## Versions

Release notes for each version are in `CHANGELOG.md`. The `stores` workflow (`.github/workflows/stores.yml`) submits each release and reports the published and pending versions of the item.
