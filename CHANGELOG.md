# Changelog

## [0.2.2](https://github.com/oh-my-webbridge/oh-my-webbridge/compare/v0.2.1...v0.2.2)

### Improvements and fixes

#### Report each failure with the error code that describes it

Commands that fail report the code their documentation names, in Chrome and Firefox alike, so an agent can tell a retry from a check of the page.

- `wait` checks its condition at least once, also under a deadline of 500 ms or less. A check that is still running when the 500 ms reserve begins ends the wait with `wait_timeout`. An element that goes away during a check counts as not visible, and a document that has no body yet does not contain the text.
- A command for a tab that was closed fails with `tab_missing`. When the session's current tab closes other than by `close_tab`, the next page action without `tabId` fails with `no_tab`; after `close_tab`, the session continues in the tab it opened last, or else the tab it borrowed last. `close_session` finishes when one of its tabs has already closed; another failure keeps the session, so `close_session` can run again.
- A stale `@e` reference fails with `stale_ref`, and a selected frame that goes away during a command fails with `frame_unavailable`. In Chrome, a command cut off because the page navigated or the debugger detached fails with `outcome_unknown`.
- An element that refuses focus, a file or a value fails with `element_action_failed`, and an element without a box fails with `element_hidden`. A selector that does not parse, an unknown `get` property and an unknown `storage` cmd fail with `invalid_args`, and so do a URL, a download file name or a cookie that Firefox rejects. Page-script errors carry the exception message.
- In Firefox, a page action that meets a navigation of the tab fails with `outcome_unknown`, and `wait` keeps checking on the new page. Pages that Firefox protects from extensions return `restricted_tab`. An `evaluate` whose result cannot be returned, such as a DOM node, fails with `evaluation_failed` after the code ran.
- A failed `batch` step keeps its code, and the message starts with `batch step N of M (action):`.
- `outcome_unknown` messages name the cause: the deadline, `close_session`, a cancellation by the daemon or a closed connection. A command that `close_session` cancels while it waits in the queue says that it did not start.
- A screenshot or PDF `path` whose directory cannot be created or written, that appears while the artifact is saved, or that lies on a file system without hard links fails with `invalid_args`. An artifact over 100 MiB fails with `result_too_large`.
- A command for a browser that disconnects before the command is sent fails with `browser_offline`. An explicit `timeoutMs` outside 1 to 120000, including 0, fails with `invalid_request`, and the SDK rejects it before sending.
- `/json`, `/json/list` and `/devtools/page/{tabId}` answer with the HTTP status that `/command` uses for the error code. `omw serve` checks the `cdp` endpoint in `config.json` before it starts.

