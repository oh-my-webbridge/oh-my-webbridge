---
"oh-my-webbridge": patch
---

# Report browser state after captures, released tabs and new debugger sessions

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
