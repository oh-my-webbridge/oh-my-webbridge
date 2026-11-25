# Scoring an installed skill

For execution benchmarks, measure each task in its own worker turn. Record the elapsed time, input (cached and uncached), output, model tool calls, shell commands and browser operations. Verify the requested outcome independently and retain the costs of unsuccessful attempts. The decision rubric below applies to the separate written exercises.

Install each revision with its own binary into an empty directory. Give a fresh medium-effort agent the scenario file and that installed skill directory only. Keep the grading key and previous answers out of its context. Use the same prompt, cases, models and reference access across revisions. Reserve the transfer and recovery cases for validation. Record which references an agent consulted.

Each row has two independent, observable decisions. Award one point for each decision present in the answer with valid action names and arguments. A contradictory instruction cancels the affected point. Accept equivalent commands and decisions. Mark an unavailable run as missing. Report individual scores and missed decisions. A single run per model measures this sample of answers only.

For the separate discovery exercise, supply only the frontmatter name and description and `discovery.md` in a new context. Award one point for each "use" on cases 1–3 and "skip" on cases 4–6. This tests a model's explicit selection decision with one skill available.

The recovery set tests the release references on the last revision. Each case awards two points:

1. Permit compatible release skew. Identify the older daemon as needing an update for the incompatible newer protocol.
2. Distinguish a local abort from `command_not_sent`. Inspect read-only evidence or report the submission as unconfirmed without replay.
3. Predict the one-time `frame_unavailable` on a scoped read. Reselect the child document before reading it.
4. Recognize that Firefox applies its script policy to subsequent document responses. Navigate the owned tab to the same safe URL and check the policy or handler without repeating the form submission.

| Task | First point                                                                                     | Second point                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1    | Target Firefox and borrow the designated exact URL in the background.                           | Resolve ambiguity with the user's tab ID before reading that tab.                                     |
| 2    | Treat the first two steps as executed and inspect read-only evidence.                           | Leave the order unconfirmed if evidence is inconclusive, without resubmission.                        |
| 3    | A fresh call is possible after a pre-write failure if still needed.                             | Observe before deciding after an uncertain click and avoid automatic replay.                          |
| 4    | Paginate in the selected frame with returned offsets to completion.                             | Reselect the replacement frame, discard old handles and restart reading at zero.                      |
| 5    | Stay in Firefox and inspect the returned screenshot file.                                       | Report the PDF operation as unsupported in that profile.                                              |
| 6    | Keep 7 and 9, close only 8 via selective release.                                               | Inspect failures, resolve affected IDs and leave 10 held.                                             |
| 7    | Inspect preset status, including counts or fallback reasons.                                    | Compare after disabling filtering and navigating the owned tab again, leaving the borrowed tab alone. |
| 8    | Use Playwright's browser-level native proxy through its version discovery or browser WebSocket. | Supply bearer authorization privately without exposing the token in URLs or output.                   |

| Transfer | First point                                                                               | Second point                                                                             |
| -------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1        | Target Firefox with active `find_tab` and the matching hostname.                          | Read the borrowed page and end the session, leaving that tab open.                       |
| 2        | Use the newer snapshot's handle and send literal data as JSON via stdin or an SDK object. | Verify the resulting field value.                                                        |
| 3        | Use `get` (or page reading) for the heading.                                              | Use `is` with `checked` or equivalent observation in Firefox without permission changes. |
| 4        | Recognize the shared cookie store for sessions using the same site and store.             | Preserve the other task's login and leave the shared cookies intact.                     |