[PR #34](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/34)

#### Link the Firefox installation guide from the release notes

The Downloads section of each release's notes links the Firefox installation steps on the documentation site, [Firefox: Install](https://oh-my-webbridge.github.io/en/firefox/#install).

[PR #36](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/36)

#### Submit releases to addons.mozilla.org with the environment credentials

- The release workflow passes `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` to the stores workflow, so the addons.mozilla.org job of a release reads them from the `addons-mozilla-org` environment. A release without them fails before it calls the store.
- A manual run of the stores workflow with a release tag, `gh workflow run stores.yml --ref main -f tag=v0.2.1`, submits that published GitHub Release from its tagged commit to the Chrome Web Store and addons.mozilla.org. Without a tag the run reads the status of each store.

[PR #33](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/33)

#### Report a wait that runs out of time, and set the deadline in omw call

- `wait` fails with `wait_timeout` (HTTP 408) when its condition has not held 500 ms before the request deadline. The page is unchanged, so the wait can be sent again with a longer deadline. A deadline reached during a poll had returned `browser_error` or `outcome_unknown` depending on timing.
- A command that the deadline or a cancellation stops while it waits between polls, for a frame selection or for a download returns `outcome_unknown` in Chrome. It had returned `browser_error` with the message `request cancelled` or `cancelled`.
- `omw call --timeout-ms N` sets the command deadline, 1 to 120000 milliseconds. Without the flag the deadline stays 30 seconds. Put `--` before a session name that starts with `-`.

[PR #32](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/32)

### Downloads

Choose the native archive for macOS or Linux and your CPU. All release archives use `.tar.zst` with zstd level 3. Install zstd and verify `SHA256SUMS`, then extract with `zstd -dc archive.tar.zst | tar -xf - -C destination`. Load the extracted Chrome MV3 directory in Chrome. The agent kit includes the SDK and guide.

The release workflow submits `omw-0.2.2-chrome-mv3.zip` to the Chrome Web Store and the unsigned add-on to addons.mozilla.org; each store publishes the version after its review.

Firefox release builds install `omw-0.2.2-firefox-mv3-unsigned.xpi` permanently only after it is signed. For development, load the extracted Firefox MV3 directory as a temporary add-on in `about:debugging`. See [Firefox installation](https://oh-my-webbridge.github.io/en/firefox/#install).

Browser benchmarks report interface costs on a deterministic fixture; they do not establish real-site reliability. Platform acceptance and remaining differences are recorded in the repository.

## [0.2.1](https://github.com/oh-my-webbridge/oh-my-webbridge/compare/v0.2.0...v0.2.1)

### Improvements and fixes

#### Submit each release to the Chrome Web Store and addons.mozilla.org

Each release has `omw-<version>-chrome-mv3.zip`, the package for the Chrome Web Store, next to the unsigned Firefox add-on. After the GitHub Release is published, the release workflow submits the Chrome package to the Chrome Web Store and the add-on with its source code to addons.mozilla.org. Each store publishes the version after its review.

[PR #19](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/19)

#### Report browser state after captures, released tabs and new debugger sessions

- Screenshots and PDFs leave out the activity layer for the whole capture. A capture that outlasted the 600 ms settle time after an action, or that overlapped the layer's 30-second renewal or a finished navigation, showed the session chip and the agent's pointer.
- A tab that a session released shows the current connection state in its toolbar icon and title. It kept the state from the moment of release until it navigated or closed.
- In Chrome, `upload` fails with `file_access_required` while "Allow access to file URLs" is off for the extension, which is the default for a Chrome Web Store installation. Turn it on in `chrome://extensions` to upload local files.
- In Chrome, a frame selection ends as lost when Chrome ends the tab's debugger session, for example after Cancel on the debugging bar or a restart of the extension's background. The next command fails once with `frame_unavailable` and later commands use the main frame; they ran in the main frame without a report.
- In Chrome, the next command on a task tab in a new debugger session applies the session's `emulate` settings again.
- In Chrome, a `network` recording stays with the frame selected at `start`. `detail` and `stop` reach it after another frame is selected.
- In Chrome, `find_tab`, `cdp_attach` and `list_targets` accept a tab whose first page is still loading.
- In Firefox, `cookies` and `download` use the cookie store of the tab, including the store of a container.
- In Firefox, `network` with `cmd: "start"` and `emulate` with `data` return `restricted_tab` without access to all websites, as `cookies` and `screenshot` do.
- In Firefox, a failed `download` keeps its own error when Firefox refuses to cancel the download.

[PR #29](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/29)

#### Publish a release when GitHub lists its new draft late

The release job waits up to 30 seconds for the release list to show the draft that it just created, before it uploads the assets. The 0.2.0 job had stopped when the list left out the new draft, and published the release on a rerun.

[PR #21](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/21)

### Downloads

Choose the native archive for macOS or Linux and your CPU. All release archives use `.tar.zst` with zstd level 3. Install zstd and verify `SHA256SUMS`, then extract with `zstd -dc archive.tar.zst | tar -xf - -C destination`. Load the extracted Chrome MV3 directory in Chrome. The agent kit includes the SDK and guide.

The release workflow submits `omw-0.2.1-chrome-mv3.zip` to the Chrome Web Store and the unsigned add-on to addons.mozilla.org; each store publishes the version after its review.

Firefox release builds install `omw-0.2.1-firefox-mv3-unsigned.xpi` permanently only after it is signed. For development, load the extracted Firefox MV3 directory as a temporary add-on in `about:debugging`. See [Firefox installation](https://github.com/oh-my-webbridge/oh-my-webbridge/blob/v0.2.1/docs/firefox.md#installation).

Browser benchmarks report interface costs on a deterministic fixture; they do not establish real-site reliability. Platform acceptance and remaining differences are recorded in the repository.

## [0.2.0](https://github.com/oh-my-webbridge/oh-my-webbridge/releases/tag/v0.2.0)

### New capabilities

#### Pair a browser with a code and show agent activity

omw is in developer preview and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

oh-my-webbridge is open source under the Apache License 2.0. Documentation is at [oh-my-webbridge.github.io](https://oh-my-webbridge.github.io) in English, Traditional Chinese (Taiwan, Hong Kong, Macau) and Simplified Chinese.

- Installing the extension opens a setup page. It waits for the daemon, then pairs the browser with the pairing code from `omw pair`. The daemon token can also be pasted under Settings, then Advanced, then Daemon token.
- The toolbar icon shows the connection state; its pointer turns amber on a tab an agent controls. While a session controls a tab, the page shows the session name, a soft edge glow during actions, a focus frame on the element being acted on and the agent's pointer with a tag that names the session. The pointer and its tag stay readable on light and dark pages. The favicon becomes the amber-pointer icon until the session releases the tab. In Settings, turn off "Show agent activity" under Pages.
- The popup shows the current tab's state and example prompts. The setup and settings pages share a side rail with navigation and a language menu.
- The extension interface is in English, Traditional Chinese (Taiwan, Hong Kong, Macau) and Simplified Chinese. It follows the browser language until another language is chosen in the language menu.
- The agent kit holds the SDK and the agent skill; the skill links to the online action reference.

#### Suggest prompts for the active tab in the popup

The popup holds one prompt that you can edit and copy, in place of four example tabs. It shows suggestions for the active tab in turn, a new one every six seconds: up to five that fit the page come first, then the ones for any page, out of 22. The popup picks them from the address and title of the tab and, on pages that the extension can access, from the page language, structured data, selected text and the number of tables, form fields, code blocks, videos, images and articles. These values stay in the popup. Each new suggestion fades in while two small stars flare at the corners of the prompt. The pointer or the focus on the prompt holds the current suggestion, and an edit keeps your text.

The Chrome extension asks for the `activeTab` and `scripting` permissions to read the page when you open the popup; the Firefox extension asks for `activeTab`.

[PR #18](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/18)

### Improvements and fixes

#### Find the user guide in every language from `llms.txt`

The `llms.txt` and `llms-full.txt` of each language are at `/md/<language code>/`, next to the Markdown copies of its pages; `/<language code>/llms.txt` and `/<language code>/llms-full.txt` are gone. `/llms.txt` lists the English pages. Every `llms.txt` starts with the site description and a `<tips>` block in English that links the index of each language and explains that a page keeps its path in every language. The agent skill links `/md/en/llms-full.txt`.

The Chinese pages call the site 使用手冊 (使用手册 in Simplified Chinese).

[PR #16](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/16)

#### Point agents at the Markdown copies of the documentation

`llms.txt` lists each documentation page by its Markdown copy at `/md/<language>/<page>/content.md`. Links between pages inside the Markdown copies and `llms-full.txt` lead to Markdown copies too, so an agent that follows them reads Markdown. The prompts that a page sends to an AI chat name its Markdown copy, and each page links it with `rel="alternate" type="text/markdown"` and links the `llms.txt` of its language with `rel="describedby"`.

[PR #14](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/14)

#### Name the agent skill in the example prompts

The example prompts in the popup and on the setup page start with `Use Skills: oh-my-webbridge` in English and `使用 Skills: oh-my-webbridge` in Chinese, which names the skill that the agent loads for the task.

#### Shorter IDs in replies and snapshots

The daemon and the extension issue 64-bit [Snowflake IDs](https://en.wikipedia.org/wiki/Snowflake_ID) in lowercase base 36, such as `uvwoyqsusjk`, in place of 32 hexadecimal characters: the `id` of each `/command` reply, the generation in snapshot references (`@e<generation>.<index>`), the names of screenshots and PDFs saved without a `path`, and the stream handle of `save_as_pdf`. Across the seven tokenizers in `benchmarks/ids`, a snapshot reference costs 8.1 tokens per line instead of 22.5. Clients that check IDs against 32 hexadecimal characters need to accept the new form.

[PR #17](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/17)

### Downloads

Choose the native archive for macOS or Linux and your CPU. All release archives use `.tar.zst` with zstd level 3. Install zstd and verify `SHA256SUMS`, then extract with `zstd -dc archive.tar.zst | tar -xf - -C destination`. Load the extracted Chrome MV3 directory in Chrome. The agent kit includes the SDK and guide.

Firefox release builds install `omw-0.2.0-firefox-mv3-unsigned.xpi` permanently only after it is signed. For development, load the extracted Firefox MV3 directory as a temporary add-on in `about:debugging`. See [Firefox installation](https://github.com/oh-my-webbridge/oh-my-webbridge/blob/v0.2.0/docs/firefox.md#installation).

Browser benchmarks report interface costs on a deterministic fixture; they do not establish real-site reliability. Platform acceptance and remaining differences are recorded in the repository.
