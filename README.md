<div align="center">

<img src="packages/brand/icons/mark.svg" alt="" width="80" height="80">

# oh-my-webbridge

[![Checks](https://img.shields.io/github/actions/workflow/status/oh-my-webbridge/oh-my-webbridge/ci.yml?branch=main&label=checks&logo=githubactions&logoColor=white)](https://github.com/oh-my-webbridge/oh-my-webbridge/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/oh-my-webbridge/oh-my-webbridge?label=release&color=0A84FF)](https://github.com/oh-my-webbridge/oh-my-webbridge/releases/latest) [![License](https://img.shields.io/github/license/oh-my-webbridge/oh-my-webbridge)](LICENSE)

Lets an agent work in the Chrome or Firefox you already use, with your logins, through a local daemon and a browser extension.

**[Documentation](https://oh-my-webbridge.github.io)** · [Getting started](https://oh-my-webbridge.github.io/getting-started/) · [Releases](https://github.com/oh-my-webbridge/oh-my-webbridge/releases)

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/oh-my-webbridge/oh-my-webbridge/assets/activity-form.gif" alt="An agent fills in a booking form. The tab shows a soft edge glow, a focus frame moves from field to field, and the toolbar icon gains an orange dot while the agent has control." width="800">
</p>

## What it does

- Runs browser tasks in sessions. Each session has its own background tabs in a tab group, and sessions run in parallel.
- Reads pages as text or as an accessibility snapshot, clicks, types, fills forms, uploads files, takes screenshots in either browser and PDFs in Chrome.
- Marks the tab an agent controls: the toolbar icon gains an orange dot, and the page draws a focus frame on the element being acted on.
- Gives Chrome clients raw CDP: page targets from `/json/list`, and Playwright `connectOverCDP` against a daemon started with `omw serve --cdp`.
- Keeps everything on your computer. The daemon listens on `127.0.0.1:17373` only, and each browser is paired once with a pairing code.

## Install

1. Download the daemon and the extension for your platform from [Releases](https://github.com/oh-my-webbridge/oh-my-webbridge/releases).
2. Load the extension in Chrome or Firefox. Its setup page opens with the `omw start` and `omw pair` steps.
3. Give your agent the skill:

   ```sh
   omw install-skill ~/.agents/skills
   ```

Step-by-step instructions, including building from source, are in [Getting started](https://oh-my-webbridge.github.io/getting-started/).

## Use

Ask your agent, for example, "Use oh-my-webbridge to read my active tab and summarize it in five bullet points." Or run actions yourself:

```sh
omw call research navigate '{"url":"https://example.com","group_title":"Research"}'
omw call research snapshot
omw call research close_session
```

Scripts use the JavaScript SDK:

```js
import { connect } from "./dist/sdk.mjs";

const task = await connect("research");
await task.navigate("https://example.com");
console.log(await task.evaluate("document.title"));
await task.close();
```

## Documentation

| Page                                                                                                                                                                        | Covers                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [Sessions and tabs](https://oh-my-webbridge.github.io/sessions/)                                                                                                            | Task sessions, tab groups, borrowed tabs, limits     |
| [Agent activity](https://oh-my-webbridge.github.io/activity/)                                                                                                               | Toolbar icon states and the activity layer           |
| [Page presets](https://oh-my-webbridge.github.io/presets/)                                                                                                                  | Built-in ad and tracker blocking for task tabs       |
| [Firefox](https://oh-my-webbridge.github.io/firefox/)                                                                                                                       | Installing in Firefox and how its actions differ     |
| [Actions](https://oh-my-webbridge.github.io/reference/actions/)                                                                                                             | Every action, its arguments and error codes          |
| [CLI](https://oh-my-webbridge.github.io/reference/cli/) · [SDK](https://oh-my-webbridge.github.io/reference/sdk/) · [CDP](https://oh-my-webbridge.github.io/reference/cdp/) | The command line, the JavaScript SDK and CDP clients |

## Development

```sh
pnpm install
pnpm run build
go build -o dist/omw ./cmd/omw
pnpm run check && pnpm test && go test -race ./...
```

The repository layout, browser test suites and the release process are described in [Development](https://oh-my-webbridge.github.io/development/).

## License

[Apache License 2.0](LICENSE). Bundled third-party components and their licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
