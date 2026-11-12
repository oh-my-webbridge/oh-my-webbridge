---
"oh-my-webbridge": patch
---

# Report a wait that runs out of time, and set the deadline in omw call

- `wait` fails with `wait_timeout` (HTTP 408) when its condition has not held 500 ms before the request deadline. The page is unchanged, so the wait can be sent again with a longer deadline. A deadline reached during a poll had returned `browser_error` or `outcome_unknown` depending on timing.
- A command that the deadline or a cancellation stops while it waits between polls, for a frame selection or for a download returns `outcome_unknown` in Chrome. It had returned `browser_error` with the message `request cancelled` or `cancelled`.
- `omw call --timeout-ms N` sets the command deadline, 1 to 120000 milliseconds. Without the flag the deadline stays 30 seconds. Put `--` before a session name that starts with `-`.

[PR #32](https://github.com/oh-my-webbridge/oh-my-webbridge/pull/32)
