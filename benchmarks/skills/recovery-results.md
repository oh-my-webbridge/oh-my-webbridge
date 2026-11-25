# Browser task recovery costs

On 2026-11-19 we ran the installed guides on Chrome 157.0.8103.79 through omw 0.2.2, protocol 1. In the four paired cases the original task-first guide already recovered the requested result. The first recovery revision made the required evidence explicit. Its model tool-call count fell in the offline-history case, stayed level for archived records and retrievable receipts, and increased for the loading case.

Each cell shows the task-first guide followed by the first recovery revision. “Recovery” starts when the first tool result shows the fault and ends when a tool result supplies the answer evidence or states that history is offline.

| Case and model            | End-to-end seconds |      Total tokens | Model tool calls | omw calls | Recovery seconds |   Recovery tokens |
| ------------------------- | -----------------: | ----------------: | ---------------: | --------: | ---------------: | ----------------: |
| Superseded record, Sol    |      33.89 → 41.58 | 296,717 → 297,889 |            6 → 6 |     5 → 5 |    12.35 → 21.84 | 173,381 → 174,217 |
| Loading record, Luna      |      33.51 → 66.77 | 206,950 → 334,710 |            5 → 8 |     2 → 3 |     6.94 → 19.67 |  36,066 → 120,133 |
| Receipt in history, Terra |      26.32 → 28.37 | 283,969 → 314,159 |            6 → 6 |     5 → 5 |      5.50 → 6.29 |   83,415 → 93,513 |
| Offline history, Sol      |      36.75 → 30.53 | 386,485 → 343,103 |            8 → 7 |     5 → 5 |      6.72 → 6.98 |   88,875 → 87,868 |

The server recorded one POST in each of the four submission trials. Both workers with an available history returned the recorded receipt. Both workers with offline history reported an unconfirmed outcome. For the archived invoice, both guides led to five omw calls, including a fresh observation after each click-and-read batch. Those runs did not demonstrate a saving from the navigation advice.

There is one fresh turn per case and guide in the paired table, with both guide orders represented. The model differs between some cases. Two workers (err-e and err-f) also consulted local workspace memory despite the requested reading scope. Their time and tokens remain in the results. Reference and receipt values were generated after the sessions were assigned. Total token counts include cached inputs across model responses and do not establish billing cost.

### Loading-view follow-up

The first recovery run on Luna read two references and searched again for the arguments to `wait`. We added an example that waits for the observed loading text to disappear and then reads the page in the same batch. Two fresh Luna workers repeated the loading case in reverse guide order relative to the change (example first, prose second).

| Guide                 | End-to-end seconds | Total tokens | Model tool calls | omw calls | Recovery seconds | Recovery tokens | Tool calls during recovery |
| --------------------- | -----------------: | -----------: | ---------------: | --------: | ---------------: | --------------: | -------------------------: |
| Prose only, follow-up |              52.26 |      272,771 |                7 |         2 |            23.98 |         173,430 |                          5 |
| With command example  |              45.84 |      217,232 |                5 |         2 |             7.23 |          38,762 |                          1 |

Both workers used two omw calls, with the second batching `wait` and `read_page`. The model reached that call with less work in the example run. The original task-first guide's 33.51 s loading run was still the fastest end to end. Turn startup, reference access, shared token caches and model variability all contribute to the observed totals.

### Batch failure after a write

Two real CLI errors tested the distinction between preflight and runtime failure. With a malformed second step, the connected extension returned `invalid_args` with `batch step 2 of 2 (undefined): unsupported action: undefined`. A synchronous title change in step 1 persisted. With a valid second step that waited for text the site never displays, the error was `wait_timeout` at step 2 and the fixture recorded one POST. The probe found the resulting receipt in request history. The service reported daemon and CLI 0.2.2, protocol 1 and the Chrome version. It did not report the extension release. The 0.2.2 extension source has the observed runtime behavior. The repository's current extension has separate preflight checks and unit coverage.

For the transfer case, we seeded a separate session with a real submission followed by the malformed step. A fresh Terra worker received the actual error and the final installed guide. It found the matching receipt in **24.44 s, 201,324 tokens, four model tool calls and three omw calls**. The fixture counted one POST across setup and recovery. This trial times recovery from handoff and has no paired baseline.

