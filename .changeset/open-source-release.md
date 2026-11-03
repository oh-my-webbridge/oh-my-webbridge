---
"oh-my-webbridge": minor
---

# Pair a browser with a code and show agent activity

oh-my-webbridge is open source under the Apache License 2.0. Documentation is at [oh-my-webbridge.github.io](https://oh-my-webbridge.github.io).

- Installing the extension opens a setup page. It waits for the daemon, then pairs the browser with the pairing code from `omw pair`. The daemon token can also be pasted under Settings, then Advanced.
- The toolbar icon shows the connection state and adds an orange dot on a tab an agent controls. While a session controls a tab, the page shows the session name, a soft edge glow during actions and a focus frame on the element being acted on. The favicon becomes the orange-dot icon until the session releases the tab. In Settings, turn off "Show agent activity" under Pages.
- The popup shows the current tab's state and example prompts, and the extension pages follow the browser language in English or Simplified Chinese.
- The agent kit holds the SDK and the agent skill; the skill links to the online action reference.
