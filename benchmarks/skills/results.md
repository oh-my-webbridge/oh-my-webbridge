# Installed omw skill evaluation

For recovery costs on superseded records, provisional values and missing receipts, see the [Chrome fault-injection study](recovery-results.md).

## Chrome invoice lookup

The task-first guide used the fewest omw calls. An invoice took 27.96 s on average, compared with 34.67 s for the reference revision and 26.22 s for the original guide. Against the original it used 3.9% more total tokens and 38.6% fewer uncached input tokens. Each figure below is a mean per invoice over six runs, except the median column. Token means are rounded.

| Guide              | Mean time | Median time | Total tokens | Cached input | Uncached input | Output | Model tool calls | Shell commands | omw CLI calls | Browser requests | Actions requested |
| ------------------ | --------: | ----------: | -----------: | -----------: | -------------: | -----: | ---------------: | -------------: | ------------: | ---------------: | ----------------: |
| Original           |   26.22 s |     22.99 s |      247,837 |      229,504 |         17,819 |    514 |             5.50 |           5.50 |          4.67 |             4.33 |              4.33 |
| Reference revision |   34.67 s |     29.07 s |      323,976 |      309,824 |         13,484 |    668 |             7.50 |           7.67 |          5.67 |             4.67 |              4.67 |
| Task-first         |   27.96 s |     25.48 s |      257,398 |      245,867 |         10,948 |    584 |             6.00 |           5.83 |          3.17 |             3.17 |              5.50 |

| Model     | Original times (s) | Reference revision (s) | Task-first (s) | Original → task-first mean tokens | Original → task-first tool calls, both runs |
| --------- | -----------------: | ---------------------: | -------------: | --------------------------------: | ------------------------------------------: |
| 6.2 Sol   |       20.84, 19.77 |           22.28, 29.46 |   23.11, 27.85 |                 214,820 → 295,318 |                                      9 → 13 |
| 6.1 Terra |       22.15, 23.83 |           25.94, 28.68 |   21.30, 20.26 |                 256,655 → 185,687 |                                      11 → 8 |
| 6 Luna    |       31.40, 39.31 |           54.69, 46.99 |   30.35, 44.88 |                 272,036 → 291,190 |                                     13 → 15 |

All six task-first workers requested navigation and the first snapshot in one batch. All six also batched the subsequent click with an immediate read, then made another observation. In one Sol run the detail page's body had not yet loaded when the batch returned. Across six runs, browser requests fell from 26 to 19 versus the original, while requested actions rose from 26 to 33. Failed requests and the steps requested inside a failed batch are included. Summed time inside the native CLI was 2.39 s for the original, 3.01 s for the reference revision and 2.32 s for task-first across all six invoices per guide. Most end-to-end time fell outside the native CLI.

On 2026-11-19, fresh medium-effort workers used the installed skill and the real omw 0.2.2 CLI with an already paired Chrome 157.0.8103.79. Each had to open the April invoice for North Quay Press, distinguish it from the same vendor's March invoice and another vendor's April invoice, and return its reference and outstanding balance. The local fixture generated different values for every session. The worker had to leave its task tab open. Verification compared the returned values against the fixture's record of the requested detail page.

Workers ran one at a time in separate sessions on the same machine. Each guide had two runs per model. The baseline and reference revision alternated order within each model across repetitions. The task-first revision was introduced after observing the first ten runs. Provider caches were shared across turns. The per-turn measurements include cache hits, retries, diagnostics, reference reads and the model's final answer. Human setup and verifier calls fall outside the timed worker turn.

A model tool call is one top-level tool invocation. A tool call can launch several shell commands, and a shell command can invoke omw several times. An omw CLI invocation can be a diagnostic or a browser request. A browser request can contain several actions in a batch. The [per-run data](costs.json) include all these counts, the action sequences, the summed native CLI execution time, and the separate cached input, uncached input and output token counters. Total tokens are input plus output across all model responses in the turn. Cached input is a subset of input. Reasoning tokens are a subset of output.

## Written eight-case exercise

The eight scenarios shared one prompt per model. Across the three answer sheets, summed worker time fell from 170.219 s to 124.639 s with the reference revision. Total tokens fell from 815,263 to 642,003, model tool calls from 14 to 11, and shell executions from 33 to 19. Baseline input comprised 638,720 cached and 171,108 uncached tokens, with 5,435 output tokens. The reference revision used 576,384 cached input, 60,836 uncached input and 4,783 output tokens. The rollout records support timing the whole sheet only. The comparison uses the entrypoint before the task-first change.

Each run received a skill installed by the corresponding Go binary, the eight [tasks](tasks.md), and no parent conversation. Each model ran at medium effort with access to the installed references. The agents described their next commands and observations without contacting a browser. Each answer could earn two points per task under the [decision rubric](grading.md). A final reviewer scored the twelve anonymized answer sheets together to apply the same standard across revisions.

