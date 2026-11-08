# Changelog

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
