---
name: oh-my-webbridge
description: Use the local omw bridge to operate the user's Chrome or Firefox profile. Use it for signed-in pages, a designated open tab, forms, captures, downloads or parallel browser tasks that need that profile.
---

# oh-my-webbridge

Use `omw` from PATH or `dist/omw` in a checkout. Use the bundled references or `omw help` when you need syntax beyond the examples below.

## Choose the browser and tab

Start with the task's first browser call. If the bridge is unavailable, run `omw status`. For an absent daemon, run `omw start` once and recheck. For an unpaired extension, run `omw pair` and have the user enter the six-digit code in extension setup. Keep the token from `omw connection` private. Use `omw doctor` for compatibility errors. Matching wire protocols allow different releases to connect. On a mismatch, update the indicated component, restart the daemon if its binary changed, and use the matching skill. See the [CLI reference](references/reference/cli.mdx).

Give each independent task a session. Reuse it across sites. To use a named browser, place `--browser firefox` or `--browser chrome` before the session name. The first dispatched command binds the session until `close_session`. Without a binding or explicit choice, omw uses the only connected browser, or Chrome when both are connected. A separate session isolates tab ownership and command ordering. Cookies and site storage still belong to the browser profile and its cookie store.

- For a new task page, `navigate {"url":"https://example.com"}` opens a background tab. Later navigations reuse the current tab. Add `"newTab":true` to open another.
- For a designated existing page, `borrow_tab {"url":"https://example.com/orders"}` with the user's exact URL preserves focus. On `ambiguous_tab`, repeat `borrow_tab` with only the user's designated `tabId`.
- For the active page in the last focused window, use `find_tab {"url":"example.com","active":true}` with a matching hostname or exact URL.

`list_tabs` and ordinary `find_tab` only see tabs the session already holds. `tab_busy` means another session holds the tab. On `session_browser`, use a fresh session for the requested browser. See [sessions and tab lifecycle](references/sessions.mdx).

## Read and interact

Choose the first observation by what you need next. Use `snapshot` to choose a link or control, or `read_page` to extract text. When opening a known URL, send the navigation and that observation in one call:

```sh
omw call --browser firefox research batch '{"steps":[{"action":"navigate","args":{"url":"https://example.com"}},{"action":"snapshot"}]}'
```

Use the returned text or handles directly. For paginated text, follow `nextOffset` as `offset` until `complete`. For a control, use a current `@e` reference or semantic selector such as `label=Email`. A click can return while the old document is still visible. When the destination URL or a marker unique to the new state is known, batch the click, a `wait` for that URL, text or selector, and the observation you need. Otherwise inspect the resulting page before choosing the next action. Pass multiline or shell-sensitive input as a JSON object via stdin, e.g. `omw call research fill - < request.json`.

For an iframe, select it with `frame` and take a new snapshot. If the selected document changes, reselect the intended frame, discard old references and restart reading at offset zero. Use `frame {"cmd":"main"}` to return. The [action reference](references/reference/actions.mdx) covers frame selection, selector syntax, waiting, input, uploads, network recording and error codes.

## Recover from a failed action

Match the visible record, period and revision to the request. Follow the current-record link for a superseded version. If a loading view shows preliminary values, wait for its visible loading marker to disappear and read the final record in one call:

```sh
omw call research batch '{"steps":[{"action":"wait","args":{"text":"Loading","state":"hidden"}},{"action":"read_page"}]}'
```

Use the marker text observed on that page and confirm the returned record is final.

After a submission, a missing acknowledgement or a site's retry button leaves the write uncertain. Consult a read-only receipt or activity history for that specific request. If that evidence is unavailable, report what you submitted and what you could verify, then stop.

- `command_not_sent`: the transport write never started. Issue a fresh call if the action is still needed.
- `outcome_unknown`: the action may have reached the page. Check the URL, receipt, field value or other read-only evidence. If still uncertain, report the result as unconfirmed and stop before repeating the change.
- Failed `batch`: read the message as well as the code. A runtime message starting `batch step N of M (action):` means steps 1 through N−1 completed, even for `invalid_args`. Current extensions reject a malformed step during preflight, while older ones can reach it after earlier actions. If the failure stage is unclear, inspect the page or receipt before resuming only the outstanding work.
- `wait_timeout`: check the condition or repeat the read-only wait with `--timeout-ms` before the session name.
- `stale_ref` or `frame_unavailable`: take a new snapshot. For a command meant for a lost frame, reselect it first.
- `no_tab` or `tab_missing`: for a closed task page, use another held tab or open a new page. For a failed lookup, confirm the intended tab. On `busy`, reduce concurrency.

## Browser-specific work

- **Firefox.** Use [Firefox permissions and action support](references/firefox.mdx) for `unsupported` or `restricted_tab`. Page reading, `get` and `is` work without enabling user scripts. Verify clicks on the page. Keep the user's chosen browser and login. Report an unavailable operation when it requires a different profile.
- **Files.** Use task-authorized absolute upload paths on the host. For a screenshot in either browser or a PDF in Chrome, run the capture as a separate call. Omit `path` or supply a new absolute path. Open the returned file and verify the page before handing it over. Downloads return a path on the browser host.
- **Missing page content.** On an owned tab, inspect `preset {"cmd":"status"}` for counts and fallback reasons. To test the filter, set `preset {"preset":"none"}`, navigate again and check the same content. Presets apply across the session's owned tabs. Borrowed tabs are excluded. See [presets](references/presets.mdx) for archive settings and resource switches.
- **Scripted workflows.** Use `connect(session, { browser })` from the kit's `sdk.mjs` (checkout: `dist/sdk.mjs`). See the [SDK](references/reference/sdk.mdx) for calls, deadlines and cancellation. For Playwright's browser-level connection, use the explicitly configured [native CDP proxy](references/reference/cdp.mdx#native-mode). The extension's CDP interface addresses Chrome page targets.

## Hand back the pages

Keep task tabs open for review unless cleanup was requested. To hand off selected pages, use `release_tabs` with actual IDs in `keep` and `close`. Borrowed pages can be kept and released. Only owned pages can be closed. Check `failed` and reconcile those IDs. Unlisted pages stay in the session. Use `close_session` when the remaining owned tabs may all close. It releases borrowed tabs and leaves the shared daemon running.
