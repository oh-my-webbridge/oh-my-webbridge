---
"oh-my-webbridge": minor
---

# Pair a browser with a code and show agent activity

omw is in developer preview and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

oh-my-webbridge is open source under the Apache License 2.0. Documentation is at [oh-my-webbridge.github.io](https://oh-my-webbridge.github.io) in English, Traditional Chinese (Taiwan, Hong Kong, Macau) and Simplified Chinese.

- Installing the extension opens a setup page. It waits for the daemon, then pairs the browser with the pairing code from `omw pair`. The daemon token can also be pasted under Settings, then Advanced, then Daemon token.
- The toolbar icon shows the connection state; its pointer turns amber on a tab an agent controls. While a session controls a tab, the page shows the session name, a soft edge glow during actions, a focus frame on the element being acted on and the agent's pointer with a tag that names the session. The pointer and its tag stay readable on light and dark pages. The favicon becomes the amber-pointer icon until the session releases the tab. In Settings, turn off "Show agent activity" under Pages.
- The popup shows the current tab's state and example prompts. The setup and settings pages share a side rail with navigation and a language menu.
- The extension interface is in English, Traditional Chinese (Taiwan, Hong Kong, Macau) and Simplified Chinese. It follows the browser language until another language is chosen in the language menu.
- The agent kit holds the SDK and the agent skill; the skill links to the online action reference.