| Installed guide                                   | 6.2 Sol | 6.1 Terra | 6 Luna | Total |
| ------------------------------------------------- | ------: | --------: | -----: | ----: |
| Baseline at `46f8012`                             |      16 |        16 |     15 | 47/48 |
| Shorter entrypoint with seven reference links     |      16 |        15 |     13 | 44/48 |
| Exact-URL borrowing example and session reference |      15 |        15 |     15 | 45/48 |
| Explicit batch execution and site confirmation    |      16 |        16 |     15 | 47/48 |

In the first revision, one answer used ordinary `find_tab` to borrow a designated background page. That call searches tabs the session already holds. The second revision gave the exact `borrow_tab` call and the tab-ID fallback. All three answers on that revision selected the background tab correctly.

On the second revision, all three answers checked order evidence but left the execution of earlier batch steps implicit or uncertain. The reference revision distinguishes a completed click from a confirmed order. All three answers then identified the completed steps and checked the order outcome. Luna's remaining missed point was the omission of file inspection after capturing a Firefox screenshot. The baseline Luna answer also omitted that check.

## Selection and additional cases

| Exercise                                             | Points per model | 6.2 Sol | 6.1 Terra | 6 Luna |
| ---------------------------------------------------- | ---------------: | ------: | --------: | -----: |
| [Description-only selection](discovery.md), baseline |                6 |       6 |         6 |      6 |
| Description-only selection, revised description      |                6 |       6 |         6 |      6 |
| [Transfer to other browser tasks](transfer.md)       |                8 |       7 |         8 |      8 |
| [Release-specific recovery](recovery.md)             |                8 |       8 |         7 |      5 |

Selection used the name and description alone, with three requests for the user's browser profile and three requests for other work. Transfer and recovery used new contexts. The recovery set was first used on the reference revision.

- **Transfer.** Sol selected the right checkbox action but omitted the required quotes around a role selector's accessible name.
- **Recovery.** Terra offered a new tab as an alternative when the task needed the original archive tab. Luna left the component to update ambiguous, omitted the first scoped read's `frame_unavailable`, and offered reload without establishing that it would be safe for the form page.
- **Installed reference cross-check.** After clarifying SDK argument errors and Firefox cookie stores in the references, all three models answered the [two cross-check cases](integration.md) on a fresh installation. They recognized that an earlier export click survives a later runtime argument error and that the session name cannot identify a tab's cookie store.

The written exercises contain one answer per tested combination of model, exercise and revision. Scores measure written decisions and command syntax.

## Reproduce

Build the revision under evaluation, install its skill into an empty directory, then check the packaged Markdown links.

```sh
mkdir -p .scratch/omw-skill-eval
go build -o .scratch/omw-skill-eval/omw ./cmd/omw
.scratch/omw-skill-eval/omw install-skill .scratch/omw-skill-eval/installed
node benchmarks/skills/check-links.mjs .scratch/omw-skill-eval/installed/oh-my-webbridge
```

For the live exercise, start the fixture from a directory with a new visit log. It prints its loopback port. Copy the installed skill into a fresh run directory and install the metered executable there with the real omw CLI on PATH. For example, from the repository root:

```sh
mkdir -p .scratch/omw-skill-eval/run-a
cp -R .scratch/omw-skill-eval/installed/oh-my-webbridge .scratch/omw-skill-eval/run-a/skill
install -m 755 benchmarks/skills/meter-omw.mjs .scratch/omw-skill-eval/run-a/omw
node benchmarks/skills/invoice-fixture.mjs .scratch/omw-skill-eval/visits.jsonl
```

Use the same prompt for every guide, substituting the directory, session name and printed port:

> Complete this real browser task. Read your installed skill at RUN/skill/SKILL.md. In Chrome open http://127.0.0.1:PORT/SESSION/ and open North Quay Press's April invoice. Give its reference and outstanding USD balance. Use the actual omw CLI via RUN/omw, session SESSION, for all browser operations. Only read this skill and its references, interact only with this task's new tab, leave it open for verification. No alternative HTTP client or fixture source. Return only the two values in your final answer.

Use the basename of RUN for SESSION. After the worker finishes, compare its answer with the reference and balance logged for that session at index 2, inspect the owned tab and close the benchmark session. Extract the counters with `node benchmarks/skills/turn-cost.mjs ROLLOUT.jsonl`. Read the command count and action sequence from RUN/commands.jsonl. Keep verifier calls outside that file. Stop the fixture after the last run.

For the written exercises, supply only the name, description and selection questions for discovery. For each other exercise, give a fresh worker the scenario file and installed directory. Save the answer, use a separate grading context, and keep the model and revision labels hidden during scoring. Model IDs and effort are recorded on every row.

| Installed entrypoint  | Bytes | SHA-256                                                            |
| --------------------- | ----: | ------------------------------------------------------------------ |
| Baseline at `46f8012` | 9,440 | `d8831b9ed42dd98375734b50db0dde8306d286b403f76b9e321121526462e8c5` |
| Reference revision    | 6,105 | `718570d38e12682794988926270fedb38e00ce22d8a776fec4855a79468d05e4` |
| Task-first revision   | 6,366 | `a161baf8830b9ce8dea8bc8378e101f3658e31fe1d8b07b76547c96129dfa99c` |