During probe development, one run reused a page across malformed and timeout cases and got `element_missing` on the second batch. A second probe attempt ended with a cleanup error. Both were excluded from agent timing. The completed probe uses a synchronous title marker for the malformed batch, verifies the receipt against the server log for the timeout and closes its owned tab.

| Installed guide                       | Sessions                   | SKILL.md SHA-256                                                   |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| Task-first                            | err-a through err-d        | `a161baf8830b9ce8dea8bc8378e101f3658e31fe1d8b07b76547c96129dfa99c` |
| First recovery revision               | err-e through err-h, err-j | `661a4cf75293d650e8271fea85132ff78bb33cb5f19f630dbc1334c94bc7f409` |
| Loading example                       | err-i                      | `ffd25b869f363ff24e27a45b14d7ce0b2cd8187f88f7091c92230d61068dd3a0` |
| Loading example and batch diagnostics | err-replay                 | `14305a8df402d27a7da2f3aaaecd272e7141268acabd6418e7abaa48d2ec7c1d` |

## Cases and evidence

| Case                    | What the site shows                                                                                                                     | Evidence for completion                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Superseded record       | An April invoice with a plausible balance and an archived revision label. The register has same-label detail links for March and April. | The answer contains the current April record's independently generated reference and amount.  |
| Loading record          | A preliminary balance and reference appear immediately. The posted record replaces the document after 4.5 s.                            | Both returned values match the posted record.                                                 |
| Missing acknowledgement | The site records each form submission, then displays an error and a working retry button. The history page contains the receipt.        | Exactly one POST and the matching receipt in the answer.                                      |
| History unavailable     | The same submission and retry button, with an offline history page.                                                                     | Exactly one POST, a history check, and a final answer stating that acceptance is unconfirmed. |

The two invoice prompts request the current posted April reference and balance. The two submission prompts authorize one statement copy and request a receipt if verifiable. Each pair uses the same model and prompt, a fresh medium-effort context, a new owned tab and session, and different generated values. The site records the POST before returning the acknowledgement error. A second POST would create a second request. In the offline-history case, only the verifier can see the server's write count.

## Measurement

The [per-run records](recovery-costs.json) include end-to-end turn duration, cached and uncached input, output, model tool calls, shell commands, metered CLI calls, action sequences and server events. Each checkpoint contains cumulative time, total tokens, top-level tool calls and completed CLI calls. The first checkpoint is the first tool result containing the displayed fault text. The second is the first tool result containing the correct values, receipt or offline-history message. The final checkpoint is the worker's answer. Subtract adjacent checkpoints for the cost between observations. These boundaries measure what was returned to the model. A worker's internal recognition time is unobservable. An unseen marker remains null.

## Reproduce

Start the [local fixture](recovery-fixture.mjs) with a new event log and fresh session names. The assignments accept `archive`, `loading`, `receipt` and `unknown`. The process prints its loopback port.

```sh
mkdir -p .scratch/recovery-study
node benchmarks/skills/recovery-fixture.mjs .scratch/recovery-study/events.jsonl case-a=archive case-b=receipt case-c=loading case-d=unknown case-probe=receipt
```

Install each guide and the metered CLI in its own run directory as in the [invoice study](results.md#reproduce). Give each worker its assigned directory, session, fixture URL and one task:

- Invoice: “Report North Quay Press's current posted April invoice reference and outstanding USD balance.”
- Statement copy: “Request one April statement copy. Tell me the receipt if you can verify it, or report its status.”

Restrict browser access to the metered CLI and the assigned task tab. Keep the event log and fixture source outside the worker's inputs. After each answer, verify its values or uncertainty against the site log and check the owned tab before closing the session. Supply the log and each directory/rollout pair to the collector:

```sh
node benchmarks/skills/recovery-cost.mjs .scratch/recovery-study/events.jsonl .scratch/recovery-study/case-a /path/to/completed-turn.jsonl
```

For two deliberate bridge errors, run the [batch probe](check-recovery-batch.mjs) with the printed port, a fresh receipt session and the fixture log. It checks whether a synchronous title change survived the malformed batch and whether the timeout left exactly one submission with a verifiable receipt. The probe closes its owned session. Stop the fixture when the study ends.
