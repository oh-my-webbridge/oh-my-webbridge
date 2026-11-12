---
name: oh-my-webbridge
description: Operate the user's real Chrome or Firefox through the local oh-my-webbridge daemon. Use for browser tasks that need existing logins, reading pages, forms, screenshots, downloads, or independent parallel task sessions when this bridge is installed.
---

# oh-my-webbridge

omw is in developer preview and iterating rapidly. THERE WILL BE COMPATIBILITY-BREAKING CHANGES.

Use `omw` from `PATH`, or `dist/omw` in the project checkout. Read `omw help` when the installed command differs from these examples.

## Start and observe

Run `omw status`. If the daemon is absent, run `omw start` once and retry. If a browser is not connected, ask the user to open the extension's setup page and pair it. `omw pair` prints a six-digit pairing code, and the user types it there. Never print the daemon token from `omw connection` or include it in output or on a website.

`omw status` reports Chrome and Firefox separately. Commands go to the browser bound to the session. Otherwise they go to the only connected browser, or to Chrome when both are connected. When the user names a browser, put `--browser chrome` or `--browser firefox` right after `omw call` (SDK: `connect(session, {browser})`). A session stays in the browser that first ran it until `close_session`. On `session_browser`, keep that browser or use another session name.

Choose one task session, e.g. `research`, and keep it across sites. Open pages in background task tabs:

```sh
omw call research navigate '{"url":"https://example.com","group_title":"Research"}'
omw call research snapshot
```

Use snapshot `@e...` references for click/fill, CSS selectors, or semantic selectors such as `role=button[name="Submit"]`, `label=Email`, and `testid=search`. CSS, text and attribute locators (`label=`, `placeholder=`, `alt=`, `title=`, `testid=`) traverse open shadow roots. Snapshot again after navigation or `stale_ref`. Read compact content with `read_page`. Use `evaluate` for specific structured extraction. Verify the page state after changes.

```sh
omw call research fill '{"selector":"#search","value":"query"}'
omw call research click '{"selector":"button[type=submit]"}'
omw call research evaluate '{"code":"({title:document.title,url:location.href})"}'
```

For shell-sensitive or multiline data, write valid JSON with a file tool and send it through stdin: `omw call research evaluate - < request.json`. Do not interpolate page text or secrets into shell source.

## Tasks and ownership

Use distinct sessions for independent parallel tasks. Same-session commands execute in order. `list_tabs` lists only the session's tabs. When the user asks to use the active tab, borrow it explicitly with `find_tab {"url":"exact URL or hostname","active":true}`. Do not borrow unrelated tabs or fight another session's ownership.

Keep task tabs for review. Call `close_session` only when the user asks to close the task tabs. It closes only owned tabs and releases borrowed ones. Do not stop or restart the shared daemon to clean up a task.

## Other operations

Use `screenshot` and `save_as_pdf`, then open the returned path to inspect the artifact. Use unique absolute output paths; existing files are never overwritten. Upload paths are absolute on the machine running the daemon and browser; Firefox uploads total at most 16 MiB per command. Use user-provided or clearly task-authorized files.

Use `wait` with selector/text/url/expression/load (`omw call --timeout-ms N` sets its deadline, default 30000), `scroll`, `hover`, `select_option`, `dialog`, `send_keys`, and `drag` for ordinary interactions. `cdp` accepts `{method,params,sessionId}` for advanced cases in Chrome. Use `frame` with selector/name/frameId/url to select a same-origin or cross-origin iframe, and `frame {"cmd":"main"}` to return. Take a new snapshot after changing frame. Commands then run in the selected frame. Other iframes that load or navigate do not change the selection or the references from its snapshot. When the selected frame navigates, reloads or is removed, the next command for it returns `frame_unavailable`, and later commands use the main frame. Select the frame again if the task continues there. In Chrome, a command with a reference from that frame's snapshot returns `stale_ref` instead. In Chrome, `dialog` answers dialogs from the page or any iframe, whichever frame is selected.

Use `get` / `is` to verify element values and states, `check` / `uncheck` for idempotent controls, and `storage`, `cookies`, `console`, `emulate` or `download` for page tasks. Cookies and storage share the current profile, so clear only task-authorized data. Downloads return paths on the browser's host. `batch {"steps":[...]}` runs up to 64 actions in order and stops at the first error without rollback. Run `screenshot`, `save_as_pdf` and `close_session` as separate calls.

For complex work, compose calls with the SDK (`sdk.mjs` at the root of the agent kit, or `dist/sdk.mjs` in a project checkout) and `connect(session)` in one Node script. Do not create a second daemon or browser. Use the explicit native CDP endpoint for Playwright's browser-level connection. Do not assume `chrome.debugger` has every browser domain.

## Failure handling

On `outcome_unknown`, observe the current page before deciding whether to retry: a click or submission may already have happened. Never replay a modifying command automatically after timeout, cancellation or disconnect. On `busy`, reduce concurrency. On `tab_busy`, use the task's own tab. On `stale_ref`, take a new snapshot. On `frame_unavailable`, select the frame again before repeating a command meant for it. On `wait_timeout`, the condition did not hold and the page is unchanged; wait again with a longer deadline or check the page.

`unsupported` means the action or parameter does not exist in that browser, and the message names it and the reason. Do not retry it. Use another action for the same goal (for example `read_page` or `get` instead of `evaluate`), or run the step in a Chrome session (`--browser chrome` with a new session name) when it needs Chrome. In Firefox, these are unsupported: `save_as_pdf`, `dialog`, `drag`, `mouse`, `keyboard` down/up, `console`, `cdp`, `history list`, and `emulate` fields other than `data`. `send_keys` supports only Backspace, Delete, Enter, Tab, Shift+Tab and Control/Meta+A. `evaluate` works only after the user chooses Allow scripts in the extension's setup or settings page. Firefox clicks and key events are untrusted, so a page can ignore them; verify the result. Report remaining failures with their error code and operation.

## Page presets

Owned task tabs default to `anti-ad` with offline-pinned filter lists. Read `preset {cmd:"status"}` when a page appears broken; it reports the configuration, blocked and allowed request counts and fallback reasons. Select `preset {preset:"none"}` and navigate again for compatibility. Never blindly repeat an uncertain click or submission. Borrowed tabs are excluded from presets.

Zen is optional and meant for static or old Web 2 archives: `preset {preset:"zen",zen:{images:true,fonts:true,css:false,javascript:false}}`. A `true` resource switch blocks it. Blocking CSS or JS can break modern sites, so keep those switches off unless the task warrants them. `environment:true` optionally installs supported bundled cosmetics/scriptlets before navigation. It is not fingerprint spoofing.

## Reference

The full action list, arguments, limits and error codes are at https://oh-my-webbridge.github.io/en/reference/actions/ and, as plain text for agents, https://oh-my-webbridge.github.io/md/en/llms-full.txt.
